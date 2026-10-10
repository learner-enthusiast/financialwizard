import "server-only"

import { computeMetrics, type ComputeInputs, type ComputedValue } from "@/compute"
import { CHECK_SPECS, SCALE_MULTIPLIER, type FieldSpec } from "@/agents/extractor/checks"
import {
  InputSchema,
  llmSchemaFor,
  OutputSchema,
  type ComputedEntry,
  type ExtractorInput,
  type ExtractorOutput,
  type FieldValue,
  type LlmField,
  type LlmValuation,
} from "@/agents/extractor/schema"
import { PROMPT_VERSION, SYSTEM_PROMPT, SYSTEM_PROMPT_V1 } from "@/agents/extractor/prompt"
import { PACKS, type CheckId } from "@/agents/packs"
import { currencyFor, formatCount, formatMoney, formatPerShare, type CurrencyCode } from "@/agents/shared/format"
import { llmExtract } from "@/agents/shared/llm"
import { runAgent } from "@/agents/shared/run-agent"
import { normalizeText } from "@/agents/shared/sources"
import type { AgentContext, Claim, SourceRef } from "@/agents/types"
import { sliceSections } from "@/lib/clients/pdf"

export { InputSchema, OutputSchema, PROMPT_VERSION }
export type { ExtractorInput, ExtractorOutput }

/** Sources longer than this are cut to the check's filing sections. */
const SECTION_THRESHOLD_CHARS = 8_000
const MAX_CHARS_PER_SOURCE = 12_000
const MAX_TOTAL_CHARS = 60_000

// ---------------------------------------------------------------------------
// Source preparation: never pass a whole filing
// ---------------------------------------------------------------------------

/** Filing headings for a check (first pack that defines them). */
function sectionHeadingsFor(checkId: CheckId): string[] {
  for (const pack of PACKS) {
    const headings = pack.checks.find((check) => check.id === checkId)?.sectionHeadings
    if (headings?.length) return headings
  }
  return []
}

export function prepareSourceText(source: SourceRef, headings: string[]): string {
  let text = source.text
  if (text.length > SECTION_THRESHOLD_CHARS && headings.length > 0) {
    const sections = Object.values(sliceSections(text, headings)).filter((section) => section.length > 0)
    text = sections.length > 0 ? sections.join("\n\n…\n\n") : text
  }
  return text.slice(0, MAX_CHARS_PER_SOURCE)
}

function renderPrompt(input: ExtractorInput, headings: string[]): string {
  const spec = CHECK_SPECS[input.checkId]
  const fieldLines = Object.entries(spec.fields).map(
    ([name, field]) => `- ${name} (${field.kind}): ${field.label}${field.hint ? ` — ${field.hint}` : ""}`
  )
  let budget = MAX_TOTAL_CHARS
  const blocks: string[] = []
  for (const source of input.sources) {
    if (budget <= 0) break
    const text = prepareSourceText(source, headings).slice(0, budget)
    budget -= text.length
    blocks.push(`[${source.id}] (${source.kind}, ${source.url})\n${text}`)
  }
  return [
    `Check: ${input.checkId}`,
    `Fields:\n${fieldLines.join("\n")}`,
    `Company: ${input.entity.legalName} (${input.entity.country})`,
    `Sources:\n\n${blocks.join("\n\n---\n\n")}`,
  ].join("\n\n")
}

// ---------------------------------------------------------------------------
// Field validation (code, not the model, decides what is kept)
// ---------------------------------------------------------------------------

type Accepted = { value: FieldValue } | { missing: string }

function quoteFound(quote: string | null, cited: SourceRef[]): boolean {
  if (!quote?.trim()) return false
  const needle = normalizeText(quote)
  return cited.some((source) => normalizeText(source.text).includes(needle))
}

/** Converts and validates one LLM field. `verifyQuotes` is the v2 anti-hallucination check. */
export function acceptField(
  checkId: CheckId,
  name: string,
  spec: FieldSpec,
  raw: LlmField | undefined,
  sources: SourceRef[],
  expectedCurrency: CurrencyCode,
  verifyQuotes: boolean
): Accepted {
  if (!raw || raw.value === null) return { missing: name }
  const byId = new Map(sources.map((source) => [source.id, source]))
  const cited = [...new Set(raw.sourceIds)].map((id) => byId.get(id)).filter((s): s is SourceRef => Boolean(s))
  if (cited.length === 0) return { missing: name }
  if (verifyQuotes && !quoteFound(raw.quote, cited)) return { missing: name }

  const base = { kind: spec.kind, claimId: `${checkId}.${name}`, sourceIds: cited.map((s) => s.id), period: raw.period ?? undefined }

  switch (spec.kind) {
    case "money":
    case "per_share":
    case "count":
    case "days":
    case "year": {
      if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) return { missing: name }
      const scale = spec.kind === "money" || spec.kind === "count" ? SCALE_MULTIPLIER[raw.scale ?? "units"] : 1
      const currency = spec.kind === "money" || spec.kind === "per_share" ? (raw.currency ?? expectedCurrency) : undefined
      if (currency && currency !== expectedCurrency) return { missing: `${name} (reported in ${currency}; not converted)` }
      return { value: { ...base, value: raw.value * scale, currency } }
    }
    case "date":
      return typeof raw.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.value)
        ? { value: { ...base, value: raw.value } }
        : { missing: name }
    case "boolean":
      return typeof raw.value === "boolean" ? { value: { ...base, value: raw.value } } : { missing: name }
    case "text":
      return typeof raw.value === "string" && raw.value.trim() ? { value: { ...base, value: raw.value.trim().slice(0, 200) } } : { missing: name }
  }
}

