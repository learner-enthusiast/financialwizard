/*
 * Live checkpoint: runs all six agents against real clients for one India and
 * one US example, printing trimmed outputs. Needs DATABASE_URL (Source/Step/
 * CacheEntry tables migrated), an LLM key, SERPAPI_KEY, SEC_USER_AGENT and
 * optionally FIRECRAWL_API_KEY / CRUSTDATA_API_KEY / NEATLOGS_API_KEY.
 *
 *   pnpm smoke agents                                   # defaults below, v2
 *   pnpm smoke agents "Jio Platforms IPO" "Cerebras IPO" v1
 *
 * Source gathering here is deliberately minimal (not the orchestrator).
 */
import { preview } from "./_setup"

import { runExtractor, type ExtractorOutput } from "@/agents/extractor"
import type { FieldValue } from "@/agents/extractor/schema"
import { runPlanner } from "@/agents/planner"
import { runReporter } from "@/agents/reporter"
import { runResolver } from "@/agents/resolver"
import { runRouter } from "@/agents/router"
import { classifyUrl, loadSources, recordSource } from "@/agents/shared/sources"
import { createAgentContext, type AgentContext, type Claim, type Country, type Entity, type SourceRef } from "@/agents/types"
import { runVerifier } from "@/agents/verifier"
import { callTool, DEFAULT_TOOL_BUDGETS } from "@/lib/clients/callTool"
import { documentUrl, submissions } from "@/lib/clients/edgar"
import { scrapePage } from "@/lib/clients/firecrawl"
import { findDrhp } from "@/lib/clients/inFilings"
import { extractSections, sliceSections } from "@/lib/clients/pdf"
import { search } from "@/lib/clients/serp"
import { flush } from "@/lib/clients/trace"

type PlannedCheck = { id: string; title: string; tools: string[]; sectionHeadings: string[] }

async function gatherSources(ctx: AgentContext, entity: Entity, check: PlannedCheck): Promise<SourceRef[]> {
  const out: SourceRef[] = []

  if (check.tools.includes("inFilings")) {
    const buffer = await callTool(ctx, "inFilings", { legalName: entity.legalName }, (signal) => findDrhp(entity.legalName, signal))
    if (buffer) {
      const isPdf = buffer.subarray(0, 4).toString() === "%PDF"
      const text = isPdf
        ? Object.values(await extractSections(new Uint8Array(buffer), check.sectionHeadings)).join("\n\n")
        : buffer.toString("utf8")
      if (text.trim()) {
        out.push(await recordSource(ctx, { url: `${entity.filingUrl ?? "local:drhp"}#${check.id}`, kind: "PRIMARY", title: `DRHP — ${check.title}`, text }))
      }
    }
  }

  if (check.tools.includes("edgar") && entity.cik) {
    const cik = entity.cik
    const subs = (await callTool(ctx, "edgar", { submissions: cik }, (signal) => submissions(cik, signal))) as {
      filings?: { recent?: { form?: string[]; accessionNumber?: string[]; primaryDocument?: string[] } }
    } | null
    const recent = subs?.filings?.recent
    const i = recent?.form?.findIndex((form) => /^(S-1|F-1)(\/A)?$/.test(form)) ?? -1
    if (recent && i >= 0) {
      const url = documentUrl(cik, recent.accessionNumber![i]!, recent.primaryDocument![i]!)
      const md = await callTool(ctx, "firecrawl", { url }, (signal) => scrapePage(url, signal))
      if (md) {
        const text = check.sectionHeadings.length ? Object.values(sliceSections(md, check.sectionHeadings)).join("\n\n") || md : md
        out.push(await recordSource(ctx, { url: `${url}#${check.id}`, kind: "PRIMARY", title: `${recent.form![i]} — ${check.title}`, text }))
      }
    }
  }

  if (check.tools.includes("serp")) {
    const q = `${entity.legalName} ${check.title}`
    const gl = entity.country === "IN" ? "in" : "us"
    const result = await callTool(ctx, "serp", { q, gl }, (signal) => search(q, { gl, hl: "en", signal }))
    for (const row of result?.organic.slice(0, 4) ?? []) {
      if (!row.link) continue
      out.push(await recordSource(ctx, { url: row.link, kind: classifyUrl(row.link, entity.domain), title: row.title, text: [row.title, row.snippet].filter(Boolean).join(" — ") }))
    }
  }
  return out
}

