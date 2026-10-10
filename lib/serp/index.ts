/**
 * Higher-level SerpAPI engines built on lib/clients/serp.ts (serpClient).
 * Docs: https://serpapi.com/search-api and per-engine pages linked in serpEngines.
 */
import "server-only"

import { serpClient, type SerpSearchParams } from "@/lib/clients/serp"
import { z } from "zod"

type SerpEngineSearchParams = Omit<SerpSearchParams, "engine"> & Record<string, unknown>

const serpMetadataSchema = z.looseObject({
  id: z.string().optional(),
  status: z.string().optional(),
  total_time_taken: z.number().optional(),
})

const serpCommonOutputSchema = z.looseObject({
  search_metadata: serpMetadataSchema.optional(),
  search_parameters: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
})

const serpSharedInputShape = {
  hl: z.string().min(1).optional(),
  gl: z.string().min(2).max(5).optional(),
  location: z.string().min(1).optional(),
  google_domain: z.string().min(1).optional(),
  device: z.enum(["desktop", "tablet", "mobile"]).optional(),
  no_cache: z.boolean().optional(),
  async: z.boolean().optional(),
  output: z.enum(["json", "html", "md"]).optional(),
  timeout: z.number().int().positive().optional(),
}

function withRequiredQuery(
  params: SerpEngineSearchParams
): SerpEngineSearchParams & { q: string } {
  if (typeof params.q !== "string" || params.q.trim().length === 0) {
    throw new Error("Serp search requires a non-empty q (query) string")
  }
  return { ...params, q: params.q.trim() }
}

function withGoogleWebQuery(params: SerpEngineSearchParams): SerpEngineSearchParams {
  const kgmid = typeof params.kgmid === "string" ? params.kgmid.trim() : ""
  if (kgmid.length > 0) {
    return { ...params, kgmid }
  }
  return withRequiredQuery(params)
}

const GOOGLE_NEWS_TOKEN_KEYS = [
  "topic_token",
  "publication_token",
  "section_token",
  "story_token",
  "kgmid",
] as const

type GoogleNewsSearchParams = SerpEngineSearchParams & {
  so?: 0 | 1
  topic_token?: string
  publication_token?: string
  section_token?: string
  story_token?: string
  kgmid?: string
}

function withGoogleNewsParams(params: GoogleNewsSearchParams): GoogleNewsSearchParams {
  const q = typeof params.q === "string" ? params.q.trim() : ""
  const tokenKey = GOOGLE_NEWS_TOKEN_KEYS.find((key) => {
    const value = params[key]
    return typeof value === "string" && value.trim().length > 0
  })

  if (!q && !tokenKey) {
    throw new Error(
      "google_news requires q or a token (topic_token, publication_token, section_token, story_token, kgmid)"
    )
  }

  if (q && tokenKey) {
    throw new Error(
      "google_news: do not pass q together with token parameters (see SerpAPI Google News API)"
    )
  }

  if (tokenKey === "kgmid" && GOOGLE_NEWS_TOKEN_KEYS.some((key) => key !== "kgmid" && params[key])) {
    throw new Error("google_news: kgmid can only be used alone")
  }

  const merged = {
    ...params,
    ...(q ? { q } : {}),
  }

  if (q) {
    const { so: _so, ...withoutSo } = merged
    return withoutSo as GoogleNewsSearchParams
  }

  return merged
}

type GoogleFinanceSearchParams = SerpEngineSearchParams & {
  window?: "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y" | "5Y" | "MAX"
}

type GoogleAiModeSearchParams = SerpEngineSearchParams & {
  continuable?: boolean
  subsequent_request_token?: string
  image_url?: string
  output?: "json" | "html" | "md"
}

type GoogleAiOverviewFollowUpParams = Partial<
  Pick<SerpEngineSearchParams, "no_cache" | "async" | "output" | "timeout">
>

