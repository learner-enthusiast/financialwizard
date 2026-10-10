import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { enrichCompany, getCredits, identifyCompany, searchCompanies } from "@/lib/clients/crustdata"

vi.mock("@/lib/env", () => ({ requireCrustdataApiKey: () => "test-key" }))

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe("crustdata client", () => {
  it("sends bearer auth and the pinned API version to indexed endpoints", async () => {
    fetchMock.mockResolvedValue(respond(200, [{ matched_on: "stripe.com", match_type: "domain", matches: [] }], { "x-credits-used": "0" }))
    await identifyCompany({ domain: "stripe.com" })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.crustdata.com/company/identify")
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-key", "x-api-version": "2025-11-01" })
    expect(JSON.parse(String(init?.body))).toEqual({ domains: ["stripe.com"] })
    expect(String(url)).not.toContain("/live")
  })

  it("requests only the explicit enrich field groups and reports X-Credits-Used", async () => {
    fetchMock.mockResolvedValue(
      respond(
        200,
        [{ matched_on: "stripe.com", match_type: "domain", matches: [{ confidence_score: 1, company_data: { crustdata_company_id: 1, basic_info: { name: "Stripe" }, headcount: { total: 8000 } } }] }],
        { "x-credits-used": "2", "x-request-id": "req-1" }
      )
    )
    const onUsage = vi.fn()
    const matches = await enrichCompany({ domain: "stripe.com" }, ["basic_info", "headcount"], { onUsage })

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ domains: ["stripe.com"], fields: ["basic_info", "headcount"] })
    expect(matches).toEqual([{ confidenceScore: 1, company: expect.objectContaining({ headcount: { total: 8000 } }) }])
    expect(onUsage).toHaveBeenCalledWith({ endpoint: "/company/enrich", creditsUsed: 2, requestId: "req-1" })
  })

  it.each([
    [402, "insufficient_credits"],
    [403, "permission_error"],
  ])("treats %i (%s) as terminal: returns null without retrying", async (status, type) => {
    fetchMock.mockResolvedValue(respond(status, { error: { type, message: "x", metadata: [] } }, { "x-credits-used": "0" }))
    const onUsage = vi.fn()

    await expect(enrichCompany({ domain: "x.com" }, ["basic_info"], { onUsage })).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: type, creditsUsed: 0 }))
  })

  it("waits x-ratelimit-reset and retries on 429", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(429, { error: { type: "rate_limit_error", message: "slow down" } }, { "x-ratelimit-reset": "1" }))
      .mockResolvedValueOnce(respond(200, { account: { credits: 100, recurring_credits: 0, recurring_credits_frequency: null, recurring_credits_refresh_date: null } }))

    const credits = await getCredits()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(credits?.credits).toBe(100)
  })

  it("throws on 5xx so callTool can retry", async () => {
    fetchMock.mockResolvedValue(respond(500, { error: { type: "internal_error", message: "oops" } }))
    await expect(searchCompanies({ field: "basic_info.name", type: "=", value: "Stripe" }, 5)).rejects.toThrow(/HTTP 500/)
  })

  it("returns empty matches (not null) when identify finds nothing", async () => {
    fetchMock.mockResolvedValue(respond(200, [{ matched_on: "nope", match_type: "name", matches: [] }]))
    await expect(identifyCompany({ name: "nope" })).resolves.toEqual([])
  })
})
