import "server-only"

import { llmExtract } from "@/agents/shared/llm"
import { normalizeLegalName, textNamesEntity } from "@/agents/shared/names"
import { runAgent } from "@/agents/shared/run-agent"
import { classifyUrl, hostOf, normalizeDomain, recordSource } from "@/agents/shared/sources"
import {
  InputSchema,
  llmCandidatesSchema,
  OutputSchema,
  type Candidate,
  type Intent,
  type ResolverInput,
  type ResolverOutput,
} from "@/agents/resolver/schema"
import { PROMPT_VERSION, SYSTEM_PROMPT } from "@/agents/resolver/prompt"
import type { AgentContext, Claim, Country, Entity, EntityStatus, SourceRef } from "@/agents/types"
import { callTool } from "@/lib/clients/callTool"
import { enrichCompany } from "@/lib/clients/crustdata"
import { searchTickers } from "@/lib/clients/edgar"
import { scrapePage } from "@/lib/clients/firecrawl"
import { listKnownCompanies } from "@/lib/clients/inFilings"
import { search, type SerpSearchResult } from "@/lib/clients/serp"
import { lookupCompany } from "@/lib/clients/wikidata"

export { InputSchema, OutputSchema, PROMPT_VERSION }
export type { ResolverInput, ResolverOutput }

/** Stop the chain when the top match is this confident... */
export const DECISIVE_CONFIDENCE = 0.85
/** ...and the runner-up is at least this far behind. */
export const DECISIVE_GAP = 0.15
const AGREEMENT_BONUS = 0.1
const EXACT_BONUS = 0.1
const MAX_ORGANIC = 8
const MAX_CONFIRMATIONS = 2

/** Base confidence by how a candidate was first found. */
const BASE = {
  localExact: 0.6,
  localPartial: 0.35,
  wikidata: 0.3,
  search: 0.25,
  aiOverviewOnly: 0.1,
} as const

type Working = {
  legalName: string
  country?: Country
  status?: EntityStatus
  domain?: string
  symbols: Set<string>
  cik?: string
  filingUrl?: string
  base: number
  exact: boolean
  /** Sources that produced this candidate (may include AI overviews). */
  originIds: Set<string>
  /** True while the only evidence is an AI overview. */
  aiOnly: boolean
}

type Scored = { working: Working; confidence: number; sourceIds: string[] }

type State = {
  ctx: AgentContext
  input: ResolverInput
  intent: Intent
  candidates: Working[]
  sources: SourceRef[]
}

// ---------------------------------------------------------------------------
// Matching and scoring (pure)
// ---------------------------------------------------------------------------

export function detectIntent(query: string): Intent {
  return /\b(ipo|drhp|rhp|s-1|listing|pre-ipo)\b/i.test(query) ? "ipo" : "any"
}

/** Strips intent words so "Jio IPO" searches local tables for "jio". */
function coreQuery(query: string): string {
  return query.replace(/\b(ipo|drhp|rhp|s-1|pre-ipo|shares?|stock|listing|unlisted)\b/gi, " ").replace(/\s+/g, " ").trim()
}

export function nameMatch(query: string, name: string): "exact" | "partial" | null {
  const q = normalizeLegalName(query)
  const n = normalizeLegalName(name)
  if (!q || !n) return null
  if (q === n) return "exact"
  const qTokens = q.split(" ")
  const nTokens = n.split(" ")
  return qTokens.every((token, i) => nTokens[i] === token) ? "partial" : null
}

function sameCandidate(a: Working, b: Working): boolean {
  if (a.domain && b.domain && a.domain === b.domain) return true
  return normalizeLegalName(a.legalName) === normalizeLegalName(b.legalName)
}

