import { z } from "zod"

import { CHECK_IDS } from "@/agents/packs"
import { agentStatusSchema, claimSchema, countrySchema, entitySchema, instrumentSchema } from "@/agents/types"

export const checkIdSchema = z.enum(CHECK_IDS)

/** Tool names a check may call (mirrors CallToolName). */
export const toolNameSchema = z.enum(["crustdata", "serp", "firecrawl", "edgar", "llm", "wikidata", "inFilings", "pdf"])

export const InputSchema = z.object({
  route: z.object({ instrument: instrumentSchema, country: countrySchema, supported: z.boolean() }),
  entity: entitySchema,
})
export type PlannerInput = z.infer<typeof InputSchema>

export const plannedCheckSchema = z.object({
  id: checkIdSchema,
  title: z.string(),
  tools: z.array(toolNameSchema).min(1),
  sectionHeadings: z.array(z.string()).default([]),
})

export const skippedCheckSchema = z.object({
  id: checkIdSchema,
  reason: z.string().min(1),
  basis: z.enum(["rules", "llm"]),
})

export const OutputSchema = z.object({
  status: agentStatusSchema,
  reason: z.string().optional(),
  packId: z.enum(["in-ipo", "in-unlisted", "us-ipo"]).optional(),
  /** Checks to run, in order. */
  checks: z.array(plannedCheckSchema).default([]),
  skipped: z.array(skippedCheckSchema).default([]),
  /** Union of tools the planned checks will use (for ArmorIQ). */
  declaredIntent: z.array(toolNameSchema).default([]),
  claims: z.array(claimSchema).default([]),
})
export type PlannerOutput = z.infer<typeof OutputSchema>

export const llmSkipSchema = z.object({
  skip: z.array(z.object({ checkId: z.string(), reason: z.string().min(1).max(200) })),
})
