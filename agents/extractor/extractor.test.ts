import { beforeEach, describe, expect, it, vi } from "vitest"

import { prepareSourceText, runExtractor } from "@/agents/extractor"
import { scanForAdvice } from "@/agents/shared/advice"
import type { Entity, SourceRef } from "@/agents/types"
import { extract } from "@/lib/clients/llm"
import { testContext } from "@/tests/support/agent-mocks"

vi.mock("@/lib/clients/trace", async () => (await import("@/tests/support/agent-mocks")).traceMock())
vi.mock("@/lib/clients/callTool", async () => (await import("@/tests/support/agent-mocks")).callToolMock())
vi.mock("@/repositories/sources.repository", async () => (await import("@/tests/support/agent-mocks")).sourcesRepositoryMock())
vi.mock("@/lib/clients/llm", () => ({ extract: vi.fn(), complete: vi.fn() }))

const entity: Entity = { legalName: "Example Tech Limited", country: "IN", status: "ipo_filed", symbols: [], sourceIds: ["src_e"] }

const source = (id: string, text: string, kind: SourceRef["kind"] = "PRIMARY"): SourceRef => ({
  id,
  url: `https://www.sebi.gov.in/${id}.pdf`,
  kind,
  text,
  contentHash: `h_${id}`,
})

const field = (value: unknown, quote: string | null, sourceIds: string[], scale: string | null = "units", currency: string | null = "INR") => ({
  value,
  scale,
  currency,
  period: null,
  quote,
  sourceIds,
})
const empty = field(null, null, [], null, null)

const PRICE_SOURCE = source("drhp", "THE OFFER. Price Band: ₹68 to ₹72 per Equity Share. Bid Lot: 208 Equity Shares and in multiples thereof.")

beforeEach(() => {
  vi.mocked(extract).mockReset()
})

