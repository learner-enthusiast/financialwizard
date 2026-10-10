/**
 * Shared mock factories for agent tests. Use inside vi.mock factories:
 *
 *   vi.mock("@/lib/clients/trace", async () => (await import("@/tests/support/agent-mocks")).traceMock())
 */
import { createAgentContext, type AgentContext, type SourceKind } from "@/agents/types"

/** span() runs fn directly and records names/attributes for assertions. */
export function traceMock() {
  const spans: Array<{ name: string; attrs: Record<string, unknown> }> = []
  return {
    __spans: spans,
    initTracing: async () => undefined,
    flush: async () => true,
    runTagAttributes: () => ({}),
    span: async (name: string, fn: (set: (a: Record<string, unknown>) => void) => Promise<unknown>, attrs?: Record<string, unknown>) => {
      const record = { name, attrs: { ...(attrs ?? {}) } }
      spans.push(record)
      return fn((more) => Object.assign(record.attrs, more))
    },
  }
}

/** callTool() without cache/DB: runs fn once; returns null on failure (same contract). */
export function callToolMock() {
  return {
    DEFAULT_TOOL_BUDGETS: { crustdata: 20, serp: 10, firecrawl: 15 },
    callTool: async (
      _run: unknown,
      _tool: string,
      _args: unknown,
      fn: (signal: AbortSignal, report: (metadata: Record<string, unknown>) => void) => Promise<unknown>
    ) => {
      try {
        return (await fn(new AbortController().signal, () => undefined)) ?? null
      } catch {
        return null
      }
    },
  }
}

type StoredSource = {
  id: string
  runId: string
  url: string
  kind: SourceKind
  publisher: string | null
  title: string | null
  excerpt: string
  contentHash: string
  legalNameMatched: boolean
  publishedAt: Date | null
  fetchedAt: Date
}

/** In-memory Source table with the repository's (runId, url) idempotency. */
export function sourcesRepositoryMock() {
  const rows = new Map<string, StoredSource>()
  let seq = 0
  return {
    __rows: rows,
    sourcesRepository: {
      upsert: async (input: Omit<StoredSource, "id" | "fetchedAt" | "publisher" | "title" | "publishedAt"> & {
        publisher?: string
        title?: string
        publishedAt?: Date
      }) => {
        const key = `${input.runId}|${input.url}`
        const existing = rows.get(key)
        const row: StoredSource = {
          id: existing?.id ?? `src_${++seq}`,
          runId: input.runId,
          url: input.url,
          kind: input.kind,
          publisher: input.publisher ?? null,
          title: input.title ?? null,
          excerpt: input.excerpt,
          contentHash: input.contentHash,
          legalNameMatched: input.legalNameMatched,
          publishedAt: input.publishedAt ?? null,
          fetchedAt: existing?.fetchedAt ?? new Date(),
        }
        rows.set(key, row)
        return row
      },
      findByIds: async (runId: string, ids: string[]) =>
        [...rows.values()].filter((row) => row.runId === runId && ids.includes(row.id)),
      listByRun: async (runId: string) => [...rows.values()].filter((row) => row.runId === runId),
    },
  }
}

export function testContext(version: "v1" | "v2" = "v2"): AgentContext {
  return createAgentContext({ runId: "run_test", version })
}