function extractGoogleAiOverviewPageToken(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null
  }
  const aiOverview = (payload as Record<string, unknown>).ai_overview
  if (!aiOverview || typeof aiOverview !== "object") {
    return null
  }
  const record = aiOverview as Record<string, unknown>
  if (record.error) {
    return null
  }
  const pageToken = record.page_token
  if (typeof pageToken !== "string") {
    return null
  }
  const trimmed = pageToken.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function fetchGoogleAiOverview(
  pageToken: string,
  options: GoogleAiOverviewFollowUpParams,
  client = serpClient
): Promise<unknown> {
  return client.search({
    engine: "google_ai_overview",
    page_token: pageToken,
    ...(typeof options.no_cache === "boolean" ? { no_cache: options.no_cache } : {}),
    ...(typeof options.async === "boolean" ? { async: options.async } : {}),
    ...(options.output === "json" || options.output === "html" || options.output === "md"
      ? { output: options.output }
      : {}),
    ...(typeof options.timeout === "number" ? { timeout: options.timeout } : {}),
  })
}

async function enrichGoogleSearchWithAiOverview(
  basePayload: unknown,
  followUpParams: GoogleAiOverviewFollowUpParams,
  client = serpClient
): Promise<unknown> {
  const pageToken = extractGoogleAiOverviewPageToken(basePayload)
  if (!pageToken) {
    return basePayload
  }

  try {
    const overviewPayload = await fetchGoogleAiOverview(pageToken, followUpParams, client)
    const baseRecord =
      basePayload && typeof basePayload === "object"
        ? (basePayload as Record<string, unknown>)
        : {}
    const stub =
      baseRecord.ai_overview && typeof baseRecord.ai_overview === "object"
        ? (baseRecord.ai_overview as Record<string, unknown>)
        : {}

    return {
      ...baseRecord,
      ai_overview: {
        ...stub,
        ...(overviewPayload && typeof overviewPayload === "object"
          ? (overviewPayload as Record<string, unknown>)
          : { payload: overviewPayload }),
      },
    }
  } catch {
    return basePayload
  }
}

async function searchGoogle<T = unknown>(
  params: SerpEngineSearchParams,
  responseSchema?: z.ZodType<T>,
  client = serpClient
): Promise<T> {
  const {
    tbm: _tbm,
    trigger_ai_overview,
    ...rest
  } = params as SerpEngineSearchParams & {
    tbm?: unknown
    trigger_ai_overview?: unknown
  }
  const shouldFetchAiOverview = trigger_ai_overview === true
  const followUpParams: GoogleAiOverviewFollowUpParams = {
    ...(typeof rest.no_cache === "boolean" ? { no_cache: rest.no_cache } : {}),
    ...(typeof rest.async === "boolean" ? { async: rest.async } : {}),
    ...(rest.output === "json" || rest.output === "html" || rest.output === "md"
      ? { output: rest.output }
      : {}),
    ...(typeof rest.timeout === "number" ? { timeout: rest.timeout } : {}),
  }

  const basePayload = await client.search(
    {
      ...withGoogleWebQuery(rest),
      engine: "google",
    },
    undefined
  )

  const enriched = shouldFetchAiOverview
    ? await enrichGoogleSearchWithAiOverview(basePayload, followUpParams, client)
    : basePayload

  if (responseSchema) {
    return responseSchema.parse(enriched)
  }
  return enriched as T
}

async function searchGoogleFinance<T = unknown>(
  params: GoogleFinanceSearchParams,
  responseSchema?: z.ZodType<T>,
  client = serpClient
): Promise<T> {
  return client.search({ ...withRequiredQuery(params), engine: "google_finance" }, responseSchema)
}

async function searchGoogleNews<T = unknown>(
  params: GoogleNewsSearchParams,
  responseSchema?: z.ZodType<T>,
  client = serpClient
): Promise<T> {
  return client.search({ ...withGoogleNewsParams(params), engine: "google_news" }, responseSchema)
}