function addCandidate(state: State, next: Working): void {
  const existing = state.candidates.find((c) => sameCandidate(c, next))
  if (!existing) {
    state.candidates.push(next)
    return
  }
  // Prefer the longer (more legal-looking) name, keep the first value otherwise.
  if (next.legalName.length > existing.legalName.length && !next.aiOnly) existing.legalName = next.legalName
  existing.country ??= next.country
  existing.status ??= next.status
  existing.domain ??= next.domain
  existing.cik ??= next.cik
  existing.filingUrl ??= next.filingUrl
  next.symbols.forEach((symbol) => existing.symbols.add(symbol))
  next.originIds.forEach((id) => existing.originIds.add(id))
  existing.base = Math.max(existing.base, next.base)
  existing.exact ||= next.exact
  existing.aiOnly &&= next.aiOnly
}

function groupKey(source: SourceRef): string {
  return `${source.kind}:${hostOf(source.url) ?? source.url}`
}

/**
 * confidence = base (+0.1 exact match) + 0.1 for every additional independent
 * source (distinct host) that names the candidate. AI overviews never count.
 */
function score(state: State, working: Working): Scored {
  const supporting = state.sources.filter(
    (source) =>
      source.kind !== "AI_OVERVIEW" &&
      (working.originIds.has(source.id) ||
        textNamesEntity(`${source.title ?? ""} ${source.url} ${source.text}`, working))
  )
  const groups = new Set(supporting.map(groupKey)).size
  const raw = working.base + (working.exact ? EXACT_BONUS : 0) + AGREEMENT_BONUS * Math.max(0, groups - 1)
  const sourceIds = supporting.length > 0 ? supporting.map((s) => s.id) : [...working.originIds]
  return { working, confidence: Math.round(Math.min(0.99, raw) * 100) / 100, sourceIds: [...new Set(sourceIds)] }
}

function resolvedStatus(w: Working): EntityStatus {
  if (w.symbols.size > 0) return "listed"
  if (w.filingUrl) return "ipo_filed"
  return w.status ?? "unlisted"
}

function rank(state: State): Scored[] {
  const preferred = (s: Scored) => {
    if (state.intent !== "ipo") return 0
    return resolvedStatus(s.working) === "listed" ? 0 : 1
  }
  return state.candidates
    .map((working) => score(state, working))
    .filter((s) => s.sourceIds.length > 0)
    .sort((a, b) => preferred(b) - preferred(a) || b.confidence - a.confidence)
}

export function isDecisive(ranked: Array<{ confidence: number }>): boolean {
  const [top, second] = ranked
  if (!top || top.confidence < DECISIVE_CONFIDENCE) return false
  return !second || top.confidence - second.confidence >= DECISIVE_GAP
}

function toCandidate(state: State, scored: Scored): Candidate {
  const w = scored.working
  return {
    legalName: w.legalName,
    country: w.country ?? state.input.countryHint ?? "OTHER",
    status: resolvedStatus(w),
    domain: w.domain,
    symbols: [...w.symbols],
    cik: w.cik,
    filingUrl: w.filingUrl,
    confidence: scored.confidence,
    sourceIds: scored.sourceIds,
  }
}

function toEntity(candidate: Candidate): Entity {
  return {
    legalName: candidate.legalName,
    country: candidate.country,
    status: candidate.status,
    domain: candidate.domain,
    symbols: candidate.symbols,
    cik: candidate.cik,
    filingUrl: candidate.filingUrl,
    sourceIds: candidate.sourceIds,
  }
}

function describe(c: Candidate): string {
  const status = c.status === "listed" ? `listed${c.symbols[0] ? `, ${c.symbols[0]}` : ""}` : c.status.replace("_", " ")
  return `${c.legalName} (${status})`
}

export function ambiguityQuestion(candidates: Candidate[]): string {
  const options = candidates.slice(0, 3).map(describe)
  return options.length === 1 ? `Did you mean ${options[0]}?` : `Which company do you mean: ${options.join(" or ")}?`
}