// ---------------------------------------------------------------------------
// Claims and computation
// ---------------------------------------------------------------------------

function display(field: FieldValue, currency: CurrencyCode): string {
  if (typeof field.value !== "number") return String(field.value)
  switch (field.kind) {
    case "money":
      return formatMoney(field.value, field.currency ?? currency)
    case "per_share":
      return formatPerShare(field.value, field.currency ?? currency)
    case "days":
      return `${formatCount(field.value)} days`
    case "year":
      return String(field.value)
    default:
      return formatCount(field.value)
  }
}

function fieldClaim(checkId: CheckId, name: string, field: FieldValue, currency: CurrencyCode): Claim {
  const label = CHECK_SPECS[checkId].fields[name]?.label ?? name
  return {
    id: field.claimId,
    checkId,
    field: name,
    statement: `${label}: ${display(field, currency)}${field.period ? ` (${field.period})` : ""}.`,
    value: field.value,
    unit: field.kind === "money" || field.kind === "per_share" ? (field.currency ?? currency) : field.kind,
    period: field.period,
    sourceIds: field.sourceIds,
  }
}

const METRIC_LABEL: Record<string, string> = {
  market_cap_at_low: "Market value at the lower price",
  market_cap_at_high: "Market value at the upper price",
  pe_at_high: "Price-to-earnings at the upper price",
  ps_at_high: "Price-to-sales at the upper price",
  ofs_percent: "Share of the issue that is offer for sale",
  lock_in_end_date: "Lock-in ends",
  revenue_growth_pct: "Revenue change versus prior period",
  implied_valuation_from_quote: "Value implied by the unlisted quote",
  headcount_change_pct: "Headcount change over one year",
  market_cap_llm: "Market value (model estimate)",
  pe_llm: "Price-to-earnings (model estimate)",
  ps_llm: "Price-to-sales (model estimate)",
}

function displayComputed(entry: { value: number | string; unit: ComputedEntry["unit"] }, currency: CurrencyCode): string {
  if (typeof entry.value === "string") return entry.value
  if (entry.unit === "currency") return formatMoney(entry.value, currency)
  if (entry.unit === "percent") return `${entry.value}%`
  return `${entry.value}×`
}

function computedClaim(checkId: CheckId, entry: ComputedEntry, currency: CurrencyCode, derivedFrom?: string[]): Claim {
  return {
    id: entry.claimId,
    checkId,
    field: entry.metric,
    statement: `${METRIC_LABEL[entry.metric] ?? entry.metric}: ${displayComputed(entry, currency)}.`,
    value: entry.value,
    unit: entry.unit === "currency" ? currency : entry.unit,
    sourceIds: entry.sourceIds,
    ...(derivedFrom ? { derivedFrom } : {}),
  }
}

function asNumber(field: FieldValue | undefined, name: string) {
  return field && typeof field.value === "number" ? { value: field.value, sourceIds: field.sourceIds, claimId: field.claimId ?? name } : undefined
}

export function toComputeInputs(fields: Record<string, FieldValue>): ComputeInputs {
  const num = (name: string) => asNumber(fields[name], name)
  const listing = fields.listingDate
  return {
    priceLow: num("priceLow"),
    priceHigh: num("priceHigh"),
    sharesOutstandingPostIssue: num("sharesOutstandingPostIssue"),
    revenueLatest: num("revenueLatest"),
    revenuePrior: num("revenuePrior"),
    netIncomeLatest: num("netIncomeLatest"),
    freshIssueAmount: num("freshIssueAmount"),
    ofsAmount: num("ofsAmount"),
    listingDate: listing && typeof listing.value === "string" ? { value: listing.value, sourceIds: listing.sourceIds, claimId: listing.claimId } : undefined,
    lockInDays: num("lockInDays"),
    quotedPricePerShare: num("quotedPricePerShare"),
    headcountLatest: num("headcountLatest"),
    headcountYearAgo: num("headcountYearAgo"),
  }
}

