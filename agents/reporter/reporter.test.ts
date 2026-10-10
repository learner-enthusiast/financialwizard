import { beforeEach, describe, expect, it, vi } from "vitest"

import { DISCLAIMER, runReporter, sentencePasses } from "@/agents/reporter"
import type { ReporterInput } from "@/agents/reporter"
import { scanForAdvice } from "@/agents/shared/advice"
import type { Claim } from "@/agents/types"
import { extract } from "@/lib/clients/llm"
import { testContext } from "@/tests/support/agent-mocks"

vi.mock("@/lib/clients/trace", async () => (await import("@/tests/support/agent-mocks")).traceMock())
vi.mock("@/lib/clients/callTool", async () => (await import("@/tests/support/agent-mocks")).callToolMock())
vi.mock("@/repositories/sources.repository", async () => (await import("@/tests/support/agent-mocks")).sourcesRepositoryMock())
vi.mock("@/lib/clients/llm", () => ({ extract: vi.fn(), complete: vi.fn() }))

const c = (id: string, checkId: string, field: string, statement: string, value: Claim["value"], extra: Partial<Claim> = {}): Claim => ({
  id,
  checkId,
  field,
  statement,
  value,
  sourceIds: [`s_${id}`],
  ...extra,
})

const CLAIMS: Claim[] = [
  c("price_band.priceLow", "price_band", "priceLow", "Price band lower end: ₹68 per share.", 68),
  c("price_band.priceHigh", "price_band", "priceHigh", "Price band upper end: ₹72 per share.", 72),
  c("computed.market_cap_at_high", "price_band", "market_cap_at_high", "Market value at the upper price: ₹7,200 crore.", 72_000_000_000, { derivedFrom: ["price_band.priceHigh"] }),
  c("issue_structure.freshIssueAmount", "issue_structure", "freshIssueAmount", "Fresh issue size: ₹500 crore.", 5e9),
  c("computed.ofs_percent", "issue_structure", "ofs_percent", "Share of the issue that is offer for sale: 75%.", 75),
  c("financials.netIncomeLatest", "financials", "netIncomeLatest", "Net profit or loss (latest period): -₹120 crore (FY2025).", -1.2e9, { period: "FY2025" }),
  c("financials.revenueLatest", "financials", "revenueLatest", "Revenue (latest period): ₹900 crore (FY2025).", 9e9, { period: "FY2025" }),
]

function input(overrides: Partial<ReporterInput> = {}): ReporterInput {
  const supportedIds = CLAIMS.filter((claim) => claim.id !== "financials.revenueLatest").map((claim) => claim.id)
  return {
    entity: { legalName: "Example Tech Limited", country: "IN", status: "ipo_filed", symbols: [], sourceIds: ["s_e"] },
    route: { instrument: "ipo", country: "IN", supported: true },
    findings: [
      { status: "ok", checkId: "price_band", fields: {}, computed: [], missing: ["lotSize"], claims: [] },
      { status: "ok", checkId: "issue_structure", fields: {}, computed: [], missing: [], claims: [] },
      { status: "ok", checkId: "financials", fields: {}, computed: [], missing: [], claims: [] },
    ],
    claims: CLAIMS,
    verifier: {
      status: "ok",
      verdicts: CLAIMS.map((claim) => ({
        claimId: claim.id,
        verdict: supportedIds.includes(claim.id) ? ("supported" as const) : ("unsupported" as const),
        reason: "x",
        sourceIds: claim.sourceIds,
        stale: false,
      })),
      counts: { supported: supportedIds.length, contradicted: 0, unsupported: 1, stale: 0 },
      conflicts: [],
      claims: [],
    },
    ...overrides,
  }
}

const LLM_SUMMARIES = {
  summaries: [
    {
      checkId: "price_band",
      sentences: [
        { text: "Shares are offered between ₹68 and ₹72 each.", claimIds: ["price_band.priceLow", "price_band.priceHigh"] },
        { text: "At ₹72 the company would be valued at ₹9,000 crore.", claimIds: ["price_band.priceHigh"] },
        { text: "This is a strong buy at this price.", claimIds: ["price_band.priceHigh"] },
      ],
    },
    {
      checkId: "financials",
      sentences: [
        { text: "Revenue was ₹900 crore in FY2025.", claimIds: ["financials.revenueLatest"] },
        { text: "The company lost ₹120 crore in FY2025.", claimIds: ["financials.netIncomeLatest"] },
      ],
    },
  ],
}

beforeEach(() => {
  vi.mocked(extract).mockReset()
  vi.mocked(extract).mockResolvedValue(LLM_SUMMARIES)
})