async function runExample(query: string, country: Country, version: "v1" | "v2") {
  const ctx = createAgentContext({ runId: `live-${country}-${Date.now()}`, version, country, budget: { ...DEFAULT_TOOL_BUDGETS } })
  console.log(`\n\n################ ${country}: "${query}" (${version}, run ${ctx.runId}) ################`)

  const resolved = await runResolver({ query, countryHint: country }, ctx)
  preview("resolver", { status: resolved.status, reason: resolved.reason, needsUserChoice: resolved.needsUserChoice, question: resolved.question, candidates: resolved.candidates.map((c) => ({ legalName: c.legalName, status: c.status, domain: c.domain, symbols: c.symbols, cik: c.cik, confidence: c.confidence })) })
  const picked = resolved.entity ?? resolved.candidates[0]
  if (!picked) return
  if (!resolved.entity) console.log("(ambiguous — continuing with the top candidate for this live check)")
  const entity: Entity = { legalName: picked.legalName, country: picked.country, status: picked.status, domain: picked.domain, symbols: picked.symbols, cik: picked.cik, filingUrl: picked.filingUrl, sourceIds: picked.sourceIds }
  ctx.trace.instrument = "pending"

  const route = await runRouter({ entity, query }, ctx)
  preview("router", route)
  if (!route.supported || !route.instrument || !route.country) return
  ctx.trace.instrument = route.instrument

  const plan = await runPlanner({ route: { instrument: route.instrument, country: route.country, supported: route.supported }, entity }, ctx)
  preview("planner", { status: plan.status, packId: plan.packId, checks: plan.checks.map((c) => c.id), skipped: plan.skipped, declaredIntent: plan.declaredIntent })

  const findings: ExtractorOutput[] = []
  let priorFields: Record<string, FieldValue> = {}
  for (const check of plan.checks) {
    const sources = await gatherSources(ctx, entity, check)
    const finding = await runExtractor({ checkId: check.id, entity, sources, priorFields }, ctx)
    findings.push(finding)
    priorFields = { ...priorFields, ...finding.fields }
    preview(`extractor ${check.id}`, { status: finding.status, reason: finding.reason, fields: Object.fromEntries(Object.entries(finding.fields).map(([k, v]) => [k, v.value])), computed: finding.computed.map((c) => `${c.metric}=${c.value} (${c.origin})`), missing: finding.missing })
  }

  const claims: Claim[] = [...resolved.claims, ...findings.flatMap((f) => f.claims)]
  const sources = await loadSources(ctx, claims.flatMap((claim) => claim.sourceIds))
  const verdicts = await runVerifier({ entity, claims, sources }, ctx)
  preview("verifier", { status: verdicts.status, counts: verdicts.counts, conflicts: verdicts.conflicts })

  const report = await runReporter({ entity, route: { instrument: route.instrument, country: route.country, supported: true }, findings, claims, verifier: verdicts }, ctx)
  preview("reporter", report, 4000)
}

async function main() {
  const [inQuery = "Jio Platforms IPO", usQuery = "Cerebras Systems IPO", version = "v2"] = process.argv.slice(2)
  if (version !== "v1" && version !== "v2") throw new Error("version must be v1 or v2")
  try {
    await runExample(inQuery, "IN", version)
    await runExample(usQuery, "US", version)
  } finally {
    console.log(`\nflushed spans to neatlogs: ${await flush()}`)
  }
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