/** v2: metrics computed in code from this check's fields plus earlier checks' fields. */
function computeFromFields(current: Record<string, FieldValue>, prior: Record<string, FieldValue>): Array<ComputedValue & { claimId: string }> {
  const currentClaims = new Set(Object.values(current).map((f) => f.claimId))
  return computeMetrics(toComputeInputs({ ...prior, ...current }))
    // Only metrics that use at least one input from this check (avoids repeating earlier checks' metrics).
    .filter((metric) => metric.inputClaimIds.some((id) => currentClaims.has(id)))
    .map((metric) => ({ ...metric, claimId: `computed.${metric.metric}` }))
}

/** v1: model-stated valuation, kept only to show the "before" behaviour. */
function llmValuation(checkId: CheckId, valuation: LlmValuation | undefined, sources: SourceRef[]): ComputedEntry[] {
  if (!valuation) return []
  const ids = valuation.sourceIds.filter((id) => sources.some((s) => s.id === id))
  const fallbackIds = ids.length > 0 ? ids : sources.slice(0, 1).map((s) => s.id)
  if (fallbackIds.length === 0) return []
  const entries: Array<[string, number | null, ComputedEntry["unit"]]> = [
    ["market_cap_llm", valuation.marketCap, "currency"],
    ["pe_llm", valuation.peRatio, "ratio"],
    ["ps_llm", valuation.psRatio, "ratio"],
  ]
  return entries
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .map(([metric, value, unit]) => ({
      metric,
      value: value as number,
      unit,
      formula: "stated by the model",
      origin: "llm" as const,
      claimId: `${checkId}.${metric}`,
      sourceIds: fallbackIds,
    }))
}

/**
 * Sources → typed facts for one check.
 * v2: the LLM extracts inputs with verbatim quotes; code verifies quotes and computes metrics.
 * v1: no quote verification and the LLM states valuation directly.
 */
export async function runExtractor(input: unknown, ctx: AgentContext): Promise<ExtractorOutput> {
  return runAgent({
    name: "extractor",
    promptVersion: PROMPT_VERSION,
    ctx,
    input,
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    fail: (status, reason) => ({ status, reason, fields: {}, computed: [], missing: [], claims: [] }),
    body: async (parsed, setAttributes) => {
      const { checkId, entity, sources, priorFields } = parsed
      const spec = CHECK_SPECS[checkId]
      const fieldNames = Object.keys(spec.fields)
      const currency = currencyFor(entity.country)

      if (sources.length === 0) {
        return { status: "unverifiable" as const, reason: "No sources were available for this check.", checkId, fields: {}, computed: [], missing: fieldNames, claims: [] }
      }

      const v1 = ctx.version === "v1"
      const extracted = await llmExtract(ctx, {
        agent: "extractor",
        promptVersion: PROMPT_VERSION,
        label: `${checkId}.${ctx.version}`,
        system: v1 ? SYSTEM_PROMPT_V1 : SYSTEM_PROMPT,
        text: renderPrompt(parsed, sectionHeadingsFor(checkId)),
        schema: llmSchemaFor(checkId, ctx.version),
        maxTokens: 2000,
      })
      if (!extracted) {
        return { status: "unverifiable" as const, reason: "Facts could not be extracted from the sources.", checkId, fields: {}, computed: [], missing: fieldNames, claims: [] }
      }

      const rawFields = extracted.fields as Record<string, LlmField>
      const fields: Record<string, FieldValue> = {}
      const missing: string[] = []
      for (const name of fieldNames) {
        const result = acceptField(checkId, name, spec.fields[name]!, rawFields[name], sources, currency, !v1)
        if ("value" in result) fields[name] = result.value
        else missing.push(result.missing)
      }

      const claims = Object.entries(fields).map(([name, field]) => fieldClaim(checkId, name, field, currency))
      let computed: ComputedEntry[]
      if (v1) {
        computed = llmValuation(checkId, (extracted as { valuation?: LlmValuation }).valuation, sources)
        claims.push(...computed.map((entry) => computedClaim(checkId, entry, currency)))
      } else {
        const metrics = computeFromFields(fields, priorFields)
        computed = metrics.map((m) => ({ metric: m.metric, value: m.value, unit: m.unit, formula: m.formula, origin: "code" as const, claimId: m.claimId, sourceIds: m.sourceIds }))
        claims.push(...metrics.map((m, i) => computedClaim(checkId, computed[i]!, currency, m.inputClaimIds)))
      }

      setAttributes({
        "extractor.check": checkId,
        "extractor.fields": Object.keys(fields).length,
        "extractor.missing": missing.length,
        "extractor.computed": computed.length,
      })

      return {
        status: Object.keys(fields).length > 0 ? ("ok" as const) : ("unverifiable" as const),
        reason: Object.keys(fields).length > 0 ? undefined : "The sources did not state any of the requested facts.",
        checkId,
        fields,
        computed,
        missing,
        claims,
      }
    },
  })
}