async function searchGoogleNewsTab<T = unknown>(
  params: SerpEngineSearchParams,
  responseSchema?: z.ZodType<T>,
  client = serpClient
): Promise<T> {
  return client.search(
    {
      ...withGoogleWebQuery(params),
      engine: "google",
      tbm: "nws",
    },
    responseSchema
  )
}

async function searchGoogleAiMode<T = unknown>(
  params: GoogleAiModeSearchParams,
  responseSchema?: z.ZodType<T>,
  client = serpClient
): Promise<T> {
  return client.search({ ...withRequiredQuery(params), engine: "google_ai_mode" }, responseSchema)
}

type YoutubeSearchParams = SerpEngineSearchParams & {
  search_query?: string
  sp?: string
}

function withYoutubeSearchQuery(
  params: YoutubeSearchParams
): YoutubeSearchParams & { search_query: string } {
  const search_query =
    (typeof params.search_query === "string" ? params.search_query.trim() : "") ||
    (typeof params.q === "string" ? params.q.trim() : "")
  if (!search_query) {
    throw new Error("youtube requires search_query")
  }
  const { q: _q, ...rest } = params
  return { ...rest, search_query }
}

async function searchYoutube<T = unknown>(
  params: YoutubeSearchParams,
  responseSchema?: z.ZodType<T>,
  client = serpClient
): Promise<T> {
  return client.search({ ...withYoutubeSearchQuery(params), engine: "youtube" }, responseSchema)
}

type YoutubeVideoTranscriptParams = SerpEngineSearchParams & {
  v?: string
  language_code?: string
  title?: string
  type?: string
}

function withYoutubeVideoId(
  params: YoutubeVideoTranscriptParams
): YoutubeVideoTranscriptParams & { v: string } {
  const v = typeof params.v === "string" ? params.v.trim() : ""
  if (!v) {
    throw new Error("youtube_video_transcript requires v (video id)")
  }
  return { ...params, v }
}

async function searchYoutubeVideoTranscript<T = unknown>(
  params: YoutubeVideoTranscriptParams,
  responseSchema?: z.ZodType<T>,
  client = serpClient
): Promise<T> {
  return client.search(
    { ...withYoutubeVideoId(params), engine: "youtube_video_transcript" },
    responseSchema
  )
}

type GoogleMapsAutocompleteSearchParams = SerpEngineSearchParams & {
  ll: string
  cp?: number
}

function withGoogleMapsAutocompleteParams(
  params: GoogleMapsAutocompleteSearchParams
): GoogleMapsAutocompleteSearchParams & { q: string; ll: string } {
  const withQuery = withRequiredQuery(params)
  const ll = typeof params.ll === "string" ? params.ll.trim() : ""
  if (!ll) {
    throw new Error(
      "google_maps_autocomplete requires ll (@latitude,longitude,zoom e.g. @40.7455096,-74.0083012,14z)"
    )
  }
  return { ...withQuery, ll }
}

async function searchGoogleMapsAutocomplete<T = unknown>(
  params: GoogleMapsAutocompleteSearchParams,
  responseSchema?: z.ZodType<T>,
  client = serpClient
): Promise<T> {
  return client.search(
    {
      ...withGoogleMapsAutocompleteParams(params),
      engine: "google_maps_autocomplete",
    },
    responseSchema
  )
}

type GoogleMapsSearchParams = SerpEngineSearchParams & {
  type?: "search" | "place"
  ll?: string
  lat?: number
  lon?: number
  z?: number
  m?: number
  nearby?: boolean
  place_id?: string
  data_cid?: string
  data?: string
  start?: number
  min_price?: number
  max_price?: number
  min_rating?: "2.0" | "2.5" | "3.0" | "3.5" | "4.0" | "4.5"
  open_state?: "now" | "24h"
  open_on_day?: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"
  open_at_hour?: number
}

