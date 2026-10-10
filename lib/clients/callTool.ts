/*
 * Tool invocation wrapper: cache, per-run budget, retries, timeout, Step log, trace.
 * No vendor SDKs.
 */
import "server-only"

import { createHash } from "node:crypto"

import type { BudgetedTool, RunTags, ToolBudget } from "@/agents/types"
import { getPrisma } from "@/lib/db/prisma"
import { runTagAttributes, span, type SpanAttributes } from "@/lib/clients/trace"

export type CallToolRun = {
  runId: string
  /** Mutable remaining budgets for this run. */
  budget: ToolBudget
  trace: RunTags
}

export type CallToolName = BudgetedTool | "edgar" | "llm" | "wikidata" | "inFilings" | "pdf"

export const DEFAULT_TOOL_BUDGETS: Record<BudgetedTool, number> = {
  crustdata: 20,
  serp: 10,
  firecrawl: 15,
}

/** Per-tool wall-clock timeouts (ms). */
export const TOOL_TIMEOUT_MS: Record<CallToolName, number> = {
  crustdata: 60_000,
  serp: 45_000,
  firecrawl: 90_000,
  edgar: 30_000,
  llm: 120_000,
  wikidata: 30_000,
  inFilings: 90_000,
  pdf: 60_000,
}

/** Default cache TTL per tool (ms); overridable per call. */
export const TOOL_CACHE_TTL_MS: Partial<Record<CallToolName, number>> = {
  crustdata: 7 * 24 * 60 * 60 * 1000,
}
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Lets a client attach per-call facts to the Step row (e.g. Crustdata's
 * X-Credits-Used) without knowing about Prisma.
 */
export type StepReporter = (metadata: Record<string, unknown>) => void

const RETRY_DELAYS_MS = [1000, 2000, 4000] as const

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}

export function cacheKeyFor(tool: CallToolName, args: unknown): string {
  const digest = createHash("sha256").update(tool).update(":").update(stableStringify(args)).digest("hex")
  return `${tool}:${digest}`
}

function isBudgetedTool(tool: CallToolName): tool is BudgetedTool {
  return tool === "crustdata" || tool === "serp" || tool === "firecrawl"
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new DOMException("Aborted", "AbortError"))
      },
      { once: true }
    )
  })
}

async function readCache(key: string): Promise<unknown | undefined> {
  const row = await getPrisma().cacheEntry.findUnique({ where: { key } })
  if (!row) return undefined
  if (row.expiresAt.getTime() <= Date.now()) {
    await getPrisma().cacheEntry.delete({ where: { key } }).catch(() => undefined)
    return undefined
  }
  return row.value as unknown
}

async function writeCache(key: string, value: unknown, ttlMs: number): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs)
  await getPrisma().cacheEntry.upsert({
    where: { key },
    create: { key, value: value as object, expiresAt },
    update: { value: value as object, expiresAt },
  })
}

async function writeStep(input: {
  runId: string
  tool: string
  cacheKey: string
  status: string
  durationMs: number
  metadata?: Record<string, unknown>
}): Promise<void> {
  await getPrisma().step.create({
    data: {
      runId: input.runId,
      tool: input.tool,
      cacheKey: input.cacheKey,
      status: input.status,
      durationMs: input.durationMs,
      metadata: input.metadata as object | undefined,
    },
  })
}

export type CallToolOptions = {
  /** Skip cache read/write when true. */
  skipCache?: boolean
  /** Cache TTL when writing (default: TOOL_CACHE_TTL_MS[tool] or 24h). */
  cacheTtlMs?: number
  signal?: AbortSignal
}

/**
 * Cache → budget → retry → timeout → Step row → cache write → trace span.
 * Returns null on final failure; never throws to the caller.
 */
export async function callTool<T>(
  run: CallToolRun,
  tool: CallToolName,
  args: unknown,
  fn: (signal: AbortSignal, report: StepReporter) => Promise<T>,
  options: CallToolOptions = {}
): Promise<T | null> {
  const cacheKey = cacheKeyFor(tool, args)
  const cacheTtlMs = options.cacheTtlMs ?? TOOL_CACHE_TTL_MS[tool] ?? DEFAULT_CACHE_TTL_MS
  const reported: Record<string, unknown> = {}
  const report: StepReporter = (metadata) => Object.assign(reported, metadata)
  const started = Date.now()

  const spanAttrs: SpanAttributes = {
    "neatlogs.tool.name": tool,
    "research.run_id": run.runId,
    ...runTagAttributes(run.trace),
  }

  try {
    return await span(
      `tool.${tool}`,
      async () => {
        if (!options.skipCache) {
          const cached = await readCache(cacheKey)
          if (cached !== undefined) {
            await writeStep({
              runId: run.runId,
              tool,
              cacheKey,
              status: "cached",
              durationMs: Date.now() - started,
            })
            return cached as T
          }
        }

        if (isBudgetedTool(tool)) {
          const remaining = run.budget[tool] ?? DEFAULT_TOOL_BUDGETS[tool]
          if (remaining <= 0) {
            await writeStep({
              runId: run.runId,
              tool,
              cacheKey,
              status: "budget_exhausted",
              durationMs: Date.now() - started,
            })
            return null
          }
          run.budget[tool] = remaining - 1
        }

        const timeoutMs = TOOL_TIMEOUT_MS[tool]
        let lastError: unknown

        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
          const controller = new AbortController()
          const linked = options.signal
          const onAbort = () => controller.abort(linked?.reason)
          linked?.addEventListener("abort", onAbort, { once: true })

          const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs)
          try {
            const result = await fn(controller.signal, report)
            clearTimeout(timer)
            linked?.removeEventListener("abort", onAbort)

            // A null result is a non-retryable "nothing usable" (e.g. no credits,
            // endpoint disabled). Never cache it.
            const empty = result === null || result === undefined
            if (!options.skipCache && !empty) {
              await writeCache(cacheKey, result, cacheTtlMs)
            }

            await writeStep({
              runId: run.runId,
              tool,
              cacheKey,
              status: empty ? "empty" : "ok",
              durationMs: Date.now() - started,
              metadata: { ...reported, attempts: attempt + 1 },
            })
            return empty ? null : result
          } catch (error) {
            clearTimeout(timer)
            linked?.removeEventListener("abort", onAbort)
            lastError = error
            if (attempt >= RETRY_DELAYS_MS.length) break
            await sleep(RETRY_DELAYS_MS[attempt], options.signal)
          }
        }

        await writeStep({
          runId: run.runId,
          tool,
          cacheKey,
          status: "error",
          durationMs: Date.now() - started,
          metadata: {
            ...reported,
            message: lastError instanceof Error ? lastError.message : String(lastError),
          },
        })
        return null
      },
      spanAttrs,
      "TOOL"
    )
  } catch {
    await writeStep({
      runId: run.runId,
      tool,
      cacheKey,
      status: "error",
      durationMs: Date.now() - started,
    }).catch(() => undefined)
    return null
  }
}
