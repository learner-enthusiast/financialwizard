/*
 * Crustdata client — INDEXED endpoints only (no `/live`, which is plan-gated).
 *
 * Docs used:
 *   https://docs.crustdata.com/llms.txt
 *   https://docs.crustdata.com/openapi-specs/2025-11-01/introduction.md   (base URL, auth, x-api-version, errors)
 *   https://docs.crustdata.com/openapi-specs/2025-11-01/best-practices.md (rate-limit headers, 429, 402, 403)
 *   https://docs.crustdata.com/company-docs/identify/introduction.md
 *   https://docs.crustdata.com/api-reference/company-apis/identify-a-company-from-name-domain-id-or-profile-url.md
 *   https://docs.crustdata.com/company-docs/enrichment/introduction.md
 *   https://docs.crustdata.com/company-docs/enrichment/reference.md
 *   https://docs.crustdata.com/company-docs/search/introduction.md
 *   https://docs.crustdata.com/company-docs/search/reference.md
 *   https://docs.crustdata.com/job-docs/search/introduction.md
 *   https://docs.crustdata.com/general/pricing.md      (identify free; enrich 2-4/record; search 0.03/result)
 *   https://docs.crustdata.com/general/rate-limits.md
 *   https://docs.crustdata.com/general/credits.md      (X-Credits-Used on every data response)
 *   https://docs.crustdata.com/general/permissions.md
 * Request/response types: the OpenAPI fragments embedded in the api-reference pages
 * (company.yaml / job.yaml / account endpoints). The standalone .yaml URLs return HTML.
 *
 * Contract for callers (always via callTool):
 *   - Returns null for non-retryable outcomes: 402 insufficient_credits, 403
 *     permission_error (endpoint or fields disabled), 400/401/404. The reason
 *     and X-Credits-Used are reported to the Step row via `onUsage`.
 *   - Throws for retryable failures (5xx, network, exhausted 429 retries) so
 *     callTool's backoff applies.
 */
import "server-only"

import { z } from "zod"

import { requireCrustdataApiKey } from "@/lib/env"

const BASE_URL = "https://api.crustdata.com"
const API_VERSION = "2025-11-01"
const MAX_429_RETRIES = 3

// ---------------------------------------------------------------------------
// Types derived from the OpenAPI spec (2025-11-01)
// ---------------------------------------------------------------------------

/** Valid field groups for /company/enrich (CompanyEnrichRequest.fields). */
export const ENRICH_FIELD_GROUPS = [
  "basic_info",
  "revenue",
  "headcount",
  "funding",
  "hiring",
  "web_traffic",
  "seo",
  "competitors",
  "employee_reviews",
  "people",
  "locations",
  "taxonomy",
  "followers",
  "news",
  "software_reviews",
  "social_profiles",
  "reviews",
  "public_launches",
  "market_intel",
  "metadata",
  "crustdata_company_id",
  "updated_at",
  "indexed_at",
  "social_posts",
] as const
export type EnrichFieldGroup = (typeof ENRICH_FIELD_GROUPS)[number]

/** Filter operators shared by /company/search and /job/search. */
export type SearchOperator =
  | "="
  | "!="
  | "<"
  | "=<"
  | ">"
  | "=>"
  | "in"
  | "not_in"
  | "is_null"
  | "is_not_null"
  | "(.)"
  | "[.]"

export type SearchCondition = {
  field: string
  type: SearchOperator
  value: string | number | boolean | null | Array<string | number>
}
export type SearchConditionGroup = { op: "and" | "or"; conditions: Array<SearchCondition | SearchConditionGroup> }
export type SearchFilters = SearchCondition | SearchConditionGroup

const nullableString = z.string().nullable().optional()

const basicInfoSchema = z.looseObject({
  crustdata_company_id: z.number().int().nullable().optional(),
  name: nullableString,
  primary_domain: nullableString,
  all_domains: z.array(z.string()).nullable().optional(),
  website: nullableString,
  professional_network_url: nullableString,
  company_type: nullableString,
  status: nullableString,
  year_founded: z.number().int().nullable().optional(),
  employee_count_range: nullableString,
})

const headcountSchema = z.looseObject({
  total: z.number().int().nullable().optional(),
  largest_headcount_country: nullableString,
  timeseries: z
    .array(z.looseObject({ date: z.string(), employee_count: z.number() }))
    .nullable()
    .optional(),
})

const fundingSchema = z.looseObject({
  total_investment_usd: z.number().nullable().optional(),
  last_round_amount_usd: z.number().nullable().optional(),
  last_fundraise_date: nullableString,
  last_round_type: nullableString,
  milestones: z
    .array(
      z.looseObject({
        date: nullableString,
        funding_date: nullableString,
        amount_usd: z.number().nullable().optional(),
        round_type: nullableString,
        investors: nullableString,
        lead_investors: nullableString,
      })
    )
    .nullable()
    .optional(),
  investors: z.array(z.string()).nullable().optional(),
})