describe("extractor v2", () => {
  it("extracts inputs with verified quotes and computes market value in code", async () => {
    vi.mocked(extract).mockResolvedValue({
      fields: {
        priceLow: field(68, "₹68 to ₹72", ["drhp"]),
        priceHigh: field(72, "₹68 to ₹72", ["drhp"]),
        lotSize: field(208, "Bid Lot: 208 Equity Shares", ["drhp"], "units", null),
      },
    })

    const out = await runExtractor(
      {
        checkId: "price_band",
        entity,
        sources: [PRICE_SOURCE],
        priorFields: {
          sharesOutstandingPostIssue: { value: 1_000_000_000, kind: "count", claimId: "share_capital.sharesOutstandingPostIssue", sourceIds: ["cap"] },
        },
      },
      testContext()
    )

    expect(out.status).toBe("ok")
    expect(out.fields.priceHigh).toMatchObject({ value: 72, currency: "INR", sourceIds: ["drhp"] })
    expect(out.computed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "market_cap_at_high", value: 72_000_000_000, origin: "code", sourceIds: expect.arrayContaining(["drhp", "cap"]) }),
      ])
    )
    const capClaim = out.claims.find((c) => c.field === "market_cap_at_high")!
    expect(capClaim.statement).toBe("Market value at the upper price: ₹7,200 crore.")
    expect(capClaim.derivedFrom).toEqual(["price_band.priceHigh", "share_capital.sharesOutstandingPostIssue"])
    for (const claim of out.claims) expect(claim.sourceIds.length).toBeGreaterThan(0)
  })

  it("applies the printed scale in code (crore) and computes OFS %", async () => {
    vi.mocked(extract).mockResolvedValue({
      fields: {
        freshIssueAmount: field(500, "Fresh Issue of up to ₹500 crore", ["drhp"], "crore"),
        ofsAmount: field(1500, "Offer for Sale of up to ₹1,500 crore", ["drhp"], "crore"),
      },
    })
    const out = await runExtractor(
      { checkId: "issue_structure", entity, sources: [source("drhp", "Fresh Issue of up to ₹500 crore and an Offer for Sale of up to ₹1,500 crore")] },
      testContext()
    )
    expect(out.fields.freshIssueAmount!.value).toBe(5_000_000_000)
    expect(out.computed.find((c) => c.metric === "ofs_percent")).toMatchObject({ value: 75, origin: "code" })
  })

  it("drops fields whose quote is not in the cited source, or that cite unknown sources", async () => {
    vi.mocked(extract).mockResolvedValue({
      fields: {
        priceLow: field(60, "₹60 to ₹72", ["drhp"]),
        priceHigh: field(72, "₹68 to ₹72", ["made_up_source"]),
        lotSize: empty,
      },
    })
    const out = await runExtractor({ checkId: "price_band", entity, sources: [PRICE_SOURCE] }, testContext())

    expect(out.status).toBe("unverifiable")
    expect(out.missing.sort()).toEqual(["lotSize", "priceHigh", "priceLow"])
    expect(out.claims).toEqual([])
  })

  it("does not convert currencies: a USD figure in an Indian filing is marked missing", async () => {
    vi.mocked(extract).mockResolvedValue({
      fields: { freshIssueAmount: field(60, "USD 60 million", ["drhp"], "million", "USD"), ofsAmount: empty },
    })
    const out = await runExtractor({ checkId: "issue_structure", entity, sources: [source("drhp", "fresh issue of USD 60 million")] }, testContext())
    expect(out.missing).toContain("freshIssueAmount (reported in USD; not converted)")
  })

  it("passes only the check's sections of a long filing, never the whole document", async () => {
    vi.mocked(extract).mockResolvedValue({ fields: { sharesOutstandingPostIssue: empty } })
    const filler = "Unrelated risk factor text. ".repeat(2000)
    const longFiling = source("drhp", `${filler}CAPITAL STRUCTURE Post-issue shares: 1,000,000. ${filler}`)

    await runExtractor({ checkId: "share_capital", entity, sources: [longFiling] }, testContext())

    const prompt = vi.mocked(extract).mock.calls[0]![0]
    expect(prompt.length).toBeLessThan(longFiling.text.length / 2)
    expect(prompt).toContain("CAPITAL STRUCTURE Post-issue shares")
    expect(prepareSourceText(longFiling, ["Capital Structure"]).startsWith("CAPITAL STRUCTURE")).toBe(true)
  })

  it("returns unverifiable (not an exception) with no sources or when the LLM fails", async () => {
    const noSources = await runExtractor({ checkId: "price_band", entity, sources: [] }, testContext())
    expect(noSources).toMatchObject({ status: "unverifiable", missing: ["priceLow", "priceHigh", "lotSize"] })

    vi.mocked(extract).mockImplementation(async () => {
      throw new Error("model overloaded")
    })
    const llmDown = await runExtractor({ checkId: "price_band", entity, sources: [PRICE_SOURCE] }, testContext())
    expect(llmDown.status).toBe("unverifiable")
  })

  it("asks the v2 model for inputs only (no valuation field in the schema)", async () => {
    vi.mocked(extract).mockResolvedValue({ fields: { priceLow: empty, priceHigh: empty, lotSize: empty } })
    await runExtractor({ checkId: "price_band", entity, sources: [PRICE_SOURCE] }, testContext())
    const schema = vi.mocked(extract).mock.calls[0]![1] as unknown as { shape: Record<string, unknown> }
    expect(Object.keys(schema.shape)).toEqual(["fields"])
  })
})

describe("extractor v1 (naive baseline)", () => {
  it("lets the LLM state valuation and skips quote checks", async () => {
    vi.mocked(extract).mockResolvedValue({
      fields: { priceLow: field(68, "not a real quote", ["drhp"]), priceHigh: field(72, null, ["drhp"]), lotSize: empty },
      valuation: { marketCap: 80_000_000_000, peRatio: 45, psRatio: null, sourceIds: ["drhp"] },
    })
    const out = await runExtractor({ checkId: "price_band", entity, sources: [PRICE_SOURCE] }, testContext("v1"))

    expect(out.fields.priceLow!.value).toBe(68)
    expect(out.computed).toEqual(
      expect.arrayContaining([expect.objectContaining({ metric: "market_cap_llm", value: 80_000_000_000, origin: "llm" })])
    )
    expect(out.computed.every((c) => c.origin === "llm")).toBe(true)
  })
})

describe("extractor policy", () => {
  it("produces no advice language", async () => {
    vi.mocked(extract).mockResolvedValue({
      fields: { priceLow: field(68, "₹68 to ₹72", ["drhp"]), priceHigh: field(72, "₹68 to ₹72", ["drhp"]), lotSize: empty },
    })
    const out = await runExtractor({ checkId: "price_band", entity, sources: [PRICE_SOURCE] }, testContext())
    expect(scanForAdvice(out)).toEqual([])
  })
})