function withGoogleMapsParams(params: GoogleMapsSearchParams): GoogleMapsSearchParams {
  const placeId = typeof params.place_id === "string" ? params.place_id.trim() : ""
  const dataCid = typeof params.data_cid === "string" ? params.data_cid.trim() : ""

  if (placeId && dataCid) {
    throw new Error("google_maps: place_id and data_cid cannot be used together")
  }

  if (placeId || dataCid) {
    return {
      ...params,
      ...(placeId ? { place_id: placeId } : {}),
      ...(dataCid ? { data_cid: dataCid } : {}),
    }
  }

  const type = params.type
  if (type !== "search" && type !== "place") {
    throw new Error("google_maps requires type=search|place, or place_id, or data_cid")
  }

  if (type === "search") {
    return { ...withRequiredQuery(params), type }
  }

  const data = typeof params.data === "string" ? params.data.trim() : ""
  if (!data) {
    throw new Error("google_maps type=place requires data parameter")
  }
  return { ...params, type, data }
}

async function searchGoogleMaps<T = unknown>(
  params: GoogleMapsSearchParams,
  responseSchema?: z.ZodType<T>,
  client = serpClient
): Promise<T> {
  return client.search({ ...withGoogleMapsParams(params), engine: "google_maps" }, responseSchema)
}

const googleInputSchema = z.looseObject({
  q: z.string().min(1),
  start: z.number().int().min(0).optional(),
  num: z.number().int().min(1).max(100).optional(),
  safe: z.enum(["active", "off"]).optional(),
  trigger_ai_overview: z.boolean().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  radius: z.number().int().positive().optional(),
  ...serpSharedInputShape,
})

const googleOutputSchema = serpCommonOutputSchema.extend({
  organic_results: z
    .array(
      z.looseObject({
        position: z.number().optional(),
        title: z.string().optional(),
        link: z.string().optional(),
        snippet: z.string().optional(),
        displayed_link: z.string().optional(),
      })
    )
    .optional(),
  ai_overview: z.record(z.string(), z.unknown()).optional(),
  knowledge_graph: z.record(z.string(), z.unknown()).optional(),
  answer_box: z.record(z.string(), z.unknown()).optional(),
  related_questions: z.array(z.unknown()).optional(),
  related_searches: z.array(z.unknown()).optional(),
})

const googleFinanceInputSchema = z.looseObject({
  q: z.string().min(1),
  window: z.enum(["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"]).optional(),
  hl: serpSharedInputShape.hl,
  no_cache: serpSharedInputShape.no_cache,
  async: serpSharedInputShape.async,
  output: serpSharedInputShape.output,
  timeout: serpSharedInputShape.timeout,
})