const revenueSchema = z.looseObject({
  estimated: z
    .looseObject({ lower_bound_usd: z.number().nullable().optional(), upper_bound_usd: z.number().nullable().optional() })
    .nullable()
    .optional(),
  public_markets: z
    .looseObject({ ipo_date: nullableString, stock_symbols: z.array(z.string()).nullable().optional(), fiscal_year_end: nullableString })
    .nullable()
    .optional(),
  acquisition_status: nullableString,
})

/** CompanyEnrich: sections are present only when requested via `fields`. */
const companyDataSchema = z.looseObject({
  crustdata_company_id: z.number().int().optional(),
  basic_info: basicInfoSchema.nullable().optional(),
  headcount: headcountSchema.nullable().optional(),
  funding: fundingSchema.nullable().optional(),
  revenue: revenueSchema.nullable().optional(),
})
export type CrustdataCompany = z.infer<typeof companyDataSchema>

const matchesResponseSchema = z.array(
  z.looseObject({
    matched_on: z.string().optional(),
    match_type: z.string().optional(),
    matches: z.array(z.looseObject({ confidence_score: z.number().optional(), company_data: companyDataSchema })).default([]),
  })
)

export type CrustdataMatch = { confidenceScore: number | null; company: CrustdataCompany }

const companySearchResponseSchema = z.looseObject({
  companies: z.array(companyDataSchema).default([]),
  next_cursor: z.string().nullable().optional(),
  total_count: z.number().int().nullable().optional(),
})
export type CompanySearchResult = z.infer<typeof companySearchResponseSchema>

const jobSearchResponseSchema = z.looseObject({
  job_listings: z.array(
    z.looseObject({
      crustdata_job_id: z.number().int().optional(),
      job_details: z
        .looseObject({ title: nullableString, category: nullableString, url: nullableString, number_of_openings: z.number().int().nullable().optional() })
        .optional(),
      company: z.looseObject({ basic_info: basicInfoSchema.optional() }).optional(),
    })
  ),
  next_cursor: z.string().nullable().optional(),
  total_count: z.number().int().nullable().optional(),
})
export type JobSearchResult = z.infer<typeof jobSearchResponseSchema>

const creditsResponseSchema = z.looseObject({
  account: z.looseObject({
    credits: z.number(),
    recurring_credits: z.number(),
    recurring_credits_frequency: nullableString,
    recurring_credits_refresh_date: nullableString,
  }),
})
export type CrustdataCredits = z.infer<typeof creditsResponseSchema>["account"]

const endpointsResponseSchema = z.looseObject({
  api_version: z.string(),
  token_limit_rpm: z.number().int().nullable(),
  endpoints: z.array(
    z.looseObject({
      path: z.string(),
      category: z.string(),
      status: z.enum(["enabled", "disabled"]),
      effective_rate_limit_rpm: z.number().int().nullable(),
      fields: z.object({ enabled: z.array(z.string()), disabled: z.array(z.string()) }),
      base_credits: z.number().optional(),
    })
  ),
})
export type CrustdataEndpointPermissions = z.infer<typeof endpointsResponseSchema>

const errorBodySchema = z.looseObject({
  error: z.union([
    z.looseObject({ type: z.string(), message: z.string().optional() }),
    z.string(),
  ]),
})

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type CrustdataUsage = {
  /** From X-Credits-Used (absent on 429s and some account endpoints). */
  creditsUsed?: number
  requestId?: string
  endpoint: string
  /** Set when the call ended without data, e.g. "insufficient_credits". */
  outcome?: string
}

export type CrustdataCallOptions = {
  signal?: AbortSignal
  /** Receives usage for the Step row; pass callTool's `report`. */
  onUsage?: (usage: CrustdataUsage) => void
}

/** Sliding-window pacing per endpoint, from x-ratelimit-remaining / x-ratelimit-reset. */
const notBefore = new Map<string, number>()

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error("aborted"))
    }, { once: true })
  })
}

