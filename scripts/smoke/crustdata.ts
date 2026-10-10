/*
 * Smoke: free calls first (permissions, credits, identify IN + US), then ONE enrich.
 * Prints credits before/after. All calls go through callTool (Step rows record X-Credits-Used).
 */
import { preview } from "./_setup"
import { smokeRun } from "./_run"

import { callTool } from "@/lib/clients/callTool"
import { enrichCompany, getCredits, getEndpointPermissions, identifyCompany } from "@/lib/clients/crustdata"

const ENDPOINTS = ["/company/identify", "/company/enrich", "/company/search", "/job/search"]

async function main() {
  if (!process.env.CRUSTDATA_API_KEY) throw new Error("CRUSTDATA_API_KEY is not set (.env.local)")
  const run = smokeRun("smoke-crustdata")
  const fresh = { skipCache: true }

  const permissions = await callTool(run, "crustdata", { op: "endpoints" }, (signal, report) => getEndpointPermissions({ signal, onUsage: report }), fresh)
  preview(
    "endpoint permissions (relevant)",
    permissions?.endpoints
      .filter((e) => ENDPOINTS.includes(e.path))
      .map((e) => ({ path: e.path, status: e.status, rpm: e.effective_rate_limit_rpm, baseCredits: e.base_credits, disabledFields: e.fields.disabled.slice(0, 5) }))
  )

  const before = await callTool(run, "crustdata", { op: "credits", t: "before" }, (signal, report) => getCredits({ signal, onUsage: report }), fresh)
  preview("credits before", before?.credits)

  for (const target of [{ domain: "zomato.com" }, { domain: "stripe.com" }]) {
    const matches = await callTool(run, "crustdata", { op: "identify", target }, (signal, report) => identifyCompany(target, { signal, onUsage: report }), fresh)
    preview(`identify ${target.domain}`, matches?.slice(0, 2).map((m) => ({ score: m.confidenceScore, ...m.company.basic_info })))
  }

  const enriched = await callTool(
    run,
    "crustdata",
    { op: "enrich", target: { domain: "stripe.com" }, fields: ["basic_info", "headcount", "funding"] },
    (signal, report) => enrichCompany({ domain: "stripe.com" }, ["basic_info", "headcount", "funding"], { signal, onUsage: report }),
    fresh
  )
  const company = enriched?.[0]?.company
  preview("enrich stripe.com (trimmed)", company && {
    name: company.basic_info?.name,
    headcount: company.headcount?.total,
    lastRound: company.funding?.last_round_type,
    lastRoundUsd: company.funding?.last_round_amount_usd,
  })

  const after = await callTool(run, "crustdata", { op: "credits", t: "after" }, (signal, report) => getCredits({ signal, onUsage: report }), fresh)
  preview("credits after", after?.credits)
  if (before && after) preview("credits spent", Math.round((before.credits - after.credits) * 100) / 100)
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