const googleFinanceOutputSchema = serpCommonOutputSchema.extend({
  summary: z
    .looseObject({
      title: z.string().optional(),
      stock: z.string().optional(),
      exchange: z.string().optional(),
      price: z.string().optional(),
      extracted_price: z.number().optional(),
      currency: z.string().optional(),
      price_movement: z
        .looseObject({
          percentage: z.number().optional(),
          value: z.number().optional(),
          movement: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  graph: z
    .array(
      z.looseObject({
        price: z.number().optional(),
        currency: z.string().optional(),
        date: z.string().optional(),
        volume: z.number().optional(),
      })
    )
    .optional(),
  news_results: z
    .array(
      z.looseObject({
        snippet: z.string().optional(),
        link: z.string().optional(),
        source: z.string().optional(),
        date: z.string().optional(),
        thumbnail: z.string().optional(),
      })
    )
    .optional(),
  financials: z.array(z.unknown()).optional(),
  discover_more: z.array(z.unknown()).optional(),
})

const googleNewsInputSchema = z
  .looseObject({
    q: z.string().min(1).optional(),
    topic_token: z.string().min(1).optional(),
    publication_token: z.string().min(1).optional(),
    section_token: z.string().min(1).optional(),
    story_token: z.string().min(1).optional(),
    kgmid: z.string().min(1).optional(),
    so: z.union([z.literal(0), z.literal(1)]).optional(),
    gl: serpSharedInputShape.gl,
    hl: serpSharedInputShape.hl,
    no_cache: serpSharedInputShape.no_cache,
    async: serpSharedInputShape.async,
    output: serpSharedInputShape.output,
    timeout: serpSharedInputShape.timeout,
  })
  .superRefine((data, ctx) => {
    const q = data.q?.trim()
    const tokens = GOOGLE_NEWS_TOKEN_KEYS.filter((key) => {
      const v = data[key]
      return typeof v === "string" && v.trim().length > 0
    })
    if (!q && tokens.length === 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide q or one of topic_token, publication_token, section_token, story_token, kgmid",
      })
    }
    if (q && tokens.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "Do not combine q with token parameters",
      })
    }
    if (q && (data.so === 0 || data.so === 1)) {
      ctx.addIssue({
        code: "custom",
        message: "Do not combine q with so (use so only with token parameters)",
      })
    }
    if (tokens.includes("kgmid") && tokens.some((t) => t !== "kgmid")) {
      ctx.addIssue({
        code: "custom",
        message: "kgmid can only be used alone",
      })
    }
  })

const googleNewsOutputSchema = serpCommonOutputSchema.extend({
  news_results: z
    .array(
      z.looseObject({
        position: z.number().optional(),
        title: z.string().optional(),
        link: z.string().optional(),
        snippet: z.string().optional(),
        date: z.string().optional(),
        iso_date: z.string().optional(),
        source: z
          .looseObject({
            name: z.string().optional(),
            icon: z.string().optional(),
            authors: z.array(z.string()).optional(),
          })
          .optional(),
        thumbnail: z.string().optional(),
      })
    )
    .optional(),
  menu_links: z.array(z.record(z.string(), z.unknown())).optional(),
  related_topics: z.array(z.record(z.string(), z.unknown())).optional(),
  related_publications: z.array(z.record(z.string(), z.unknown())).optional(),
})

const googleNewsTabInputSchema = z
  .looseObject({
    q: z.string().min(1).optional(),
    kgmid: z.string().min(1).optional(),
    start: z.number().int().min(0).optional(),
    num: z.number().int().min(1).max(100).optional(),
    ...serpSharedInputShape,
  })
  .superRefine((data, ctx) => {
    const hasQ = typeof data.q === "string" && data.q.trim().length > 0
    const hasKg = typeof data.kgmid === "string" && data.kgmid.trim().length > 0
    if (!hasQ && !hasKg) {
      ctx.addIssue({
        code: "custom",
        message: "Provide q or kgmid",
      })
    }
  })

const googleNewsTabOutputSchema = serpCommonOutputSchema.extend({
  news_results: z
    .array(
      z.looseObject({
        position: z.number().optional(),
        title: z.string().optional(),
        link: z.string().optional(),
        source: z.string().optional(),
        date: z.string().optional(),
        published_at: z.string().optional(),
        snippet: z.string().optional(),
        favicon: z.string().optional(),
        thumbnail: z.string().optional(),
      })
    )
    .optional(),
  people_also_search_for: z.array(z.record(z.string(), z.unknown())).optional(),
})

const googleAiModeInputSchema = z.looseObject({
  q: z.string().min(1),
  continuable: z.boolean().optional(),
  subsequent_request_token: z.string().min(1).optional(),
  image_url: z.string().url().optional(),
  ...serpSharedInputShape,
})

const googleAiModeOutputSchema = serpCommonOutputSchema.extend({
  text_blocks: z.array(z.unknown()).optional(),
  references: z.array(z.unknown()).optional(),
  subsequent_request_token: z.string().optional(),
})

