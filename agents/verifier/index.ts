import "server-only"

import { llmExtract } from "@/agents/shared/llm"
import { textNamesEntity } from "@/agents/shared/names"
import { runAgent } from "@/agents/shared/run-agent"
import { normalizeText } from "@/agents/shared/sources"
import {
  InputSchema,
  llmJudgementSchema,
  OutputSchema,
  type Conflict,
  type LlmJudgement,
  type Verdict,
  type VerifierInput,
  type VerifierOutput,
} from "@/agents/verifier/schema"
import { PROMPT_VERSION, SYSTEM_PROMPT } from "@/agents/verifier/prompt"
import type { AgentContext, Claim, Entity, SourceKind, SourceRef } from "@/agents/types"

export { InputSchema, OutputSchema, PROMPT_VERSION }
export type { VerifierInput, VerifierOutput }

/** primary > regulator > company > reference > news > AI overview */
export const SOURCE_RANK: Record<SourceKind, number> = {
  PRIMARY: 6,
  REGULATOR: 5,
  COMPANY: 4,
  REFERENCE: 3,
  NEWS: 2,
  AI_OVERVIEW: 1,
}

const MAX_SOURCES_PER_CLAIM = 3
const MAX_PASSAGE_CHARS = 4_000

const byRank = (a: SourceRef, b: SourceRef) =>
  SOURCE_RANK[b.kind] - SOURCE_RANK[a.kind] || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")

/** First 4-digit year in a period label ("FY2024", "year ended 31 March 2025"). */
export function periodYear(period: string | undefined): number | undefined {
  const match = period ? /(19|20)\d{2}/.exec(period) : null
  return match ? Number(match[0]) : undefined
}

export function isStale(claim: Claim, latest: string | undefined): boolean {
  const claimYear = periodYear(claim.period)
  const latestYear = periodYear(latest)
  return claimYear !== undefined && latestYear !== undefined && claimYear < latestYear
}

/** Keeps the highest-ranked copy of syndicated content (same normalized text hash). */
export function dedupeSyndicated(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>()
  return [...sources].sort(byRank).filter((source) => !seen.has(source.contentHash) && seen.add(source.contentHash))
}

function passage(source: SourceRef): string {
  return source.text.slice(0, MAX_PASSAGE_CHARS)
}

function quoteIn(quote: string | null, source: SourceRef): quote is string {
  return Boolean(quote?.trim()) && normalizeText(source.text).includes(normalizeText(quote!))
}

type Judged = { source: SourceRef; judgement: LlmJudgement }

async function judge(ctx: AgentContext, entity: Entity, claim: Claim, sources: SourceRef[]): Promise<Judged[]> {
  const blocks = sources.map((source) => `[${source.id}] (${source.kind}, ${source.url})\n${passage(source)}`)
  const result = await llmExtract(ctx, {
    agent: "verifier",
    promptVersion: PROMPT_VERSION,
    label: "judge",
    system: SYSTEM_PROMPT,
    text: [
      `Company: ${entity.legalName}${entity.domain ? ` (${entity.domain})` : ""}`,
      `Claim: ${claim.statement}${claim.period ? ` Period: ${claim.period}.` : ""}`,
      `Sources:\n\n${blocks.join("\n\n---\n\n")}`,
    ].join("\n\n"),
    schema: llmJudgementSchema,
    maxTokens: 800,
  })
  const byId = new Map(sources.map((source) => [source.id, source]))
  return (result?.judgements ?? []).flatMap((judgement) => {
    const source = byId.get(judgement.sourceId)
    if (!source) return []
    // A stance without a verbatim quote from that passage is treated as silent.
    if (judgement.stance !== "silent" && !quoteIn(judgement.quote, source)) {
      return [{ source, judgement: { ...judgement, stance: "silent" as const } }]
    }
    return [{ source, judgement }]
  })
}

