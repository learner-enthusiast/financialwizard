import "server-only"

import { findPack, requirementState, type CheckDef, type Requirement } from "@/agents/packs"
import { llmExtract } from "@/agents/shared/llm"
import { runAgent } from "@/agents/shared/run-agent"
import {
  InputSchema,
  llmSkipSchema,
  OutputSchema,
  type PlannerInput,
  type PlannerOutput,
} from "@/agents/planner/schema"
import { PROMPT_VERSION, SYSTEM_PROMPT } from "@/agents/planner/prompt"
import type { AgentContext, Entity } from "@/agents/types"

export { InputSchema, OutputSchema, PROMPT_VERSION }
export type { PlannerInput, PlannerOutput }

const REQUIREMENT_LABEL: Record<Requirement, string> = {
  filing: "an offer document (DRHP / S-1) link",
  cik: "an SEC CIK",
  domain: "the company's website domain",
}

type Partitioned = {
  planned: CheckDef[]
  ruleSkips: PlannerOutput["skipped"]
  uncertain: Array<{ check: CheckDef; unknown: Requirement[] }>
}

/** Pure: split pack checks into planned, skipped-by-rule and uncertain. */
export function partitionChecks(checks: CheckDef[], entity: Entity): Partitioned {
  const out: Partitioned = { planned: [], ruleSkips: [], uncertain: [] }
  for (const check of checks) {
    const states = (check.requires ?? []).map((req) => [req, requirementState(req, entity)] as const)
    const missing = states.filter(([, state]) => state === false).map(([req]) => req)
    const unknown = states.filter(([, state]) => state === undefined).map(([req]) => req)
    if (missing.length > 0) {
      out.ruleSkips.push({
        id: check.id,
        basis: "rules",
        reason: `Needs ${missing.map((req) => REQUIREMENT_LABEL[req]).join(" and ")}, which this company does not have.`,
      })
    } else if (unknown.length > 0) {
      out.uncertain.push({ check, unknown })
    } else {
      out.planned.push(check)
    }
  }
  return out
}

function describeEntity(entity: Entity): string {
  return [
    `legal name: ${entity.legalName}`,
    `country: ${entity.country}`,
    `listing status: ${entity.status}`,
    `website domain: ${entity.domain ?? "unknown"}`,
    `offer document link: ${entity.filingUrl ?? "unknown"}`,
    `SEC CIK: ${entity.cik ?? "unknown"}`,
  ].join("\n")
}

/** Router output + entity → ordered checks from the country pack, plus declared tool intent. */
export async function runPlanner(input: unknown, ctx: AgentContext): Promise<PlannerOutput> {
  return runAgent({
    name: "planner",
    promptVersion: PROMPT_VERSION,
    ctx,
    input,
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    fail: (status, reason) => ({ status, reason, checks: [], skipped: [], declaredIntent: [], claims: [] }),
    body: async ({ route, entity }, setAttributes) => {
      const pack = route.supported ? findPack(route.country, route.instrument) : undefined
      if (!pack) {
        return {
          status: "unverifiable" as const,
          reason: `No research checklist for ${route.country} ${route.instrument} in this build.`,
          checks: [],
          skipped: [],
          declaredIntent: [],
          claims: [],
        }
      }

      const { planned, ruleSkips, uncertain } = partitionChecks(pack.checks, entity)
      const llmSkips: PlannerOutput["skipped"] = []

      if (uncertain.length > 0) {
        const list = uncertain
          .map(({ check, unknown }) => `- ${check.id}: ${check.title} (needs ${unknown.map((req) => REQUIREMENT_LABEL[req]).join(", ")})`)
          .join("\n")
        const decision = await llmExtract(ctx, {
          agent: "planner",
          promptVersion: PROMPT_VERSION,
          label: "skip",
          system: SYSTEM_PROMPT,
          text: `Company:\n${describeEntity(entity)}\n\nUncertain checks:\n${list}`,
          schema: llmSkipSchema,
          maxTokens: 500,
        })
        const allowed = new Set(uncertain.map(({ check }) => check.id))
        for (const item of decision?.skip ?? []) {
          if (allowed.has(item.checkId as CheckDef["id"]) && !llmSkips.some((s) => s.id === item.checkId)) {
            llmSkips.push({ id: item.checkId as CheckDef["id"], reason: item.reason, basis: "llm" })
          }
        }
      }

      // Keep pack order: uncertain checks that were not skipped stay in place.
      const skippedIds = new Set([...ruleSkips, ...llmSkips].map((s) => s.id))
      const checks = pack.checks
        .filter((check) => !skippedIds.has(check.id) && (planned.includes(check) || uncertain.some((u) => u.check === check)))
        .map((check) => ({ id: check.id, title: check.title, tools: check.tools, sectionHeadings: check.sectionHeadings ?? [] }))
      const declaredIntent = [...new Set(checks.flatMap((check) => check.tools))]

      setAttributes({
        "planner.pack": pack.id,
        "planner.checks": checks.length,
        "planner.skipped": skippedIds.size,
        "planner.declared_intent": declaredIntent.join(","),
      })

      return {
        status: checks.length > 0 ? ("ok" as const) : ("unverifiable" as const),
        reason: checks.length > 0 ? undefined : "Every check in the checklist needs facts this company does not have.",
        packId: pack.id,
        checks,
        skipped: [...ruleSkips, ...llmSkips],
        declaredIntent,
        claims: [],
      }
    },
  })
}