function entityClaims(entity: Entity): Claim[] {
  const base = { checkId: "resolver", sourceIds: entity.sourceIds }
  const claims: Claim[] = [
    { ...base, id: "resolver.legalName", field: "legalName", statement: `The company is ${entity.legalName}.`, value: entity.legalName },
    { ...base, id: "resolver.status", field: "status", statement: `Listing status: ${entity.status.replace("_", " ")}.`, value: entity.status },
  ]
  if (entity.domain) {
    claims.push({ ...base, id: "resolver.domain", field: "domain", statement: `Official website domain: ${entity.domain}.`, value: entity.domain })
  }
  if (entity.symbols.length > 0) {
    claims.push({ ...base, id: "resolver.symbols", field: "symbols", statement: `Trading symbols: ${entity.symbols.join(", ")}.`, value: entity.symbols.join(",") })
  }
  if (entity.cik) {
    claims.push({ ...base, id: "resolver.cik", field: "cik", statement: `SEC CIK: ${entity.cik}.`, value: entity.cik })
  }
  return claims
}

// ---------------------------------------------------------------------------
// Chain steps. Each adds sources + candidates; failures are skipped (callTool → null).
// ---------------------------------------------------------------------------

async function stepLocal(state: State): Promise<void> {
  const { ctx, input } = state
  const query = coreQuery(input.query) || input.query

  if (input.countryHint !== "US") {
    for (const row of await listKnownCompanies()) {
      const match = nameMatch(query, row.legalName)
      if (!match) continue
      const source = await recordSource(ctx, {
        url: `local:data/in-filings/companies.json#${encodeURIComponent(row.legalName)}`,
        kind: "REFERENCE",
        publisher: "local company list",
        title: row.legalName,
        text: JSON.stringify(row),
      })
      state.sources.push(source)
      const symbols = new Set<string>()
      if (row.nseSymbol) symbols.add(`NSE:${row.nseSymbol}`)
      if (row.bseCode) symbols.add(`BSE:${row.bseCode}`)
      addCandidate(state, {
        legalName: row.legalName,
        country: "IN",
        status: row.status,
        domain: normalizeDomain(row.domain),
        symbols,
        filingUrl: row.drhpUrl,
        base: match === "exact" ? BASE.localExact : BASE.localPartial,
        exact: match === "exact",
        originIds: new Set([source.id]),
        aiOnly: false,
      })
    }
  }

  if (input.countryHint !== "IN") {
    const rows = (await callTool(ctx, "edgar", { op: "searchTickers", query }, (signal) => searchTickers(query, 5, signal))) ?? []
    for (const row of rows) {
      const exactTicker = row.ticker === query.toUpperCase()
      const match = exactTicker ? "exact" : nameMatch(query, row.title)
      if (!match) continue
      const source = await recordSource(ctx, {
        url: `https://www.sec.gov/files/company_tickers.json#${row.ticker}`,
        kind: "REGULATOR",
        publisher: "SEC",
        title: row.title,
        text: `${row.title} (ticker ${row.ticker}, CIK ${row.cik})`,
      })
      state.sources.push(source)
      addCandidate(state, {
        legalName: row.title,
        country: "US",
        symbols: new Set([`US:${row.ticker}`]),
        cik: row.cik,
        base: match === "exact" ? BASE.localExact : BASE.localPartial,
        exact: match === "exact",
        originIds: new Set([source.id]),
        aiOnly: false,
      })
    }
  }
}

async function stepWikidata(state: State): Promise<void> {
  const query = coreQuery(state.input.query) || state.input.query
  const hit = await callTool(state.ctx, "wikidata", { query }, (signal) => lookupCompany(query, signal))
  if (!hit?.label) return
  const source = await recordSource(state.ctx, {
    url: `https://www.wikidata.org/wiki/${hit.id}`,
    kind: "REFERENCE",
    publisher: "Wikidata",
    title: hit.label,
    text: [hit.label, hit.description, hit.website ? `Website: ${hit.website}` : ""].filter(Boolean).join(". "),
  })
  state.sources.push(source)
  const symbols = new Set<string>()
  if (hit.exchange && hit.ticker) symbols.add(`${hit.exchange}:${hit.ticker}`)
  addCandidate(state, {
    legalName: hit.label,
    domain: normalizeDomain(hit.website),
    symbols,
    base: BASE.wikidata,
    exact: nameMatch(query, hit.label) === "exact",
    originIds: new Set([source.id]),
    aiOnly: false,
  })
}

