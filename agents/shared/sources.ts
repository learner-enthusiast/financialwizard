import "server-only"

import { createHash } from "node:crypto"

import type { AgentContext, SourceKind, SourceRef } from "@/agents/types"
import { sourcesRepository, type Source } from "@/repositories/sources.repository"

/** Stored excerpts are capped; agents never keep a whole filing. */
export const MAX_EXCERPT_CHARS = 20_000

const REGULATOR_HOSTS = [
  "sec.gov",
  "sebi.gov.in",
  "nseindia.com",
  "bseindia.com",
  "mca.gov.in",
  "rbi.org.in",
]

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return undefined
  }
}

export function normalizeDomain(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim().toLowerCase()
  const host = hostOf(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
  return host || undefined
}

function hostMatches(host: string | undefined, domain: string): boolean {
  return Boolean(host && (host === domain || host.endsWith(`.${domain}`)))
}

/** Classifies a web URL. Filings and AI overviews are labelled by the caller. */
export function classifyUrl(url: string, entityDomain?: string): SourceKind {
  const host = hostOf(url)
  if (REGULATOR_HOSTS.some((domain) => hostMatches(host, domain))) return "REGULATOR"
  const own = normalizeDomain(entityDomain)
  if (own && hostMatches(host, own)) return "COMPANY"
  return "NEWS"
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

export function contentHash(text: string): string {
  return createHash("sha256").update(normalizeText(text)).digest("hex")
}

export function toSourceRef(row: Source): SourceRef {
  return {
    id: row.id,
    url: row.url,
    kind: row.kind,
    title: row.title ?? undefined,
    publisher: row.publisher ?? undefined,
    text: row.excerpt,
    contentHash: row.contentHash,
    publishedAt: row.publishedAt?.toISOString(),
  }
}

/** Persists a source for this run (idempotent per URL) and returns it as a SourceRef. */
export async function recordSource(
  ctx: AgentContext,
  input: {
    url: string
    kind: SourceKind
    text: string
    title?: string
    publisher?: string
    publishedAt?: Date
    legalNameMatched?: boolean
  }
): Promise<SourceRef> {
  const excerpt = input.text.slice(0, MAX_EXCERPT_CHARS)
  const row = await sourcesRepository.upsert({
    runId: ctx.runId,
    url: input.url,
    kind: input.kind,
    title: input.title,
    publisher: input.publisher,
    excerpt,
    contentHash: contentHash(excerpt),
    legalNameMatched: input.legalNameMatched ?? false,
    publishedAt: input.publishedAt,
  })
  return toSourceRef(row)
}

export async function loadSources(ctx: AgentContext, ids: string[]): Promise<SourceRef[]> {
  return (await sourcesRepository.findByIds(ctx.runId, [...new Set(ids)])).map(toSourceRef)
}
