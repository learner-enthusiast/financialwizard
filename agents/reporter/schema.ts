import { z } from "zod"

import { OutputSchema as ExtractorOutputSchema } from "@/agents/extractor/schema"
import { OutputSchema as VerifierOutputSchema } from "@/agents/verifier/schema"
import { agentStatusSchema, claimSchema, countrySchema, entitySchema, instrumentSchema, sourceIdsSchema } from "@/agents/types"

export const DISCLAIMER = "Evidence, not advice." as const

export const InputSchema = z.object({
  entity: entitySchema,
  route: z.object({ instrument: instrumentSchema, country: countrySchema, supported: z.boolean() }),
  /** Extractor outputs, one per check. */
  findings: z.array(ExtractorOutputSchema),
  /** Every claim that went to the verifier (resolver + extractor claims). */
  claims: z.array(claimSchema),
  verifier: VerifierOutputSchema,
})
export type ReporterInput = z.infer<typeof InputSchema>

const sentenceSchema = z.object({ text: z.string().min(1), claimIds: z.array(z.string()).min(1) })

export const OutputSchema = z.object({
  status: agentStatusSchema,
  reason: z.string().optional(),
  title: z.string().default(""),
  currency: z.enum(["INR", "USD"]).default("USD"),
  redFlags: z.array(z.object({ text: z.string(), claimIds: z.array(z.string()), sourceIds: sourceIdsSchema })).default([]),
  keyNumbers: z.array(z.object({ label: z.string(), value: z.string(), claimId: z.string(), sourceIds: sourceIdsSchema.min(1) })).default([]),
  checkSummaries: z
    .array(
      z.object({
        checkId: z.string(),
        title: z.string(),
        status: z.enum(["ok", "flag", "unverifiable"]),
        sentences: z.array(sentenceSchema.extend({ sourceIds: sourceIdsSchema })),
      })
    )
    .default([]),
  /** Plain statements of what could not be verified. */
  unverifiable: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
  disclaimer: z.literal(DISCLAIMER).default(DISCLAIMER),
  /** Sentences removed by the v2 self-check (for the before/after story). */
  removedSentences: z.number().int().default(0),
  claims: z.array(claimSchema).default([]),
})
export type ReporterOutput = z.infer<typeof OutputSchema>

export const llmSummariesSchema = z.object({
  summaries: z.array(z.object({ checkId: z.string(), sentences: z.array(sentenceSchema).max(3) })),
})
export type LlmSummaries = z.infer<typeof llmSummariesSchema>
