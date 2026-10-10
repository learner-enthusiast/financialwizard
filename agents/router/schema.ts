import { z } from "zod"

import { agentStatusSchema, claimSchema, countrySchema, entitySchema, instrumentSchema } from "@/agents/types"

export const InputSchema = z.object({
  entity: entitySchema,
  /** The user's original words; used for instrument hints such as "IPO" or "ETF". */
  query: z.string().trim().min(1).max(200),
})
export type RouterInput = z.infer<typeof InputSchema>

export const OutputSchema = z.object({
  status: agentStatusSchema,
  reason: z.string().min(1),
  instrument: instrumentSchema.optional(),
  country: countrySchema.optional(),
  supported: z.boolean().default(false),
  /** "rules" when deterministic; "llm" when the query and entity status conflicted. */
  basis: z.enum(["rules", "llm"]).default("rules"),
  claims: z.array(claimSchema).default([]),
})
export type RouterOutput = z.infer<typeof OutputSchema>

export const llmRouteSchema = z.object({
  instrument: instrumentSchema,
  reason: z.string().min(1).max(200),
})
