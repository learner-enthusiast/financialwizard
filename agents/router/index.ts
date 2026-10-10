import "server-only"

import { findPack } from "@/agents/packs"
import { detectIntent } from "@/agents/shared/intent"
import { llmExtract } from "@/agents/shared/llm"
import { runAgent } from "@/agents/shared/run-agent"
import { InputSchema, llmRouteSchema, OutputSchema, type RouterInput, type RouterOutput } from "@/agents/router/schema"
import { PROMPT_VERSION, SYSTEM_PROMPT } from "@/agents/router/prompt"
import type { AgentContext, Country, Entity, Instrument } from "@/agents/types"

export { InputSchema, OutputSchema, PROMPT_VERSION }
export type { RouterInput, RouterOutput }

const FUND_WORDS = /\b(mutual funds?|mf|fund scheme|sip|nav)\b/i
const ETF_WORDS = /\b(etfs?|exchange[- ]traded)\b/i

/** Instrument implied by the verified listing status alone. */
function fromStatus(entity: Entity, query: string): Instrument {
  if (entity.status === "ipo_filed") return "ipo"
  if (entity.status === "unlisted") return detectIntent(query) === "ipo" ? "ipo" : "unlisted"
  return "listed"
}

/** Query wording that names a specific instrument, if any. */
function fromQuery(query: string): Instrument | undefined {
  if (ETF_WORDS.test(query)) return "etf"
  if (FUND_WORDS.test(query)) return "mf"
  if (detectIntent(query) === "ipo") return "ipo"
  return undefined
}

/**
 * Deterministic route, or undefined when the query and status genuinely
 * conflict (e.g. "IPO" for an already-listed company, "ETF" for a private one).
 */
export function routeByRules(entity: Entity, query: string): { instrument: Instrument; reason: string } | undefined {
  const status = fromStatus(entity, query)
  const hinted = fromQuery(query)
  if (!hinted || hinted === status) {
    return { instrument: status, reason: `Listing status is ${entity.status.replace("_", " ")}.` }
  }
  if (hinted === "ipo" && status === "unlisted") return { instrument: "ipo", reason: "Unlisted company and the query asks about an IPO." }
  return undefined
}

export function supportFor(country: Country, instrument: Instrument): { supported: boolean; reason?: string } {
  if (findPack(country, instrument)) return { supported: true }
  return {
    supported: false,
    reason: `${country} ${instrument} research is not supported in this build (supported: IN ipo, IN unlisted, US ipo).`,
  }
}

/** Entity + query → instrument, country and whether this build can research it. */
export async function runRouter(input: unknown, ctx: AgentContext): Promise<RouterOutput> {
  return runAgent({
    name: "router",
    promptVersion: PROMPT_VERSION,
    ctx,
    input,
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    fail: (status, reason) => ({ status, reason, supported: false, claims: [] }),
    body: async ({ entity, query }, setAttributes) => {
      let route = routeByRules(entity, query)
      let basis: RouterOutput["basis"] = "rules"

      if (!route) {
        const llm = await llmExtract(ctx, {
          agent: "router",
          promptVersion: PROMPT_VERSION,
          label: "instrument",
          system: SYSTEM_PROMPT,
          text: `Query: "${query}"\nCompany: ${entity.legalName}; country ${entity.country}; status ${entity.status}; symbols ${entity.symbols.join(", ") || "none"}`,
          schema: llmRouteSchema,
          maxTokens: 300,
        })
        basis = "llm"
        route = llm ?? { instrument: fromStatus(entity, query), reason: `Query wording was unclear; used listing status (${entity.status.replace("_", " ")}).` }
      }

      const support = supportFor(entity.country, route.instrument)
      setAttributes({ "router.instrument": route.instrument, "router.country": entity.country, "router.supported": support.supported, "router.basis": basis })

      return {
        status: "ok" as const,
        reason: support.reason ?? route.reason,
        instrument: route.instrument,
        country: entity.country,
        supported: support.supported,
        basis,
        claims: [],
      }
    },
  })
}
