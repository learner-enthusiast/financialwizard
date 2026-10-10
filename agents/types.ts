/**
 * Shared agent types. Zod schemas are the single source of truth; TS types
 * are inferred from them. Agent-specific schemas live in agents/<name>/schema.ts.
 */
import { z } from "zod"

/** Tools that consume a per-run call budget (see lib/clients/callTool.ts). */
export type BudgetedTool = "crustdata" | "serp" | "firecrawl"

/** Remaining calls per tool for the current run. */
export type ToolBudget = Partial<Record<BudgetedTool, number>>

export const runVersionSchema = z.enum(["v1", "v2"])
/** v1 = intentionally naive baseline ("before"); v2 = the fix ("after"). */
export type RunVersion = z.infer<typeof runVersionSchema>

/** Tags attached to every trace span of a run. */
export type RunTags = {
  version: RunVersion
  country: string
  instrument: string
}

export type AgentContext = {
  runId: string
  /** Behaviour switch for every agent. Always equal to `trace.version`. */
  version: RunVersion
  budget: ToolBudget
  trace: RunTags
}

export const countrySchema = z.enum(["IN", "US", "OTHER"])
export type Country = z.infer<typeof countrySchema>

export const entityStatusSchema = z.enum(["unlisted", "ipo_filed", "listed"])
export type EntityStatus = z.infer<typeof entityStatusSchema>

export const instrumentSchema = z.enum(["ipo", "unlisted", "listed", "mf", "etf"])
export type Instrument = z.infer<typeof instrumentSchema>

/** Outcome of an agent. Agents never throw; failures are reported here. */
export const agentStatusSchema = z.enum(["ok", "unverifiable", "failed"])
export type AgentStatus = z.infer<typeof agentStatusSchema>

export const sourceIdsSchema = z.array(z.string().min(1))

/** The resolved company. Produced by the resolver, consumed by every later agent. */
export const entitySchema = z.object({
  legalName: z.string().min(1),
  country: countrySchema,
  status: entityStatusSchema,
  domain: z.string().min(1).optional(),
  /** Exchange symbols, e.g. "NSE:JIOFIN", "NASDAQ:AAPL". */
  symbols: z.array(z.string().min(1)).default([]),
  /** SEC CIK, 10 digits. */
  cik: z.string().regex(/^\d{10}$/).optional(),
  filingUrl: z.url().optional(),
  sourceIds: sourceIdsSchema,
})
export type Entity = z.infer<typeof entitySchema>

/** A single factual statement. Every claim cites stored Source rows. */
export const claimSchema = z.object({
  id: z.string().min(1),
  /** Check that produced it ("resolver" for identity claims). */
  checkId: z.string().min(1),
  field: z.string().min(1),
  statement: z.string().min(1),
  value: z.union([z.number(), z.string(), z.boolean()]).nullable().optional(),
  unit: z.string().optional(),
  /** Reporting period the value refers to, e.g. "FY2024". */
  period: z.string().optional(),
  sourceIds: sourceIdsSchema,
  /** For computed values: the claim ids of the inputs (verified transitively). */
  derivedFrom: z.array(z.string().min(1)).optional(),
})
export type Claim = z.infer<typeof claimSchema>

export const sourceKindSchema = z.enum(["PRIMARY", "REGULATOR", "COMPANY", "REFERENCE", "NEWS", "AI_OVERVIEW"])
export type SourceKind = z.infer<typeof sourceKindSchema>

/** A stored Source row as agents see it. */
export const sourceRefSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  kind: sourceKindSchema,
  title: z.string().optional(),
  publisher: z.string().optional(),
  text: z.string(),
  contentHash: z.string().min(1),
  publishedAt: z.string().optional(),
})
export type SourceRef = z.infer<typeof sourceRefSchema>

export function createAgentContext(input: {
  runId: string
  version: RunVersion
  country?: string
  instrument?: string
  budget?: ToolBudget
}): AgentContext {
  return {
    runId: input.runId,
    version: input.version,
    budget: input.budget ?? {},
    trace: { version: input.version, country: input.country ?? "unknown", instrument: input.instrument ?? "unknown" },
  }
}
