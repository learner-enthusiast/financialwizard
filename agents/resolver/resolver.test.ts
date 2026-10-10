import { beforeEach, describe, expect, it, vi } from "vitest"

import { runResolver } from "@/agents/resolver"
import { ambiguityQuestion, detectIntent, isDecisive, nameMatch } from "@/agents/resolver"
import { scanForAdvice } from "@/agents/shared/advice"
import { searchTickers } from "@/lib/clients/edgar"
import { scrapePage } from "@/lib/clients/firecrawl"
import { listKnownCompanies } from "@/lib/clients/inFilings"
import { identifyCompany } from "@/lib/clients/crustdata"
import { extract } from "@/lib/clients/llm"
import { search } from "@/lib/clients/serp"
import { lookupCompany } from "@/lib/clients/wikidata"
import { testContext } from "@/tests/support/agent-mocks"

vi.mock("@/lib/clients/trace", async () => (await import("@/tests/support/agent-mocks")).traceMock())
vi.mock("@/lib/clients/callTool", async () => (await import("@/tests/support/agent-mocks")).callToolMock())
vi.mock("@/repositories/sources.repository", async () => (await import("@/tests/support/agent-mocks")).sourcesRepositoryMock())
vi.mock("@/lib/clients/llm", () => ({ extract: vi.fn(), complete: vi.fn() }))
vi.mock("@/lib/clients/serp", () => ({ search: vi.fn() }))
vi.mock("@/lib/clients/wikidata", () => ({ lookupCompany: vi.fn() }))
vi.mock("@/lib/clients/edgar", () => ({ searchTickers: vi.fn() }))
vi.mock("@/lib/clients/inFilings", () => ({ listKnownCompanies: vi.fn() }))
vi.mock("@/lib/clients/firecrawl", () => ({ scrapePage: vi.fn() }))
vi.mock("@/lib/clients/crustdata", () => ({ identifyCompany: vi.fn(async () => []) }))

const JIO_SERP = {
  organic: [
    { position: 1, title: "Jio Financial Services Ltd share price", link: "https://www.nseindia.com/get-quotes/equity?symbol=JIOFIN", snippet: "Jio Financial Services Limited (JIOFIN) is listed on NSE." },
    { position: 2, title: "Jio Platforms IPO: what we know", link: "https://economictimes.com/jio-platforms-ipo", snippet: "Jio Platforms Limited, the unlisted digital arm, is preparing an IPO." },
    { position: 3, title: "Jio Platforms Limited", link: "https://www.jio.com/platforms", snippet: "Jio Platforms Limited — jio.com" },
    { position: 4, title: "Jio Financial Services results", link: "https://www.livemint.com/jfs", snippet: "Jio Financial Services Limited posted results." },
  ],
  knowledgeGraph: undefined,
  aiOverview: { textBlocks: [{ snippet: "Jio Platforms IPO expected next year at a strong valuation" }] },
}

const JIO_LLM = {
  candidates: [
    { legalName: "Jio Financial Services Limited", domain: null, country: "IN", status: "listed", matchesQuery: "partial", resultIndexes: [0, 3] },
    { legalName: "Jio Platforms Limited", domain: "jio.com", country: "IN", status: "unlisted", matchesQuery: "partial", resultIndexes: [1, 2] },
  ],
}

beforeEach(() => {
  vi.mocked(listKnownCompanies).mockResolvedValue([])
  vi.mocked(searchTickers).mockResolvedValue([])
  vi.mocked(lookupCompany).mockResolvedValue(null)
  vi.mocked(scrapePage).mockResolvedValue("")
  vi.mocked(identifyCompany).mockResolvedValue([])
  vi.mocked(search).mockResolvedValue({ organic: [] })
  vi.mocked(extract).mockResolvedValue({ candidates: [] })
})

