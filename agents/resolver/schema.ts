import { z } from "zod"

import {
  agentStatusSchema,
  claimSchema,
  countrySchema,
  entitySchema,
  entityStatusSchema,
  sourceIdsSchema,
} from "@/agents/types"

export const InputSchema = z.object({
  /** Free text from the user, e.g. "Jio IPO" or "Apple". */
  query: z.string().trim().min(1).max(200),
  countryHint: countrySchema.optional(),
})
export type ResolverInput = z.infer<typeof InputSchema>

export const intentSchema = z.enum(["ipo", "any"])
export type Intent = z.infer<typeof intentSchema>

export const candidateSchema = entitySchema.extend({
  confidence: z.number().min(0).max(1),
  sourceIds: sourceIdsSchema.min(1),
})
export type Candidate = z.infer<typeof candidateSchema>

export const OutputSchema = z.object({
  status: agentStatusSchema,
  reason: z.string().optional(),
  intent: intentSchema.default("any"),
  /** Ranked best first; at most 5. */
  candidates: z.array(candidateSchema).max(5).default([]),
  /** Set only when the match is decisive (needsUserChoice = false). */
  entity: entitySchema.optional(),
  needsUserChoice: z.boolean().default(false),
  question: z.string().optional(),
  claims: z.array(claimSchema).default([]),
})
export type ResolverOutput = z.infer<typeof OutputSchema>

/**
 * What the LLM may return when reading search results. It cannot return a
 * ticker or CIK, and any domain it returns is checked against the cited results.
 */
export const llmCandidatesSchema = z.object({
  candidates: z
    .array(
      z.object({
        legalName: z.string().min(1),
        domain: z.string().nullable(),
        country: countrySchema.nullable(),
        status: entityStatusSchema.nullable(),
        matchesQuery: z.enum(["exact", "partial"]),
        resultIndexes: z.array(z.number().int().min(0)),
      })
    )
    .max(5),
})
export type LlmCandidates = z.infer<typeof llmCandidatesSchema>