function verdict(claim: Claim, partial: Omit<Verdict, "claimId" | "stale" | "sourceIds"> & { sourceIds?: string[] }, stale: boolean): Verdict {
  return {
    ...partial,
    claimId: claim.id,
    sourceIds: partial.sourceIds ?? [],
    stale,
    reason: stale ? `${partial.reason} Figure is older than the latest reported period.` : partial.reason,
  }
}

/** v2 rules for one non-derived claim. */
async function verifyClaim(
  ctx: AgentContext,
  input: VerifierInput,
  claim: Claim,
  sourcesById: Map<string, SourceRef>,
  conflicts: Conflict[]
): Promise<Verdict> {
  const stale = isStale(claim, input.latestReportedPeriod)
  if (claim.sourceIds.length === 0) return verdict(claim, { verdict: "unsupported", reason: "The claim cites no source." }, stale)

  const cited = claim.sourceIds.map((id) => sourcesById.get(id)).filter((s): s is SourceRef => Boolean(s))
  if (cited.length === 0) return verdict(claim, { verdict: "unsupported", reason: "Cited sources were not found." }, stale)

  const naming = cited.filter((source) => textNamesEntity(`${source.title ?? ""} ${source.text}`, input.entity))
  if (naming.length === 0) {
    return verdict(claim, { verdict: "unsupported", reason: `No cited source names ${input.entity.legalName}.` }, stale)
  }

  const unique = dedupeSyndicated(naming)
  const usable = unique.some((s) => s.kind !== "AI_OVERVIEW") ? unique.filter((s) => s.kind !== "AI_OVERVIEW") : []
  if (usable.length === 0) return verdict(claim, { verdict: "unsupported", reason: "Only an AI overview supports this; it is a lead, not evidence." }, stale)

  const judged = await judge(ctx, input.entity, claim, usable.slice(0, MAX_SOURCES_PER_CLAIM))
  const states = judged.filter((j) => j.judgement.stance === "states").sort((a, b) => byRank(a.source, b.source))
  const contradicts = judged.filter((j) => j.judgement.stance === "contradicts").sort((a, b) => byRank(a.source, b.source))

  if (states.length === 0 && contradicts.length === 0) {
    return verdict(claim, { verdict: "unsupported", reason: "No cited source states this." }, stale)
  }

  if (contradicts.length === 0) {
    if (states.every((j) => j.source.kind === "COMPANY")) {
      return verdict(
        claim,
        { verdict: "unsupported", reason: "Only the company's own material states this; it cannot confirm its own claim.", sourceIds: states.map((j) => j.source.id) },
        stale
      )
    }
    const best = states[0]!
    return verdict(claim, { verdict: "supported", reason: `Stated by a ${best.source.kind.toLowerCase().replace("_", " ")} source.`, quote: best.judgement.quote ?? undefined, sourceIds: states.map((j) => j.source.id) }, stale)
  }

  if (states.length === 0) {
    const best = contradicts[0]!
    return verdict(claim, { verdict: "contradicted", reason: "Cited sources give a different value.", quote: best.judgement.quote ?? undefined, sourceIds: contradicts.map((j) => j.source.id) }, stale)
  }

  // Both sides: the higher-ranked (then more recent) source wins.
  const a = states[0]!
  const b = contradicts[0]!
  const statesWins = byRank(a.source, b.source) <= 0
  const winner = statesWins ? a : b
  const loser = statesWins ? b : a
  const why =
    SOURCE_RANK[winner.source.kind] !== SOURCE_RANK[loser.source.kind]
      ? `${winner.source.kind.toLowerCase()} source outranks ${loser.source.kind.toLowerCase()} source`
      : "same source rank; the more recent source wins"
  conflicts.push({
    claimId: claim.id,
    sourceA: { id: a.source.id, says: a.judgement.sourceSays ?? a.judgement.quote ?? "states the claim" },
    sourceB: { id: b.source.id, says: b.judgement.sourceSays ?? b.judgement.quote ?? "gives a different value" },
    winnerId: winner.source.id,
    why,
  })
  return verdict(
    claim,
    {
      verdict: statesWins ? "supported" : "contradicted",
      reason: `Sources disagree; ${why}.`,
      quote: winner.judgement.quote ?? undefined,
      sourceIds: [winner.source.id],
    },
    stale
  )
}