const youtubeInputSchema = z
  .looseObject({
    search_query: z.string().min(1).optional(),
    q: z.string().min(1).optional(),
    sp: z.string().min(1).optional(),
    gl: serpSharedInputShape.gl,
    hl: serpSharedInputShape.hl,
    no_cache: serpSharedInputShape.no_cache,
    async: serpSharedInputShape.async,
    output: serpSharedInputShape.output,
    timeout: serpSharedInputShape.timeout,
  })
  .superRefine((data, ctx) => {
    if (!data.search_query?.trim() && !data.q?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "Provide search_query (or q as alias)",
      })
    }
  })

const youtubeOutputSchema = serpCommonOutputSchema.extend({
  search_information: z.record(z.string(), z.unknown()).optional(),
  video_results: z.array(z.record(z.string(), z.unknown())).optional(),
  channel_results: z.array(z.record(z.string(), z.unknown())).optional(),
  shorts_results: z.array(z.record(z.string(), z.unknown())).optional(),
  pagination: z.record(z.string(), z.unknown()).optional(),
  serpapi_pagination: z.record(z.string(), z.unknown()).optional(),
})

const youtubeVideoTranscriptInputSchema = z.looseObject({
  v: z.string().min(1),
  language_code: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  no_cache: serpSharedInputShape.no_cache,
  async: serpSharedInputShape.async,
  output: serpSharedInputShape.output,
  timeout: serpSharedInputShape.timeout,
})

const youtubeVideoTranscriptOutputSchema = serpCommonOutputSchema.extend({
  video_id: z.string().optional(),
  title: z.string().optional(),
  language: z.string().optional(),
  available_languages: z.array(z.record(z.string(), z.unknown())).optional(),
  transcript: z.array(z.record(z.string(), z.unknown())).optional(),
})

const googleMapsAutocompleteInputSchema = z.looseObject({
  q: z.string().min(1),
  ll: z.string().min(1),
  cp: z.number().int().min(0).optional(),
  gl: serpSharedInputShape.gl,
  hl: serpSharedInputShape.hl,
  no_cache: serpSharedInputShape.no_cache,
  async: serpSharedInputShape.async,
  output: serpSharedInputShape.output,
  timeout: serpSharedInputShape.timeout,
})

const googleMapsAutocompleteOutputSchema = serpCommonOutputSchema.extend({
  search_information: z
    .looseObject({
      query_displayed: z.string().optional(),
    })
    .optional(),
  suggestions: z
    .array(
      z.looseObject({
        value: z.string().optional(),
        subtext: z.string().optional(),
        serpapi_link: z.string().optional(),
        maps_serpapi_link: z.string().optional(),
        reviews_serpapi_link: z.string().optional(),
        photos_serpapi_link: z.string().optional(),
        type: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        data_id: z.string().optional(),
        gps_coordinates: z
          .looseObject({
            latitude: z.number().optional(),
            longitude: z.number().optional(),
          })
          .optional(),
      })
    )
    .optional(),
})

