import "server-only"

import { CHECK_SPECS } from "@/agents/extractor/checks"
import { PACKS, type CheckId } from "@/agents/packs"
import {
  DISCLAIMER,
  InputSchema,
  llmSummariesSchema,
  OutputSchema,
  type LlmSummaries,
  type ReporterInput,
  type ReporterOutput,
} from "@/agents/reporter/schema"
import { PROMPT_VERSION, SYSTEM_PROMPT } from "@/agents/reporter/prompt"
import { findAdviceTerms } from "@/agents/shared/advice"
import { currencyFor } from "@/agents/shared/format"
import { llmExtract } from "@/agents/shared/llm"
import { runAgent } from "@/agents/shared/run-agent"
import type { AgentContext, Claim } from "@/agents/types"

export { DISCLAIMER, InputSchema, OutputSchema, PROMPT_VERSION }
export type { ReporterInput, ReporterOutput }

const MAX_QUESTIONS = 8

/** Fields shown as key numbers, in display order. */
const KEY_FIELDS = [
  "priceLow",
  "priceHigh",
  "market_cap_at_high",
  "pe_at_high",
  "ps_at_high",
  "ofs_percent",
  "revenueLatest",
  "netIncomeLatest",
  "revenue_growth_pct",
  "lock_in_end_date",
  "lastRoundAmount",
  "quotedPricePerShare",
  "implied_valuation_from_quote",
  "headcount_change_pct",
  // v1 baseline only (model-stated valuation)
  "market_cap_llm",
  "pe_llm",
  "ps_llm",
]

const INSTRUMENT_LABEL: Record<string, string> = { ipo: "IPO", unlisted: "unlisted shares", listed: "listed shares", mf: "mutual fund", etf: "ETF" }

function checkTitle(checkId: string): string {
  for (const pack of PACKS) {
    const check = pack.checks.find((c) => c.id === checkId)
    if (check) return check.title
  }
  return checkId
}

function fieldLabel(checkId: string, field: string): string {
  return CHECK_SPECS[checkId as CheckId]?.fields[field]?.label ?? field
}

/** "Label: value." → ["Label", "value"] */
function splitStatement(statement: string): [string, string] {
  const i = statement.indexOf(": ")
  return i < 0 ? [statement, ""] : [statement.slice(0, i), statement.slice(i + 2).replace(/\.$/, "")]
}

function num(claim: Claim | undefined): number | undefined {
  return typeof claim?.value === "number" ? claim.value : undefined
}

// ---------------------------------------------------------------------------
// Deterministic sections
// ---------------------------------------------------------------------------

type RedFlag = ReporterOutput["redFlags"][number] & { checkId: string }

export function redFlagsFrom(claims: Claim[], input: ReporterInput, usable: Set<string>): RedFlag[] {
  const byField = new Map(claims.filter((c) => usable.has(c.id)).map((c) => [c.field, c]))
  const flags: RedFlag[] = []
  const flag = (claim: Claim, text: string) => flags.push({ checkId: claim.checkId, text, claimIds: [claim.id], sourceIds: claim.sourceIds })

  const ofs = byField.get("ofs_percent")
  if (ofs && (num(ofs) ?? 0) > 50) flag(ofs, `Most of the issue (${num(ofs)}%) is an offer for sale by existing holders, not new money for the company.`)

  const income = byField.get("netIncomeLatest")
  if (income && (num(income) ?? 0) < 0) flag(income, `The company reported a loss${income.period ? ` in ${income.period}` : ""}.`)

  const growth = byField.get("revenue_growth_pct")
  if (growth && (num(growth) ?? 0) < 0) flag(growth, `Revenue fell ${Math.abs(num(growth)!)}% versus the prior period.`)

  const cases = byField.get("pendingCasesCount")
  if (cases && (num(cases) ?? 0) > 0) flag(cases, `${num(cases)} outstanding litigation cases are disclosed.`)

  const regulatory = byField.get("regulatoryActionMentioned")
  if (regulatory?.value === true) flag(regulatory, "Regulatory action against the company is mentioned.")

  const headcount = byField.get("headcount_change_pct")
  if (headcount && (num(headcount) ?? 0) <= -10) flag(headcount, `Headcount fell ${Math.abs(num(headcount)!)}% over one year.`)

  const claimById = new Map(input.claims.map((c) => [c.id, c]))
  for (const conflict of input.verifier.conflicts) {
    const claim = claimById.get(conflict.claimId)
    if (!claim) continue
    flags.push({
      checkId: claim.checkId,
      text: `Sources disagree on ${splitStatement(claim.statement)[0].toLowerCase()}.`,
      claimIds: [claim.id],
      sourceIds: [conflict.sourceA.id, conflict.sourceB.id],
    })
  }

  for (const verdict of input.verifier.verdicts.filter((v) => v.stale && usable.has(v.claimId))) {
    const claim = claimById.get(verdict.claimId)
    if (claim) flags.push({ checkId: claim.checkId, text: `${splitStatement(claim.statement)[0]} is older than the latest reported period.`, claimIds: [claim.id], sourceIds: claim.sourceIds })
  }
  return flags
}