describe("resolver v2", () => {
  it("asks the user to choose for 'Jio' (listed Jio Financial vs unlisted Jio Platforms)", async () => {
    vi.mocked(listKnownCompanies).mockResolvedValue([
      { legalName: "Jio Financial Services Limited", status: "listed", nseSymbol: "JIOFIN", domain: "jfs.in" },
      { legalName: "Jio Platforms Limited", status: "unlisted", domain: "jio.com" },
    ])
    vi.mocked(lookupCompany).mockResolvedValue({ id: "Q24589", label: "Jio", description: "Indian telecom brand", website: "https://www.jio.com" })
    vi.mocked(search).mockResolvedValue(JIO_SERP)
    vi.mocked(extract).mockResolvedValue(JIO_LLM)

    const out = await runResolver({ query: "Jio", countryHint: "IN" }, testContext())

    expect(out.status).toBe("ok")
    expect(out.needsUserChoice).toBe(true)
    expect(out.entity).toBeUndefined()
    const names = out.candidates.map((c) => c.legalName)
    expect(names).toEqual(expect.arrayContaining(["Jio Financial Services Limited", "Jio Platforms Limited"]))
    const jfs = out.candidates.find((c) => c.legalName.startsWith("Jio Financial"))!
    const jpl = out.candidates.find((c) => c.legalName.startsWith("Jio Platforms"))!
    expect(jfs).toMatchObject({ status: "listed", symbols: ["NSE:JIOFIN"] })
    expect(jpl).toMatchObject({ status: "unlisted", domain: "jio.com" })
    expect(out.question).toMatch(/^Which company do you mean: .+ or .+\?$/)
    for (const c of out.candidates) expect(c.sourceIds.length).toBeGreaterThan(0)
  })

  it("ranks unlisted/ipo_filed above listed when the intent is IPO", async () => {
    vi.mocked(search).mockResolvedValue(JIO_SERP)
    vi.mocked(extract).mockResolvedValue(JIO_LLM)

    const out = await runResolver({ query: "Jio IPO", countryHint: "IN" }, testContext())

    expect(out.intent).toBe("ipo")
    expect(out.candidates[0]!.legalName).toBe("Jio Platforms Limited")
  })

  it("stops early on a decisive US match and returns the entity with sourced claims", async () => {
    vi.mocked(searchTickers).mockResolvedValue([{ cik: "0000320193", ticker: "AAPL", title: "Apple Inc." }])
    vi.mocked(lookupCompany).mockResolvedValue({ id: "Q312", label: "Apple Inc.", description: "American technology company", website: "https://www.apple.com" })
    vi.mocked(search).mockResolvedValue({
      organic: [
        { title: "Apple Inc. (AAPL)", link: "https://finance.yahoo.com/quote/AAPL", snippet: "Apple Inc. designs consumer electronics." },
        { title: "Apple Inc. 10-K", link: "https://www.sec.gov/aapl-10k", snippet: "Apple Inc. annual report" },
        { title: "Apple Inc.", link: "https://www.apple.com", snippet: "Apple Inc. official site" },
      ],
    })
    vi.mocked(extract).mockResolvedValue({
      candidates: [{ legalName: "Apple Inc.", domain: "apple.com", country: "US", status: "listed", matchesQuery: "exact", resultIndexes: [0, 1, 2] }],
    })

    const out = await runResolver({ query: "Apple", countryHint: "US" }, testContext())

    expect(out.needsUserChoice).toBe(false)
    expect(out.entity).toMatchObject({ legalName: "Apple Inc.", country: "US", status: "listed", cik: "0000320193", symbols: ["US:AAPL"], domain: "apple.com" })
    expect(out.candidates[0]!.confidence).toBeGreaterThanOrEqual(0.85)
    expect(out.claims.map((c) => c.field)).toEqual(expect.arrayContaining(["legalName", "status", "cik"]))
    for (const claim of out.claims) expect(claim.sourceIds.length).toBeGreaterThan(0)
    expect(scrapePage).not.toHaveBeenCalled() // decided before the company-site step
  })

  it("uses free Crustdata identify to fill a missing domain when the legal name matches", async () => {
    vi.mocked(search).mockResolvedValue({
      organic: [{ title: "Acme Robotics Private Limited", link: "https://news.example/acme", snippet: "Acme Robotics Private Limited raised a round." }],
    })
    vi.mocked(extract).mockResolvedValue({
      candidates: [{ legalName: "Acme Robotics Private Limited", domain: null, country: "IN", status: "unlisted", matchesQuery: "exact", resultIndexes: [0] }],
    })
    vi.mocked(identifyCompany).mockResolvedValue([
      { confidenceScore: 0.97, company: { basic_info: { name: "Acme Robotics Pvt Ltd", primary_domain: "acmerobotics.in" } } },
    ])

    const out = await runResolver({ query: "Acme Robotics" }, testContext())

    expect(identifyCompany).toHaveBeenCalledWith({ name: "Acme Robotics Private Limited" }, expect.objectContaining({ onUsage: expect.any(Function) }))
    expect(out.candidates[0]!.domain).toBe("acmerobotics.in")
  })

  it("never keeps a domain that no cited result shows", async () => {
    vi.mocked(search).mockResolvedValue({
      organic: [{ title: "Acme Robotics Pvt Ltd raises funds", link: "https://news.example/acme", snippet: "Acme Robotics Private Limited raised a round." }],
    })
    vi.mocked(extract).mockResolvedValue({
      candidates: [{ legalName: "Acme Robotics Private Limited", domain: "acme-invented.com", country: "IN", status: "unlisted", matchesQuery: "exact", resultIndexes: [0] }],
    })

    const out = await runResolver({ query: "Acme Robotics" }, testContext())

    expect(out.candidates[0]!.domain).toBeUndefined()
    expect(out.candidates[0]!.symbols).toEqual([])
  })

  it("treats AI overviews as leads only: low confidence, no status", async () => {
    vi.mocked(search).mockResolvedValue({ organic: [], aiOverview: { textBlocks: [{ snippet: "Zeta Corp is filing for an IPO" }] } })
    vi.mocked(extract).mockResolvedValue({
      candidates: [{ legalName: "Zeta Corp", domain: null, country: null, status: "ipo_filed", matchesQuery: "exact", resultIndexes: [0] }],
    })

    const out = await runResolver({ query: "Zeta" }, testContext())

    expect(out.needsUserChoice).toBe(true)
    expect(out.candidates[0]).toMatchObject({ confidence: 0.1, status: "unlisted" })
  })

  it("returns unverifiable (not an exception) when every source fails", async () => {
    vi.mocked(search).mockRejectedValue(new Error("SerpAPI HTTP 500"))
    vi.mocked(lookupCompany).mockRejectedValue(new Error("down"))

    const out = await runResolver({ query: "Nothing Matches" }, testContext())

    expect(out).toMatchObject({ status: "unverifiable", candidates: [], needsUserChoice: false })
  })

  it("returns failed for invalid input", async () => {
    const out = await runResolver({ query: "" }, testContext())
    expect(out.status).toBe("failed")
  })
})

