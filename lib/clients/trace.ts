/*
 * Tracing client (neatlogs). The ONLY module that imports the neatlogs SDK.
 *
 * Docs used:
 *   https://docs.neatlogs.com/sdk/typescript       (init options, span(), trace(), wrap* helpers, kinds)
 *   https://docs.neatlogs.com/sdk/tags             (tags are process-wide, set in init())
 *   https://docs.neatlogs.com/sdk/sessions         (sessionId on trace root, identify())
 *   https://docs.neatlogs.com/sdk/custom-attributes (neatlogs.tool.* attributes)
 *   https://docs.neatlogs.com/sdk/lifecycle        (flush per serverless invocation, no per-request shutdown)
 *   https://docs.neatlogs.com/sdk/opentelemetry    (private provider; no global registration)
 *
 * Notes from the docs:
 *   - No auto-instrumentation in TypeScript. LLM clients are traced via the
 *     documented wrapAnthropic / wrapOpenAI / wrapBedrock helpers (used in llm.ts).
 *   - fetch/undici/HTTP are NOT instrumented; vendor HTTP calls get manual spans.
 *   - Export is disabled when no API key is set.
 */
import "server-only"

import { flush as neatlogsFlush, identify, init, trace } from "neatlogs"
import type { TraceSpanKind } from "neatlogs"

import type { RunTags } from "@/agents/types"
import { getTracingEnv } from "@/lib/env"

export { wrapAnthropic, wrapBedrock, wrapOpenAI } from "neatlogs"

export type SpanAttributes = Record<string, string | number | boolean>

type ActiveSpan = { setAttribute(key: string, value: string | number | boolean): unknown }

let initPromise: Promise<void> | undefined

/**
 * Idempotent. Safe to call at the start of every entry point (route handler,
 * job, script); the SDK is initialised once per process.
 */
export function initTracing(): Promise<void> {
  initPromise ??= init({
    apiKey: getTracingEnv().NEATLOGS_API_KEY,
    workflowName: "pre-purchase-research",
    tags: [process.env.NODE_ENV ?? "development"],
    // Next.js and job runners own process lifecycle; flush() is called explicitly.
    registerShutdownHandlers: false,
  }).catch((error: unknown) => {
    initPromise = undefined
    throw error
  })
  return initPromise
}

/**
 * Runs `fn` inside a named span (documented `trace()` API). Attributes are set
 * on the span before `fn` runs. Errors propagate unchanged (and are recorded
 * by the SDK).
 */
export async function span<T>(
  name: string,
  fn: () => Promise<T>,
  attrs?: SpanAttributes,
  kind?: TraceSpanKind
): Promise<T> {
  await initTracing()
  return trace({ name, ...(kind ? { kind } : {}) }, async (active: ActiveSpan) => {
    for (const [key, value] of Object.entries(attrs ?? {})) active.setAttribute(key, value)
    return fn()
  })
}

/**
 * Exports buffered spans. Call at the end of every serverless invocation /
 * job step and in scripts before exit. Never throws.
 */
export async function flush(): Promise<boolean> {
  try {
    return await neatlogsFlush()
  } catch {
    return false
  }
}

/** Span attributes for version / country / instrument on every run trace. */
export function runTagAttributes(tags: RunTags): SpanAttributes {
  return {
    "research.version": tags.version,
    "research.country": tags.country,
    "research.instrument": tags.instrument,
  }
}

/**
 * Root WORKFLOW span for one research run. Uses runId as sessionId (neatlogs sessions doc).
 */
export async function withRunTrace<T>(
  runId: string,
  tags: RunTags,
  fn: () => Promise<T>
): Promise<T> {
  await initTracing()
  const tagAttrs = runTagAttributes(tags)
  return identify({ sessionId: runId }, () =>
    trace({ name: "research.run", kind: "WORKFLOW", sessionId: runId }, async (active: ActiveSpan) => {
      for (const [key, value] of Object.entries(tagAttrs)) active.setAttribute(key, value)
      return fn()
    })
  )
}