function keyNumbersFrom(claims: Claim[], usable: Set<string>): ReporterOutput["keyNumbers"] {
  return KEY_FIELDS.flatMap((field) => {
    const claim = claims.find((c) => c.field === field && usable.has(c.id) && c.sourceIds.length > 0)
    if (!claim) return []
    const [label, value] = splitStatement(claim.statement)
    return [{ label, value, claimId: claim.id, sourceIds: claim.sourceIds }]
  })
}

function unverifiableFrom(input: ReporterInput, usable: Set<string>): string[] {
  const out: string[] = []
  for (const finding of input.findings) {
    const checkId = finding.checkId ?? "check"
    if (finding.status !== "ok" && Object.keys(finding.fields).length === 0) {
      out.push(`${checkTitle(checkId)}: not verifiable from the sources found.`)
      continue
    }
    for (const missing of finding.missing) {
      const field = missing.split(" ")[0]!
      out.push(`${fieldLabel(checkId, field)}: not stated in the sources found.`)
    }
  }
  const claimById = new Map(input.claims.map((c) => [c.id, c]))
  for (const verdict of input.verifier.verdicts) {
    if (usable.has(verdict.claimId)) continue
    const claim = claimById.get(verdict.claimId)
    if (claim) out.push(`${splitStatement(claim.statement)[0]}: ${verdict.verdict === "contradicted" ? "sources disagree" : "could not be verified"}.`)
  }
  return [...new Set(out)]
}

function questionsFrom(input: ReporterInput, flags: RedFlag[], usable: Set<string>): string[] {
  const out: string[] = []
  const claimById = new Map(input.claims.map((c) => [c.id, c]))
  for (const conflict of input.verifier.conflicts) {
    const claim = claimById.get(conflict.claimId)
    if (claim) out.push(`Which figure is current for ${splitStatement(claim.statement)[0].toLowerCase()}, and where is it published?`)
  }
  for (const flag of flags) {
    if (flag.text.startsWith("Most of the issue")) out.push("Which existing holders are in the offer for sale, and how many shares does each offer?")
    if (flag.text.startsWith("The company reported a loss")) out.push("What is the plan and timeline to reach profit?")
    if (flag.text.includes("litigation")) out.push("Which outstanding cases could materially affect the business?")
  }
  for (const finding of input.findings) {
    for (const missing of finding.missing) {
      out.push(`Can you share the document that states the ${fieldLabel(finding.checkId ?? "", missing.split(" ")[0]!).toLowerCase()}?`)
    }
  }
  for (const verdict of input.verifier.verdicts) {
    if (usable.has(verdict.claimId)) continue
    const claim = claimById.get(verdict.claimId)
    if (claim) out.push(`Can you share an independent source for: ${splitStatement(claim.statement)[0].toLowerCase()}?`)
  }
  return [...new Set(out)].slice(0, MAX_QUESTIONS)
}

// ---------------------------------------------------------------------------
// LLM summaries + v2 self-check
// ---------------------------------------------------------------------------

const NUMBER_PATTERN = /\d[\d,]*(?:\.\d+)?/g

function numbersIn(text: string): string[] {
  return (text.match(NUMBER_PATTERN) ?? []).map((n) => n.replace(/,/g, ""))
}

/**
 * v2 self-check: keep a sentence only if every cited claim is usable (supported),
 * every number it contains appears in a cited claim, and it has no advice wording.
 */
export function sentencePasses(sentence: { text: string; claimIds: string[] }, claimsById: Map<string, Claim>, usable: Set<string>): boolean {
  if (sentence.claimIds.length === 0 || !sentence.claimIds.every((id) => usable.has(id) && claimsById.has(id))) return false
  if (findAdviceTerms(sentence.text).length > 0) return false
  const allowed = new Set(sentence.claimIds.flatMap((id) => {
    const claim = claimsById.get(id)!
    return [...numbersIn(claim.statement), ...(typeof claim.value === "number" ? [String(claim.value)] : [])]
  }))
  return numbersIn(sentence.text).every((n) => allowed.has(n))
}

