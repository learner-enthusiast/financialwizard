import { z } from "zod"

import { checkIdSchema } from "@/agents/planner/schema"
import { CHECK_SPECS, SCALE_MULTIPLIER, type FieldKind } from "@/agents/extractor/checks"
import { agentStatusSchema, claimSchema, entitySchema, sourceIdsSchema, sourceRefSchema } from "@/agents/types"
import type { CheckId } from "@/agents/packs"

const fieldKinds = ["money", "per_share", "count", "days", "year", "date", "boolean", "text"] as const satisfies readonly FieldKind[]

/** One extracted (or code-computed) value with its evidence. */
export const fieldValueSchema = z.object({
  value: z.union([z.number(), z.string(), z.boolean()]),
  kind: z.enum(fieldKinds),
  currency: z.enum(["INR", "USD"]).optional(),
  period: z.string().optional(),
  claimId: z.string().min(1),
  sourceIds: sourceIdsSchema.min(1),
})
export type FieldValue = z.infer<typeof fieldValueSchema>

export const computedValueSchema = z.object({
  metric: z.string().min(1),
  value: z.union([z.number(), z.string()]),
  unit: z.enum(["currency", "ratio", "percent", "date"]),
  formula: z.string(),
  /** "code" = compute/ (v2). "llm" = stated by the model (v1 baseline only). */
  origin: z.enum(["code", "llm"]),
  claimId: z.string().min(1),
  sourceIds: sourceIdsSchema.min(1),
})
export type ComputedEntry = z.infer<typeof computedValueSchema>

export const InputSchema = z.object({
  checkId: checkIdSchema,
  entity: entitySchema,
  /** Already-stored Source rows for this check. */
  sources: z.array(sourceRefSchema),
  /** Fields extracted by earlier checks in this run (for cross-check computations). */
  priorFields: z.record(z.string(), fieldValueSchema).default({}),
})
export type ExtractorInput = z.infer<typeof InputSchema>

export const OutputSchema = z.object({
  status: agentStatusSchema,
  reason: z.string().optional(),
  checkId: z.string().optional(),
  fields: z.record(z.string(), fieldValueSchema).default({}),
  computed: z.array(computedValueSchema).default([]),
  /** Field names the sources did not support. */
  missing: z.array(z.string()).default([]),
  claims: z.array(claimSchema).default([]),
})
export type ExtractorOutput = z.infer<typeof OutputSchema>

const llmFieldSchema = z.object({
  value: z.union([z.number(), z.string(), z.boolean()]).nullable(),
  /** Scale word printed next to the number in the source ("crore", "million"...). */
  scale: z.enum(Object.keys(SCALE_MULTIPLIER) as [keyof typeof SCALE_MULTIPLIER, ...(keyof typeof SCALE_MULTIPLIER)[]]).nullable(),
  currency: z.enum(["INR", "USD"]).nullable(),
  period: z.string().nullable(),
  /** Verbatim span from the source that states the value. */
  quote: z.string().nullable(),
  sourceIds: z.array(z.string()),
})
export type LlmField = z.infer<typeof llmFieldSchema>

/** v1 only: the naive baseline lets the model state valuation numbers. */
const llmValuationSchema = z.object({
  marketCap: z.number().nullable(),
  peRatio: z.number().nullable(),
  psRatio: z.number().nullable(),
  sourceIds: z.array(z.string()),
})
export type LlmValuation = z.infer<typeof llmValuationSchema>

export function llmSchemaFor(checkId: CheckId, version: "v1" | "v2") {
  const shape = Object.fromEntries(Object.keys(CHECK_SPECS[checkId].fields).map((name) => [name, llmFieldSchema]))
  const fields = z.object(shape)
  return version === "v1"
    ? z.object({ fields, valuation: llmValuationSchema })
    : z.object({ fields })
}