async function storeSearchSources(state: State, result: SerpSearchResult, q: string): Promise<SourceRef[]> {
  const stored: SourceRef[] = []
  for (const row of result.organic.slice(0, MAX_ORGANIC)) {
    if (!row.link) continue
    stored.push(
      await recordSource(state.ctx, {
        url: row.link,
        kind: classifyUrl(row.link),
        title: row.title,
        publisher: hostOf(row.link),
        text: [row.title, row.snippet].filter(Boolean).join(" — "),
      })
    )
  }
  const kg = result.knowledgeGraph
  if (kg?.title) {
    stored.push(
      await recordSource(state.ctx, {
        url: kg.source?.link ?? `serp:knowledge_graph:${encodeURIComponent(kg.title)}`,
        kind: "REFERENCE",
        title: kg.title,
        publisher: kg.source?.name ?? "Google knowledge graph",
        text: [kg.title, kg.type, kg.description].filter(Boolean).join(" — "),
      })
    )
  }
  if (result.aiOverview) {
    stored.push(
      await recordSource(state.ctx, {
        url: `serp:ai_overview:${encodeURIComponent(q)}`,
        kind: "AI_OVERVIEW",
        publisher: "Google AI overview",
        text: JSON.stringify(result.aiOverview.textBlocks ?? result.aiOverview.raw ?? "").slice(0, 4000),
      })
    )
  }
  return stored
}

function renderResults(query: string, sources: SourceRef[]): string {
  const lines = sources.map((source, i) => {
    const label =
      source.kind === "AI_OVERVIEW" ? "ai overview — lead only" : source.publisher === "Google knowledge graph" || source.kind === "REFERENCE" ? "knowledge graph" : "organic"
    return `[${i}] (${label}) ${source.title ?? ""} — ${source.url}\n${source.text}`
  })
  return `Query: "${query}"\n\nResults:\n${lines.join("\n\n")}`
}

/** A domain is kept only if a cited result shows it (link host or text). */
function verifiedDomain(domain: string | null, cited: SourceRef[]): string | undefined {
  const normalized = normalizeDomain(domain)
  if (!normalized) return undefined
  const shown = cited.some((source) => {
    const host = hostOf(source.url)
    return (host && (host === normalized || host.endsWith(`.${normalized}`))) || source.text.toLowerCase().includes(normalized)
  })
  return shown ? normalized : undefined
}

async function stepSearch(state: State): Promise<void> {
  const q = state.input.query
  const gl = state.input.countryHint === "IN" ? "in" : state.input.countryHint === "US" ? "us" : undefined
  const result = await callTool(state.ctx, "serp", { q, gl, hl: "en" }, (signal) => search(q, { gl, hl: "en", signal }))
  if (!result) return

  const results = await storeSearchSources(state, result, q)
  state.sources.push(...results)
  if (results.length === 0) return

  const extracted = await llmExtract(state.ctx, {
    agent: "resolver",
    promptVersion: PROMPT_VERSION,
    label: "candidates",
    system: SYSTEM_PROMPT,
    text: renderResults(q, results),
    schema: llmCandidatesSchema,
    maxTokens: 1500,
  })

  for (const item of extracted?.candidates ?? []) {
    const cited = [...new Set(item.resultIndexes)].map((i) => results[i]).filter((s): s is SourceRef => Boolean(s))
    if (cited.length === 0) continue
    const aiOnly = cited.every((source) => source.kind === "AI_OVERVIEW")
    addCandidate(state, {
      legalName: item.legalName.trim(),
      country: item.country ?? undefined,
      status: aiOnly ? undefined : (item.status ?? undefined),
      domain: verifiedDomain(item.domain, cited),
      symbols: new Set(),
      base: aiOnly ? BASE.aiOverviewOnly : BASE.search,
      exact: item.matchesQuery === "exact" && !aiOnly,
      originIds: new Set(cited.map((source) => source.id)),
      aiOnly,
    })
  }
}

