import { z } from "zod"

import { agentStatusSchema, claimSchema, entitySchema, sourceRefSchema } from "@/agents/types"

export const InputSchema = z.object({
  entity: entitySchema,
  claims: z.array(claimSchema),
  sources: z.array(sourceRefSchema),
  /** Latest reported period known for the company (e.g. "FY2025"); older figures are stale. */
  latestReportedPeriod: z.string().optional(),
})
export type VerifierInput = z.infer<typeof InputSchema>

export const verdictSchema = z.object({
  claimId: z.string(),
  verdict: z.enum(["supported", "contradicted", "unsupported"]),
  reason: z.string().min(1),
  /** Verbatim span from the deciding source. */
  quote: z.string().optional(),
  /** Sources that decided the verdict. */
  sourceIds: z.array(z.string()).default([]),
  stale: z.boolean().default(false),
})
export type Verdict = z.infer<typeof verdictSchema>

export const conflictSchema = z.object({
  claimId: z.string(),
  sourceA: z.object({ id: z.string(), says: z.string() }),
  sourceB: z.object({ id: z.string(), says: z.string() }),
  winnerId: z.string(),
  why: z.string(),
})
export type Conflict = z.infer<typeof conflictSchema>

export const OutputSchema = z.object({
  status: agentStatusSchema,
  reason: z.string().optional(),
  verdicts: z.array(verdictSchema).default([]),
  counts: z
    .object({ supported: z.number().int(), contradicted: z.number().int(), unsupported: z.number().int(), stale: z.number().int() })
    .default({ supported: 0, contradicted: 0, unsupported: 0, stale: 0 }),
  conflicts: z.array(conflictSchema).default([]),
  claims: z.array(claimSchema).default([]),
})
export type VerifierOutput = z.infer<typeof OutputSchema>

export const llmJudgementSchema = z.object({
  judgements: z.array(
    z.object({
      sourceId: z.string(),
      stance: z.enum(["states", "contradicts", "silent"]),
      quote: z.string().nullable(),
      sourceSays: z.string().max(200).nullable(),
    })
  ),
})
export type LlmJudgement = z.infer<typeof llmJudgementSchema>["judgements"][number]