function headerNumber(res: Response, name: string): number | undefined {
  const raw = res.headers.get(name)
  if (raw === null || raw.trim() === "") return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

async function errorType(res: Response): Promise<string> {
  try {
    const parsed = errorBodySchema.safeParse(await res.json())
    if (!parsed.success) return `http_${res.status}`
    return typeof parsed.data.error === "string" ? parsed.data.error : parsed.data.error.type
  } catch {
    return `http_${res.status}`
  }
}

/**
 * Sends one request. Returns parsed JSON, or null for non-retryable outcomes.
 * Throws for retryable ones (5xx, network, persistent 429).
 */
async function request<S extends z.ZodType>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  schema: S,
  opts: CrustdataCallOptions
): Promise<z.infer<S> | null> {
  const apiKey = requireCrustdataApiKey()

  for (let attempt = 0; ; attempt++) {
    const wait = (notBefore.get(path) ?? 0) - Date.now()
    if (wait > 0) await sleep(wait, opts.signal)

    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      signal: opts.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-api-version": API_VERSION,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const remaining = headerNumber(res, "x-ratelimit-remaining")
    const reset = headerNumber(res, "x-ratelimit-reset") ?? 0
    if (remaining !== undefined && remaining <= 1 && reset > 0) notBefore.set(path, Date.now() + reset * 1000)

    const usage: CrustdataUsage = {
      endpoint: path,
      creditsUsed: headerNumber(res, "x-credits-used"),
      requestId: res.headers.get("x-request-id") ?? undefined,
    }

    if (res.status === 429) {
      if (attempt >= MAX_429_RETRIES) {
        opts.onUsage?.({ ...usage, outcome: "rate_limited" })
        throw new Error(`Crustdata ${path} rate limited`)
      }
      await sleep((Math.max(reset, 1) + Math.random()) * 1000, opts.signal)
      continue
    }

    if (res.ok) {
      opts.onUsage?.(usage)
      return schema.parse(await res.json())
    }

    const type = await errorType(res)
    opts.onUsage?.({ ...usage, outcome: type })
    if (res.status >= 500) throw new Error(`Crustdata ${path} HTTP ${res.status}`)
    // 400 invalid_request, 401 auth, 402 insufficient_credits, 403 permission_error, 404 not found:
    // terminal per the best-practices page — retrying cannot succeed.
    return null
  }
}

function identifierBody(target: { domain?: string; name?: string; profileUrl?: string; id?: number }): Record<string, unknown> {
  if (target.domain) return { domains: [target.domain] }
  if (target.id !== undefined) return { crustdata_company_ids: [target.id] }
  if (target.profileUrl) return { professional_network_profile_urls: [target.profileUrl] }
  if (target.name) return { names: [target.name] }
  throw new Error("Crustdata: provide exactly one of domain, id, profileUrl or name")
}

function flattenMatches(results: z.infer<typeof matchesResponseSchema>): CrustdataMatch[] {
  return results.flatMap((result) =>
    result.matches.map((match) => ({ confidenceScore: match.confidence_score ?? null, company: match.company_data }))
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** POST /company/identify — FREE. Ranked matches by confidence. Empty array when nothing matches. */
export async function identifyCompany(
  target: { name: string } | { domain: string } | { profileUrl: string },
  opts: CrustdataCallOptions = {}
): Promise<CrustdataMatch[] | null> {
  const result = await request("POST", "/company/identify", identifierBody(target), matchesResponseSchema, opts)
  return result === null ? null : flattenMatches(result)
}

/**
 * POST /company/enrich — 2-4 credits per record. `fields` is required and
 * explicit: request only the groups a check needs.
 */
export async function enrichCompany(
  target: { domain: string } | { name: string } | { id: number },
  fields: [EnrichFieldGroup, ...EnrichFieldGroup[]],
  opts: CrustdataCallOptions = {}
): Promise<CrustdataMatch[] | null> {
  const result = await request(
    "POST",
    "/company/enrich",
    { ...identifierBody(target), fields },
    matchesResponseSchema,
    opts
  )
  return result === null ? null : flattenMatches(result)
}

/** POST /company/search — 0.03 credits per result. */
export async function searchCompanies(
  filters: SearchFilters,
  limit: number,
  opts: CrustdataCallOptions & { fields?: string[]; cursor?: string } = {}
): Promise<CompanySearchResult | null> {
  return request(
    "POST",
    "/company/search",
    { filters, limit: Math.min(Math.max(1, limit), 1000), ...(opts.fields ? { fields: opts.fields } : {}), ...(opts.cursor ? { cursor: opts.cursor } : {}) },
    companySearchResponseSchema,
    opts
  )
}

/** POST /job/search — 0.03 credits per result. */
export async function searchJobs(
  filters: SearchFilters,
  limit: number,
  opts: CrustdataCallOptions & { fields?: string[]; cursor?: string } = {}
): Promise<JobSearchResult | null> {
  return request(
    "POST",
    "/job/search",
    { filters, limit: Math.min(Math.max(0, limit), 1000), ...(opts.fields ? { fields: opts.fields } : {}), ...(opts.cursor ? { cursor: opts.cursor } : {}) },
    jobSearchResponseSchema,
    opts
  )
}

/** GET /account/credits — free. Remaining balance and recurring grant. */
export async function getCredits(opts: CrustdataCallOptions = {}): Promise<CrustdataCredits | null> {
  const result = await request("GET", "/account/credits", undefined, creditsResponseSchema, opts)
  return result?.account ?? null
}

/** GET /account/endpoints — free. Per-endpoint access status, enabled fields and RPM. */
export async function getEndpointPermissions(opts: CrustdataCallOptions = {}): Promise<CrustdataEndpointPermissions | null> {
  return request("GET", "/account/endpoints", undefined, endpointsResponseSchema, opts)
}