/** Computed claims inherit: supported only if every input is supported. */
function verifyDerived(claim: Claim, results: Map<string, Verdict>): Verdict {
  const inputs = (claim.derivedFrom ?? []).map((id) => results.get(id))
  const stale = inputs.some((v) => v?.stale)
  if (inputs.some((v) => v?.verdict === "contradicted")) {
    return verdict(claim, { verdict: "contradicted", reason: "An input to this calculation is contradicted.", sourceIds: claim.sourceIds }, stale)
  }
  if (inputs.length > 0 && inputs.every((v) => v?.verdict === "supported")) {
    return verdict(claim, { verdict: "supported", reason: "Calculated in code from supported inputs.", sourceIds: claim.sourceIds }, stale)
  }
  return verdict(claim, { verdict: "unsupported", reason: "An input to this calculation is not supported.", sourceIds: claim.sourceIds }, stale)
}

function counts(verdicts: Verdict[]): VerifierOutput["counts"] {
  return {
    supported: verdicts.filter((v) => v.verdict === "supported").length,
    contradicted: verdicts.filter((v) => v.verdict === "contradicted").length,
    unsupported: verdicts.filter((v) => v.verdict === "unsupported").length,
    stale: verdicts.filter((v) => v.stale).length,
  }
}

/**
 * Claims → verdicts.
 * v2: source rules in code + LLM passage judgement with verified quotes.
 * v1: any claim citing any source (including AI overviews and the company's own site) is accepted.
 */
export async function runVerifier(input: unknown, ctx: AgentContext): Promise<VerifierOutput> {
  return runAgent({
    name: "verifier",
    promptVersion: PROMPT_VERSION,
    ctx,
    input,
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    fail: (status, reason) => ({ status, reason, verdicts: [], conflicts: [], claims: [] }),
    body: async (parsed, setAttributes) => {
      const sourcesById = new Map(parsed.sources.map((source) => [source.id, source]))
      const verdicts: Verdict[] = []
      const conflicts: Conflict[] = []

      if (ctx.version === "v1") {
        for (const claim of parsed.claims) {
          const has = claim.sourceIds.some((id) => sourcesById.has(id))
          verdicts.push({
            claimId: claim.id,
            verdict: has ? "supported" : "unsupported",
            reason: has ? "Has a source." : "The claim cites no source.",
            sourceIds: claim.sourceIds,
            stale: false,
          })
        }
      } else {
        const results = new Map<string, Verdict>()
        const direct = parsed.claims.filter((claim) => !claim.derivedFrom?.length)
        const derived = parsed.claims.filter((claim) => claim.derivedFrom?.length)
        for (const claim of direct) {
          results.set(claim.id, await verifyClaim(ctx, parsed, claim, sourcesById, conflicts))
        }
        for (const claim of derived) results.set(claim.id, verifyDerived(claim, results))
        verdicts.push(...parsed.claims.map((claim) => results.get(claim.id)!))
      }

      const summary = counts(verdicts)
      setAttributes({
        "verifier.supported": summary.supported,
        "verifier.contradicted": summary.contradicted,
        "verifier.unsupported": summary.unsupported,
        "verifier.conflicts": conflicts.length,
      })

      return {
        status: parsed.claims.length === 0 ? ("unverifiable" as const) : ("ok" as const),
        reason: parsed.claims.length === 0 ? "There were no claims to verify." : undefined,
        verdicts,
        counts: summary,
        conflicts,
        claims: [],
      }
    },
  })
}