describe("reporter v2", () => {
  it("writes only from supported claims and removes unmatched sentences in the self-check", async () => {
    const out = await runReporter(input(), testContext())

    const price = out.checkSummaries.find((s) => s.checkId === "price_band")!
    expect(price.sentences.map((s) => s.text)).toEqual(["Shares are offered between ₹68 and ₹72 each."])
    const fin = out.checkSummaries.find((s) => s.checkId === "financials")!
    expect(fin.sentences.map((s) => s.text)).toEqual(["The company lost ₹120 crore in FY2025."])
    // invented ₹9,000 crore, advice wording, and the unsupported revenue claim are removed
    expect(out.removedSentences).toBe(3)
    for (const sentence of [...price.sentences, ...fin.sentences]) expect(sentence.sourceIds.length).toBeGreaterThan(0)
  })

  it("never sends unsupported claims to the LLM", async () => {
    await runReporter(input(), testContext())
    expect(vi.mocked(extract).mock.calls[0]![0]).not.toContain("financials.revenueLatest")
  })

  it("lists key numbers with sources, red flags, unverifiable items and questions", async () => {
    const out = await runReporter(input(), testContext())

    expect(out.keyNumbers.map((k) => [k.label, k.value])).toEqual([
      ["Price band lower end", "₹68 per share"],
      ["Price band upper end", "₹72 per share"],
      ["Market value at the upper price", "₹7,200 crore"],
      ["Share of the issue that is offer for sale", "75%"],
      ["Net profit or loss (latest period)", "-₹120 crore (FY2025)"],
    ])
    expect(out.redFlags.map((f) => f.text)).toEqual([
      "Most of the issue (75%) is an offer for sale by existing holders, not new money for the company.",
      "The company reported a loss in FY2025.",
    ])
    expect(out.unverifiable).toEqual(
      expect.arrayContaining(["Minimum lot size (shares): not stated in the sources found.", "Revenue (latest period): could not be verified."])
    )
    expect(out.questions.length).toBeGreaterThan(0)
    expect(out.checkSummaries.find((s) => s.checkId === "financials")!.status).toBe("flag")
    expect(out.disclaimer).toBe("Evidence, not advice.")
    expect(out.currency).toBe("INR")
  })

  it("contains no investment-advice language anywhere in the report", async () => {
    const out = await runReporter(input(), testContext())
    expect(scanForAdvice(out)).toEqual([])
    expect(JSON.stringify(out)).not.toMatch(/\b(buy|sell|strong|guaranteed|price target|recommend)/i)
  })

  it("still produces a report (deterministic sections) when the LLM fails", async () => {
    vi.mocked(extract).mockRejectedValue(new Error("down"))
    const out = await runReporter(input(), testContext())
    expect(out.status).toBe("ok")
    expect(out.keyNumbers.length).toBeGreaterThan(0)
    expect(out.checkSummaries.every((s) => s.sentences.length === 0)).toBe(true)
  })

  it("states plainly that nothing was verifiable when no claim is supported", async () => {
    const base = input()
    const out = await runReporter(
      input({ verifier: { ...base.verifier, verdicts: base.verifier.verdicts.map((v) => ({ ...v, verdict: "unsupported" as const })) } }),
      testContext()
    )
    expect(out.status).toBe("unverifiable")
    expect(out.keyNumbers).toEqual([])
    expect(out.unverifiable.length).toBeGreaterThan(0)
    expect(out.disclaimer).toBe(DISCLAIMER)
  })

  it("self-check helper rejects sentences with numbers not in their claims", () => {
    const byId = new Map(CLAIMS.map((claim) => [claim.id, claim]))
    const usable = new Set(CLAIMS.map((claim) => claim.id))
    expect(sentencePasses({ text: "Upper end is ₹72.", claimIds: ["price_band.priceHigh"] }, byId, usable)).toBe(true)
    expect(sentencePasses({ text: "Upper end is ₹74.", claimIds: ["price_band.priceHigh"] }, byId, usable)).toBe(false)
    expect(sentencePasses({ text: "Upper end is ₹72.", claimIds: [] }, byId, usable)).toBe(false)
  })
})

describe("reporter v1 (naive baseline)", () => {
  it("writes from every claim without a self-check", async () => {
    vi.mocked(extract).mockResolvedValue({
      summaries: [{ checkId: "financials", sentences: [{ text: "Revenue was ₹900 crore in FY2025.", claimIds: ["financials.revenueLatest"] }] }],
    })
    const out = await runReporter(input(), testContext("v1"))
    expect(out.checkSummaries.find((s) => s.checkId === "financials")!.sentences).toHaveLength(1)
    expect(out.keyNumbers.map((k) => k.label)).toContain("Revenue (latest period)")
    expect(out.removedSentences).toBe(0)
  })
})
