/**
 * Shared agent types. Scaffold only: shapes are intentionally minimal and
 * will be refined when agent logic is written.
 */

/** Tools that consume a per-run call budget (see lib/clients/callTool.ts). */
export type BudgetedTool = "crustdata" | "serp" | "firecrawl"

/** Remaining calls per tool for the current run. */
export type ToolBudget = Partial<Record<BudgetedTool, number>>

/** Tags attached to every trace span of a run. */
export type RunTags = {
  version: "v1" | "v2"
  country: string
  instrument: string
}

/** The company/instrument a run is researching. */
export type Entity = {
  name: string
  country?: string
  domain?: string
  ticker?: string
}

export type AgentContext = {
  runId: string
  entity: Entity
  budget: ToolBudget
  trace: RunTags
}

/** A single sourced statement produced by an agent. */
export type Claim = {
  statement: string
  sourceUrl?: string
}

export type AgentResult<T> = {
  status: "ok" | "unverifiable" | "failed"
  data?: T
  claims: Claim[]
}
