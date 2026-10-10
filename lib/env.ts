import "server-only"

import { z } from "zod"

/*
 * Server environment, validated with Zod and grouped by concern so each
 * consumer only requires the variables it actually uses (e.g. the web app does
 * not need vendor keys; a vendor client does not need Clerk). Every accessor
 * validates lazily on first use and fails fast with variable NAMES only —
 * values are never included in errors or logs.
 */

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const

const nonEmpty = z.string().trim().min(1)

function parseGroup<S extends z.ZodType>(group: string, schema: S): z.infer<S> {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "(root)"))]
    throw new Error(`[env:${group}] invalid or missing environment variables: ${names.join(", ")}`)
  }
  return result.data
}

function memo<T>(fn: () => T): () => T {
  let cached: { value: T } | undefined
  return () => (cached ??= { value: fn() }).value
}

// ---------------------------------------------------------------------------
// Web app (Next.js server, Prisma, Clerk)
// ---------------------------------------------------------------------------

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  CLERK_SECRET_KEY: nonEmpty,
  CLERK_WEBHOOK_SIGNING_SECRET: nonEmpty.optional(),
})
export type ServerEnv = z.infer<typeof serverEnvSchema>

export const getServerEnv = memo(() => parseGroup("server", serverEnvSchema))

/** Database only — for scripts and workers that do not run Clerk. */
export const getDatabaseEnv = memo(() =>
  parseGroup("database", z.object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) }))
)

// ---------------------------------------------------------------------------
// Tracing (neatlogs) — https://docs.neatlogs.com/sdk/typescript
// ---------------------------------------------------------------------------

export const getTracingEnv = memo(() =>
  parseGroup(
    "tracing",
    z.object({
      NEATLOGS_API_KEY: nonEmpty.optional(),
    })
  )
)

// ---------------------------------------------------------------------------
// LLM — provider-specific keys (only active provider is required)
// ---------------------------------------------------------------------------

const llmProviderSchema = z.enum(["anthropic", "openai", "bedrock"])