const googleMapsInputSchema = z
  .looseObject({
    type: z.enum(["search", "place"]).optional(),
    q: z.string().min(1).optional(),
    ll: z.string().min(1).optional(),
    location: serpSharedInputShape.location,
    lat: z.number().optional(),
    lon: z.number().optional(),
    z: z.number().int().min(3).max(30).optional(),
    m: z.number().int().min(1).optional(),
    nearby: z.boolean().optional(),
    place_id: z.string().min(1).optional(),
    data_cid: z.string().min(1).optional(),
    data: z.string().min(1).optional(),
    start: z.number().int().min(0).optional(),
    min_price: z.number().optional(),
    max_price: z.number().optional(),
    min_rating: z.enum(["2.0", "2.5", "3.0", "3.5", "4.0", "4.5"]).optional(),
    open_state: z.enum(["now", "24h"]).optional(),
    open_on_day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]).optional(),
    open_at_hour: z.number().int().min(0).max(23).optional(),
    google_domain: serpSharedInputShape.google_domain,
    hl: serpSharedInputShape.hl,
    gl: serpSharedInputShape.gl,
    no_cache: serpSharedInputShape.no_cache,
    async: serpSharedInputShape.async,
    output: serpSharedInputShape.output,
    timeout: serpSharedInputShape.timeout,
  })
  .superRefine((data, ctx) => {
    const placeId = data.place_id?.trim()
    const dataCid = data.data_cid?.trim()
    if (placeId && dataCid) {
      ctx.addIssue({
        code: "custom",
        message: "place_id and data_cid cannot be used together",
      })
      return
    }
    if (placeId || dataCid) {
      return
    }
    if (data.type !== "search" && data.type !== "place") {
      ctx.addIssue({
        code: "custom",
        message: "Provide type=search|place, or place_id, or data_cid",
      })
      return
    }
    if (data.type === "search" && !data.q?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "type=search requires q",
      })
    }
    if (data.type === "place" && !data.data?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "type=place requires data",
      })
    }
  })

const googleMapsLocalResultSchema = z.looseObject({
  position: z.number().optional(),
  title: z.string().optional(),
  place_id: z.string().optional(),
  data_id: z.string().optional(),
  data_cid: z.string().optional(),
  rating: z.number().optional(),
  reviews: z.number().optional(),
  price: z.string().optional(),
  type: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  gps_coordinates: z
    .looseObject({
      latitude: z.number().optional(),
      longitude: z.number().optional(),
    })
    .optional(),
  thumbnail: z.string().optional(),
  serpapi_thumbnail: z.string().optional(),
})

const googleMapsOutputSchema = serpCommonOutputSchema.extend({
  search_information: z.record(z.string(), z.unknown()).optional(),
  local_results: z.array(googleMapsLocalResultSchema).optional(),
  place_results: z.record(z.string(), z.unknown()).optional(),
  serpapi_pagination: z.record(z.string(), z.unknown()).optional(),
})