async function stepCrustdata(state: State): Promise<void> {
  for (const scored of rank(state).slice(0, MAX_CONFIRMATIONS)) {
    const w = scored.working
    const target = w.domain ? { domain: w.domain } : { name: w.legalName }
    // Field list left to the client default until docs/vendor/crustdata.md defines it.
    const result = await callTool(state.ctx, "crustdata", { op: "enrich", target }, (signal) =>
      enrichCompany(target, [], { signal })
    )
    if (result === null || result === undefined) continue
    state.sources.push(
      await recordSource(state.ctx, {
        url: `crustdata:enrich:${encodeURIComponent(w.domain ?? w.legalName)}`,
        kind: "REFERENCE",
        publisher: "Crustdata",
        text: JSON.stringify(result).slice(0, 8000),
      })
    )
  }
}

async function stepCompanySite(state: State): Promise<void> {
  for (const scored of rank(state).slice(0, MAX_CONFIRMATIONS)) {
    const domain = scored.working.domain
    if (!domain) continue
    const url = `https://${domain}`
    const markdown = await callTool(state.ctx, "firecrawl", { url }, (signal) => scrapePage(url, signal))
    if (!markdown?.trim()) continue
    state.sources.push(
      await recordSource(state.ctx, { url, kind: "COMPANY", publisher: domain, title: domain, text: markdown })
    )
  }
}

// ---------------------------------------------------------------------------

function finish(state: State, ranked: Scored[], decisive: boolean): ResolverOutput {
  const candidates = ranked.slice(0, 5).map((scored) => toCandidate(state, scored))
  if (candidates.length === 0) {
    return {
      status: "unverifiable",
      reason: "No company matching the query was found in any source.",
      intent: state.intent,
      candidates: [],
      needsUserChoice: false,
      claims: [],
    }
  }
  if (!decisive) {
    return {
      status: "ok",
      intent: state.intent,
      candidates,
      needsUserChoice: true,
      question: ambiguityQuestion(candidates),
      claims: [],
    }
  }
  const entity = toEntity(candidates[0]!)
  return { status: "ok", intent: state.intent, candidates, entity, needsUserChoice: false, claims: entityClaims(entity) }
}

/**
 * Free text → one canonical company (or a question when ambiguous).
 * v1: raw search, first plausible result, never asks.
 * v2: local → Wikidata → search → Crustdata → company site, stopping early
 *     once the top match is decisive.
 */
export async function runResolver(input: unknown, ctx: AgentContext): Promise<ResolverOutput> {
  return runAgent({
    name: "resolver",
    promptVersion: PROMPT_VERSION,
    ctx,
    input,
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    fail: (status, reason) => ({ status, reason, intent: "any" as const, candidates: [], needsUserChoice: false, claims: [] }),
    body: async (parsed, setAttributes) => {
      const state: State = { ctx, input: parsed, intent: detectIntent(parsed.query), candidates: [], sources: [] }

      if (ctx.version === "v1") {
        await stepSearch(state)
        const first = state.candidates[0]
        const ranked = first ? [score(state, first)] : []
        setAttributes({ "resolver.steps": "search", "resolver.candidates": ranked.length })
        return finish(state, ranked, ranked.length > 0)
      }

      const steps: Array<[string, (s: State) => Promise<void>]> = [
        ["local", stepLocal],
        ["wikidata", stepWikidata],
        ["search", stepSearch],
        ["crustdata", stepCrustdata],
        ["company_site", stepCompanySite],
      ]
      const ran: string[] = []
      let ranked: Scored[] = []
      for (const [name, step] of steps) {
        await step(state)
        ran.push(name)
        ranked = rank(state)
        if (isDecisive(ranked)) break
      }

      setAttributes({
        "resolver.steps": ran.join(","),
        "resolver.candidates": ranked.length,
        "resolver.top_confidence": ranked[0]?.confidence ?? 0,
      })
      return finish(state, ranked, isDecisive(ranked))
    },
  })
}
