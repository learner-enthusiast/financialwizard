/*
 * Docs used:
 *   https://serpapi.com/search-api
 *   https://serpapi.com/organic-results
 *   https://serpapi.com/knowledge-graph
 *   https://serpapi.com/ai-overview
 *   https://serpapi.com/google-ai-overview-api
 */
import "server-only"

import type { z } from "zod"

import { requireSerpApiKey } from "@/lib/env"

export type SerpSearchParams = {
  engine: string
  signal?: AbortSignal
} & Record<string, unknown>

export type SerpOrganicResult = {
  position?: number
  title?: string
  link?: string
  snippet?: string
}

export type SerpKnowledgeGraph = {
  title?: string
  type?: string
  description?: string
  source?: { name?: string; link?: string }
}

export type SerpAiOverview = {
  pageToken?: string
  textBlocks?: unknown[]
  references?: unknown[]
  raw?: unknown
}

export type SerpSearchResult = {
  organic: SerpOrganicResult[]
  knowledgeGraph?: SerpKnowledgeGraph
  aiOverview?: SerpAiOverview
}

type SerpJson = Record<string, unknown>

function serpParamString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

function toQueryParams(params: SerpSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (key === "signal") continue
    const encoded = serpParamString(value)
    if (encoded !== undefined) out[key] = encoded
  }
  if (!out.engine) throw new Error("Serp search requires engine")
  return out
}

async function serpGet(params: Record<string, string>, signal?: AbortSignal): Promise<SerpJson> {
  const url = new URL("https://serpapi.com/search.json")
  url.searchParams.set("api_key", requireSerpApiKey())
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  const res = await fetch(url, { signal, headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`)
  return (await res.json()) as SerpJson
}

function mapOrganic(data: SerpJson): SerpOrganicResult[] {
  const rows = data.organic_results
  if (!Array.isArray(rows)) return []
  return rows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      position: typeof r.position === "number" ? r.position : undefined,
      title: typeof r.title === "string" ? r.title : undefined,
      link: typeof r.link === "string" ? r.link : undefined,
      snippet: typeof r.snippet === "string" ? r.snippet : undefined,
    }
  })
}

function mapKnowledgeGraph(data: SerpJson): SerpKnowledgeGraph | undefined {
  const kg = data.knowledge_graph
  if (!kg || typeof kg !== "object") return undefined
  const k = kg as Record<string, unknown>
  const source = k.source
  return {
    title: typeof k.title === "string" ? k.title : undefined,
    type: typeof k.type === "string" ? k.type : undefined,
    description: typeof k.description === "string" ? k.description : undefined,
    source:
      source && typeof source === "object"
        ? {
            name: typeof (source as Record<string, unknown>).name === "string" ? (source as Record<string, unknown>).name as string : undefined,
            link: typeof (source as Record<string, unknown>).link === "string" ? (source as Record<string, unknown>).link as string : undefined,
          }
        : undefined,
  }
}

async function fetchAiOverview(pageToken: string, signal?: AbortSignal): Promise<SerpAiOverview | undefined> {
  const data = await serpGet({ engine: "google_ai_overview", page_token: pageToken }, signal)
  return { raw: data, textBlocks: data.text_blocks as unknown[] | undefined, references: data.references as unknown[] | undefined }
}

export async function search(
  q: string,
  opts: { gl?: string; hl?: string; signal?: AbortSignal } = {}
): Promise<SerpSearchResult> {
  const params: Record<string, string> = { engine: "google", q }
  if (opts.gl) params.gl = opts.gl
  if (opts.hl) params.hl = opts.hl

  const data = await serpGet(params, opts.signal)
  const organic = mapOrganic(data)
  const knowledgeGraph = mapKnowledgeGraph(data)

  let aiOverview: SerpAiOverview | undefined
  const overview = data.ai_overview
  if (overview && typeof overview === "object") {
    const o = overview as Record<string, unknown>
    if (o.error) {
      aiOverview = undefined
    } else if (typeof o.page_token === "string") {
      aiOverview = await fetchAiOverview(o.page_token, opts.signal)
    }
  }

  return { organic, knowledgeGraph, aiOverview }
}

/** Raw SerpAPI JSON for any engine (used by lib/serp helpers). */
export async function serpRawSearch<T = unknown>(
  params: SerpSearchParams,
  responseSchema?: z.ZodType<T>
): Promise<T> {
  const { signal, timeout, ...rest } = params
  const query = toQueryParams({ ...rest, engine: String(rest.engine) })

  let effectiveSignal = signal
  let clearTimer: (() => void) | undefined
  if (typeof timeout === "number" && timeout > 0) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("SerpAPI timeout")), timeout)
    clearTimer = () => clearTimeout(timer)
    signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
    effectiveSignal = controller.signal
  }

  try {
    const payload = await serpGet(query, effectiveSignal)
    if (responseSchema) return responseSchema.parse(payload)
    return payload as T
  } finally {
    clearTimer?.()
  }
}

export const serpClient = {
  search: serpRawSearch,
}