export const serpEngines = {
  searchGoogle: {
    description: [
      "Google Web Search (engine=google). General web SERP.",
      "Set trigger_ai_overview=true to fetch Google AI Overview when the SERP returns ai_overview.page_token (follow-up engine=google_ai_overview; token expires ~1 minute). Default is false (no extra request).",
      "Input: q (required); optional start, num, safe, trigger_ai_overview, hl, gl, location, google_domain, device, no_cache, async, output, timeout.",
      "Output: organic_results, ai_overview (inline or fetched via page_token), knowledge_graph, answer_box, related_questions, related_searches, search_metadata.",
      "Docs: https://serpapi.com/search-api and https://serpapi.com/google-ai-overview-api",
    ].join(" "),
    fn: searchGoogle,
    inputSchema: googleInputSchema,
    outputSchema: googleOutputSchema,
  },
  searchGoogleFinance: {
    description: [
      "Google Finance quote page (engine=google_finance).",
      "Input: q (required) ticker/symbol e.g. RELIANCE:NSE; optional window (1D|5D|1M|6M|YTD|1Y|5Y|MAX), hl, no_cache, async, output, timeout.",
      "Output: summary (price, movement), graph points, knowledge_graph stats, news_results, financials, discover_more, search_metadata.",
      "Docs: https://serpapi.com/google-finance-api",
    ].join(" "),
    fn: searchGoogleFinance,
    inputSchema: googleFinanceInputSchema,
    outputSchema: googleFinanceOutputSchema,
  },
  searchGoogleNews: {
    description: [
      "Google News site (engine=google_news, news.google.com). Not the Google web News tab.",
      "Input: q OR token params (topic_token, publication_token, section_token, story_token, kgmid alone); never q + tokens; so (0=relevance, 1=date) only with token params — never with q; gl, hl.",
      "Output: news_results (title, link, iso_date, source.name), menu_links, related_topics, related_publications, search_metadata.",
      "Docs: https://serpapi.com/google-news-api",
    ].join(" "),
    fn: searchGoogleNews,
    inputSchema: googleNewsInputSchema,
    outputSchema: googleNewsOutputSchema,
  },
  searchGoogleNewsTab: {
    description: [
      "Google Search News tab (engine=google, tbm=nws). Web news SERP, not news.google.com.",
      "Input: q (required unless kgmid); optional kgmid, start, num, hl, gl, location, device, etc.",
      "Output: news_results (source as string, published_at), people_also_search_for story clusters, search_metadata.",
      "Docs: https://serpapi.com/news-results",
    ].join(" "),
    fn: searchGoogleNewsTab,
    inputSchema: googleNewsTabInputSchema,
    outputSchema: googleNewsTabOutputSchema,
  },
  searchGoogleAiMode: {
    description: [
      "Google AI Mode (engine=google_ai_mode). Conversational answers with citations.",
      "Input: q (required); optional continuable, subsequent_request_token (follow-up), image_url, hl, gl, location, output.",
      "Output: text_blocks, references, subsequent_request_token for next turn, search_metadata.",
      "Docs: https://serpapi.com/google-ai-mode-api",
    ].join(" "),
    fn: searchGoogleAiMode,
    inputSchema: googleAiModeInputSchema,
    outputSchema: googleAiModeOutputSchema,
  },
  searchYoutube: {
    description: [
      "YouTube Search (engine=youtube). Video titles, links, channels, shorts, pagination.",
      "Input: search_query (required); optional sp, gl, hl, no_cache, async, output, timeout.",
      "Output: video_results, channel_results, shorts_results, pagination, search_metadata.",
      "Docs: https://serpapi.com/youtube-search-api",
    ].join(" "),
    fn: searchYoutube,
    inputSchema: youtubeInputSchema,
    outputSchema: youtubeOutputSchema,
  },
  searchYoutubeVideoTranscript: {
    description: [
      "YouTube Video Transcript (engine=youtube_video_transcript).",
      "Input: v (required, video id); optional language_code, title, type, no_cache, async, output, timeout.",
      "Output: transcript segments, video_id, language, available_languages, search_metadata.",
      "Docs: https://serpapi.com/youtube-video-transcript",
    ].join(" "),
    fn: searchYoutubeVideoTranscript,
    inputSchema: youtubeVideoTranscriptInputSchema,
    outputSchema: youtubeVideoTranscriptOutputSchema,
  },
  searchGoogleMapsAutocomplete: {
    description: [
      "Google Maps Autocomplete (engine=google_maps_autocomplete). Location-aware query completions.",
      "Input: q (required), ll (required, e.g. @40.7455096,-74.0083012,14z); optional cp (cursor index), gl, hl.",
      "Output: suggestions (value, type, serpapi_link, maps_serpapi_link), search_information, search_metadata.",
      "Docs: https://serpapi.com/google-maps-autocomplete-api",
    ].join(" "),
    fn: searchGoogleMapsAutocomplete,
    inputSchema: googleMapsAutocompleteInputSchema,
    outputSchema: googleMapsAutocompleteOutputSchema,
  },
  searchGoogleMaps: {
    description: [
      "Google Maps (engine=google_maps). Local place search or place details.",
      "Input: type=search requires q; type=place requires data; or use place_id / data_cid alone.",
      "Optional: ll, location, lat/lon with z or m, nearby, start (pagination), price/rating/hours filters, hl, gl.",
      "Output: local_results (title, address, gps_coordinates, place_id), place_results, serpapi_pagination, search_metadata.",
      "Docs: https://serpapi.com/google-maps-api",
    ].join(" "),
    fn: searchGoogleMaps,
    inputSchema: googleMapsInputSchema,
    outputSchema: googleMapsOutputSchema,
  },
} as const

export type SerpEngineName = keyof typeof serpEngines