async function writeSummaries(ctx: AgentContext, input: ReporterInput, claims: Claim[]): Promise<LlmSummaries | null> {
  const byCheck = new Map<string, Claim[]>()
  for (const claim of claims) byCheck.set(claim.checkId, [...(byCheck.get(claim.checkId) ?? []), claim])
  if (byCheck.size === 0) return { summaries: [] }
  const blocks = [...byCheck.entries()].map(
    ([checkId, list]) => `Check ${checkId} (${checkTitle(checkId)}):\n${list.map((c) => `[${c.id}] ${c.statement}`).join("\n")}`
  )
  return llmExtract(ctx, {
    agent: "reporter",
    promptVersion: PROMPT_VERSION,
    label: `summaries.${ctx.version}`,
    system: SYSTEM_PROMPT,
    text: `Company: ${input.entity.legalName}\nInstrument: ${INSTRUMENT_LABEL[input.route.instrument] ?? input.route.instrument} (${input.route.country})\n\nClaims by check:\n\n${blocks.join("\n\n")}`,
    schema: llmSummariesSchema,
    maxTokens: 1500,
  })
}

/**
 * Verdicts → final report.
 * v2: writes only from supported claims; a self-check removes any sentence without a matching supported claim.
 * v1: writes from every claim, no self-check.
 */
export async function runReporter(input: unknown, ctx: AgentContext): Promise<ReporterOutput> {
  return runAgent({
    name: "reporter",
    promptVersion: PROMPT_VERSION,
    ctx,
    input,
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    fail: (status, reason) => ({ status, reason, disclaimer: DISCLAIMER }),
    body: async (parsed, setAttributes) => {
      const v1 = ctx.version === "v1"
      const supported = new Set(parsed.verifier.verdicts.filter((v) => v.verdict === "supported").map((v) => v.claimId))
      const usable = v1 ? new Set(parsed.claims.map((c) => c.id)) : supported
      const usableClaims = parsed.claims.filter((c) => usable.has(c.id))
      const claimsById = new Map(parsed.claims.map((c) => [c.id, c]))
      const currency = currencyFor(parsed.entity.country)

      const flags = redFlagsFrom(parsed.claims, parsed, usable)
      const llm = await writeSummaries(ctx, parsed, usableClaims.filter((c) => c.checkId !== "resolver"))

      let removed = 0
      const checkIds = [...new Set(parsed.findings.map((f) => f.checkId).filter((id): id is string => Boolean(id)))]
      const checkSummaries = checkIds.map((checkId) => {
        const raw = llm?.summaries.find((s) => s.checkId === checkId)?.sentences ?? []
        const kept = v1 ? raw : raw.filter((sentence) => sentencePasses(sentence, claimsById, usable))
        removed += raw.length - kept.length
        const hasClaims = usableClaims.some((c) => c.checkId === checkId)
        return {
          checkId,
          title: checkTitle(checkId),
          status: flags.some((f) => f.checkId === checkId) ? ("flag" as const) : hasClaims ? ("ok" as const) : ("unverifiable" as const),
          sentences: kept.map((sentence) => ({
            ...sentence,
            sourceIds: [...new Set(sentence.claimIds.flatMap((id) => claimsById.get(id)?.sourceIds ?? []))],
          })),
        }
      })

      const keyNumbers = keyNumbersFrom(parsed.claims, usable)
      setAttributes({
        "reporter.key_numbers": keyNumbers.length,
        "reporter.red_flags": flags.length,
        "reporter.removed_sentences": removed,
        "reporter.supported_claims": supported.size,
      })

      return {
        status: usableClaims.length > 0 ? ("ok" as const) : ("unverifiable" as const),
        reason: usableClaims.length > 0 ? undefined : "No claim could be verified, so the report states only what is missing.",
        title: `${parsed.entity.legalName}: ${INSTRUMENT_LABEL[parsed.route.instrument] ?? parsed.route.instrument} research (${parsed.route.country})`,
        currency,
        redFlags: flags.map((flag) => ({ text: flag.text, claimIds: flag.claimIds, sourceIds: flag.sourceIds })),
        keyNumbers,
        checkSummaries,
        unverifiable: unverifiableFrom(parsed, usable),
        questions: questionsFrom(parsed, flags, usable),
        disclaimer: DISCLAIMER,
        removedSentences: removed,
        claims: [],
      }
    },
  })
}