describe("resolver v1 (naive baseline)", () => {
  it("takes the first plausible search result and never asks", async () => {
    vi.mocked(search).mockResolvedValue(JIO_SERP)
    vi.mocked(extract).mockResolvedValue(JIO_LLM)

    const out = await runResolver({ query: "Jio", countryHint: "IN" }, testContext("v1"))

    expect(out.needsUserChoice).toBe(false)
    expect(out.entity?.legalName).toBe("Jio Financial Services Limited")
    expect(listKnownCompanies).not.toHaveBeenCalled()
    expect(lookupCompany).not.toHaveBeenCalled()
  })
})

describe("resolver helpers and policy", () => {
  it("matches names and detects intent", () => {
    expect(nameMatch("jio", "Jio Platforms Limited")).toBe("partial")
    expect(nameMatch("Apple", "Apple Inc.")).toBe("exact")
    expect(nameMatch("pple", "Apple Inc.")).toBeNull()
    expect(detectIntent("Swiggy IPO")).toBe("ipo")
    expect(detectIntent("Apple")).toBe("any")
  })

  it("applies the decisive threshold and gap", () => {
    expect(isDecisive([{ confidence: 0.9 }, { confidence: 0.74 }])).toBe(true)
    expect(isDecisive([{ confidence: 0.9 }, { confidence: 0.8 }])).toBe(false)
    expect(isDecisive([{ confidence: 0.8 }])).toBe(false)
  })

  it("contains no investment-advice language in outputs or questions", async () => {
    vi.mocked(search).mockResolvedValue(JIO_SERP)
    vi.mocked(extract).mockResolvedValue(JIO_LLM)
    const out = await runResolver({ query: "Jio" }, testContext())
    expect(scanForAdvice(out)).toEqual([])
    expect(
      scanForAdvice({ q: ambiguityQuestion(out.candidates) })
    ).toEqual([])
  })
})