export const getLlmEnv = memo(() => {
  const base = parseGroup(
    "llm",
    z.object({
      LLM_PROVIDER: llmProviderSchema.default("anthropic"),
      ANTHROPIC_API_KEY: nonEmpty.optional(),
      ANTHROPIC_MODEL: nonEmpty.optional(),
      OPENAI_API_KEY: nonEmpty.optional(),
      OPENAI_MODEL: nonEmpty.optional(),
      AWS_REGION: nonEmpty.optional(),
      AWS_ACCESS_KEY_ID: nonEmpty.optional(),
      AWS_SECRET_ACCESS_KEY: nonEmpty.optional(),
      BEDROCK_MODEL_ID: nonEmpty.optional(),
    })
  )

  if (base.LLM_PROVIDER === "anthropic") {
    const missing: string[] = []
    if (!base.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY")
    if (!base.ANTHROPIC_MODEL) missing.push("ANTHROPIC_MODEL")
    if (missing.length) throw new Error(`[env:llm] invalid or missing environment variables: ${missing.join(", ")}`)
  }
  if (base.LLM_PROVIDER === "openai") {
    const missing: string[] = []
    if (!base.OPENAI_API_KEY) missing.push("OPENAI_API_KEY")
    if (!base.OPENAI_MODEL) missing.push("OPENAI_MODEL")
    if (missing.length) throw new Error(`[env:llm] invalid or missing environment variables: ${missing.join(", ")}`)
  }
  if (base.LLM_PROVIDER === "bedrock") {
    const missing: string[] = []
    if (!base.AWS_REGION) missing.push("AWS_REGION")
    if (!base.BEDROCK_MODEL_ID) missing.push("BEDROCK_MODEL_ID")
    if (missing.length) throw new Error(`[env:llm] invalid or missing environment variables: ${missing.join(", ")}`)
  }

  return base
})

// ---------------------------------------------------------------------------
// Vendor clients (optional until smoke / feature use)
// ---------------------------------------------------------------------------

export const getSerpEnv = memo(() =>
  parseGroup("serp", z.object({ SERPAPI_KEY: nonEmpty.optional() }))
)

export const getCrustdataEnv = memo(() =>
  parseGroup("crustdata", z.object({ CRUSTDATA_API_KEY: nonEmpty.optional() }))
)

export const getFirecrawlEnv = memo(() =>
  parseGroup("firecrawl", z.object({ FIRECRAWL_API_KEY: nonEmpty.optional() }))
)

export const getEdgarEnv = memo(() =>
  parseGroup("edgar", z.object({ SEC_USER_AGENT: nonEmpty.optional() }))
)

export const getArmoriqEnv = memo(() =>
  parseGroup("armoriq", z.object({ ARMORIQ_API_KEY: nonEmpty.optional() }))
)

// ---------------------------------------------------------------------------
// Job runners
// ---------------------------------------------------------------------------

const jobRunnerSchema = z.enum(["inngest", "render"])

export const getJobsEnv = memo(() => {
  const base = parseGroup(
    "jobs",
    z.object({
      JOB_RUNNER: jobRunnerSchema.default("inngest"),
      INNGEST_EVENT_KEY: nonEmpty.optional(),
      INNGEST_SIGNING_KEY: nonEmpty.optional(),
      INNGEST_DEV: z
        .string()
        .optional()
        .transform((v) => v === "1" || v === "true"),
      RENDER_API_KEY: nonEmpty.optional(),
      RENDER_WORKFLOW_NAME: nonEmpty.optional(),
    })
  )

  if (base.JOB_RUNNER === "inngest" && process.env.NODE_ENV === "production") {
    const missing: string[] = []
    if (!base.INNGEST_SIGNING_KEY) missing.push("INNGEST_SIGNING_KEY")
    if (missing.length) throw new Error(`[env:jobs] invalid or missing environment variables: ${missing.join(", ")}`)
  }
  if (base.JOB_RUNNER === "render") {
    const missing: string[] = []
    if (!base.RENDER_API_KEY) missing.push("RENDER_API_KEY")
    if (!base.RENDER_WORKFLOW_NAME) missing.push("RENDER_WORKFLOW_NAME")
    if (missing.length) throw new Error(`[env:jobs] invalid or missing environment variables: ${missing.join(", ")}`)
  }

  return base
})

/** Require SERPAPI_KEY at call time (smoke + live search). */
export function requireSerpApiKey(): string {
  const key = getSerpEnv().SERPAPI_KEY
  if (!key) throw new Error("[env:serp] invalid or missing environment variables: SERPAPI_KEY")
  return key
}

/** Require CRUSTDATA_API_KEY at call time. */
export function requireCrustdataApiKey(): string {
  const key = getCrustdataEnv().CRUSTDATA_API_KEY
  if (!key) throw new Error("[env:crustdata] invalid or missing environment variables: CRUSTDATA_API_KEY")
  return key
}

/** Require FIRECRAWL_API_KEY at call time (optional for keyless tier). */
export function getFirecrawlApiKey(): string | undefined {
  return getFirecrawlEnv().FIRECRAWL_API_KEY
}

/** Require SEC_USER_AGENT at call time. */
export function requireSecUserAgent(): string {
  const ua = getEdgarEnv().SEC_USER_AGENT
  if (!ua) throw new Error("[env:edgar] invalid or missing environment variables: SEC_USER_AGENT")
  return ua
}

// ---------------------------------------------------------------------------

/** Log level resolution does not require any other variable to be valid. */
export function getLogLevel(): (typeof LOG_LEVELS)[number] {
  const parsed = z.enum(LOG_LEVELS).safeParse(process.env.LOG_LEVEL)
  if (parsed.success) return parsed.data
  if (process.env.NODE_ENV === "test") return "silent"
  return process.env.NODE_ENV === "production" ? "info" : "debug"
}
