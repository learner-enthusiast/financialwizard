import "server-only"

import type { Source, SourceKind } from "@/generated/prisma/client"
import { getPrisma } from "@/lib/db/prisma"

export type { Source }

export type SourceInput = {
  runId: string
  url: string
  kind: SourceKind
  publisher?: string
  title?: string
  excerpt: string
  contentHash: string
  legalNameMatched: boolean
  publishedAt?: Date
}

export const sourcesRepository = {
  /** Idempotent per (runId, url): retried steps reuse the same row and id. */
  upsert(input: SourceInput): Promise<Source> {
    const data = {
      kind: input.kind,
      publisher: input.publisher ?? null,
      title: input.title ?? null,
      excerpt: input.excerpt,
      contentHash: input.contentHash,
      legalNameMatched: input.legalNameMatched,
      publishedAt: input.publishedAt ?? null,
    }
    return getPrisma().source.upsert({
      where: { runId_url: { runId: input.runId, url: input.url } },
      create: { runId: input.runId, url: input.url, ...data },
      update: data,
    })
  },

  findByIds(runId: string, ids: string[]): Promise<Source[]> {
    if (ids.length === 0) return Promise.resolve([])
    return getPrisma().source.findMany({ where: { runId, id: { in: ids } } })
  },

  listByRun(runId: string): Promise<Source[]> {
    return getPrisma().source.findMany({ where: { runId }, orderBy: { fetchedAt: "asc" } })
  },
}
