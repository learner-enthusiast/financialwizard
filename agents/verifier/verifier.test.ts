import { beforeEach, describe, expect, it, vi } from "vitest"

import { scanForAdvice } from "@/agents/shared/advice"
import type { Claim, Entity, SourceRef } from "@/agents/types"
import { dedupeSyndicated, isStale, runVerifier } from "@/agents/verifier"
import { extract } from "@/lib/clients/llm"
import { testContext } from "@/tests/support/agent-mocks"

vi.mock("@/lib/clients/trace", async () => (await import("@/tests/support/agent-mocks")).traceMock())
vi.mock("@/lib/clients/callTool", async () => (await import("@/tests/support/agent-mocks")).callToolMock())
vi.mock("@/repositories/sources.repository", async () => (await import("@/tests/support/agent-mocks")).sourcesRepositoryMock())
vi.mock("@/lib/clients/llm", () => ({ extract: vi.fn(), complete: vi.fn() }))

const entity: Entity = { legalName: "Example Tech Limited", domain: "exampletech.in", country: "IN", status: "ipo_filed", symbols: [], sourceIds: ["drhp"] }

const src = (id: string, kind: SourceRef["kind"], text: string, extra: Partial<SourceRef> = {}): SourceRef => ({
  id,
  kind,
  url: `https://example.org/${id}`,
  text,
  contentHash: `hash_${id}`,
  ...extra,
})

const claim = (overrides: Partial<Claim> = {}): Claim => ({
  id: "price_band.priceHigh",
  checkId: "price_band",
  field: "priceHigh",
  statement: "Price band upper end: ₹72 per share.",
  value: 72,
  sourceIds: ["drhp"],
  ...overrides,
})

const DRHP = src("drhp", "PRIMARY", "Example Tech Limited — Price Band: ₹68 to ₹72 per Equity Share.")
const NEWS = src("news", "NEWS", "Example Tech Limited IPO price band set at ₹70 to ₹74, reports say.")
const SITE = src("site", "COMPANY", "Example Tech Limited: our IPO price band is ₹68 to ₹72.")
const AI = src("ai", "AI_OVERVIEW", "Example Tech Limited IPO price band ₹68-₹72")

function judgeWith(judgements: Array<{ sourceId: string; stance: "states" | "contradicts" | "silent"; quote: string | null; sourceSays?: string | null }>) {
  vi.mocked(extract).mockResolvedValue({ judgements: judgements.map((j) => ({ sourceSays: null, ...j })) })
}

beforeEach(() => {
  vi.mocked(extract).mockReset()
})

describe("verifier v2", () => {
  it("supports a claim stated by a primary source with a verbatim quote", async () => {
    judgeWith([{ sourceId: "drhp", stance: "states", quote: "₹68 to ₹72 per Equity Share" }])
    const out = await runVerifier({ entity, claims: [claim()], sources: [DRHP] }, testContext())

    expect(out.verdicts[0]).toMatchObject({ verdict: "supported", quote: "₹68 to ₹72 per Equity Share", sourceIds: ["drhp"] })
    expect(out.counts).toEqual({ supported: 1, contradicted: 0, unsupported: 0, stale: 0 })
  })

  it("treats a stance whose quote is not in the passage as silent", async () => {
    judgeWith([{ sourceId: "drhp", stance: "states", quote: "₹72 upper band confirmed" }])
    const out = await runVerifier({ entity, claims: [claim()], sources: [DRHP] }, testContext())
    expect(out.verdicts[0]!.verdict).toBe("unsupported")
  })

  it("does not let the company's own site confirm its own claim", async () => {
    judgeWith([{ sourceId: "site", stance: "states", quote: "our IPO price band is ₹68 to ₹72" }])
    const out = await runVerifier({ entity, claims: [claim({ sourceIds: ["site"] })], sources: [SITE] }, testContext())
    expect(out.verdicts[0]).toMatchObject({ verdict: "unsupported", reason: expect.stringMatching(/company's own/) })
  })

  it("never accepts an AI overview as evidence (no LLM call needed)", async () => {
    const out = await runVerifier({ entity, claims: [claim({ sourceIds: ["ai"] })], sources: [AI] }, testContext())
    expect(out.verdicts[0]).toMatchObject({ verdict: "unsupported", reason: expect.stringMatching(/AI overview/) })
    expect(extract).not.toHaveBeenCalled()
  })

  it("rejects sources that do not name the resolved company", async () => {
    const other = src("other", "PRIMARY", "Another Company Ltd — Price Band: ₹68 to ₹72.")
    const out = await runVerifier({ entity, claims: [claim({ sourceIds: ["other"] })], sources: [other] }, testContext())
    expect(out.verdicts[0]).toMatchObject({ verdict: "unsupported", reason: "No cited source names Example Tech Limited." })
  })

  it("counts syndicated copies once", async () => {
    const copyA = src("copyA", "NEWS", "Example Tech Limited price band ₹68 to ₹72", { contentHash: "same" })
    const copyB = src("copyB", "NEWS", "Example Tech Limited price band ₹68 to ₹72", { contentHash: "same" })
    judgeWith([{ sourceId: "copyA", stance: "states", quote: "price band ₹68 to ₹72" }])

    await runVerifier({ entity, claims: [claim({ sourceIds: ["copyA", "copyB"] })], sources: [copyA, copyB] }, testContext())

    const prompt = vi.mocked(extract).mock.calls[0]![0]
    expect(prompt.match(/\[copy[AB]\]/g)).toHaveLength(1)
    expect(dedupeSyndicated([copyA, copyB])).toHaveLength(1)
  })

  it("resolves conflicts by source rank and reports both sides", async () => {
    judgeWith([
      { sourceId: "drhp", stance: "states", quote: "₹68 to ₹72 per Equity Share", sourceSays: "upper price ₹72" },
      { sourceId: "news", stance: "contradicts", quote: "₹70 to ₹74", sourceSays: "upper price ₹74" },
    ])
    const out = await runVerifier({ entity, claims: [claim({ sourceIds: ["drhp", "news"] })], sources: [DRHP, NEWS] }, testContext())

    expect(out.verdicts[0]!.verdict).toBe("supported")
    expect(out.conflicts).toEqual([
      {
        claimId: "price_band.priceHigh",
        sourceA: { id: "drhp", says: "upper price ₹72" },
        sourceB: { id: "news", says: "upper price ₹74" },
        winnerId: "drhp",
        why: "primary source outranks news source",
      },
    ])
  })

  it("flags figures older than the latest reported period as stale", async () => {
    const fin = src("fin", "PRIMARY", "Example Tech Limited revenue for FY2023 was ₹900 crore.")
    judgeWith([{ sourceId: "fin", stance: "states", quote: "revenue for FY2023 was ₹900 crore" }])
    const out = await runVerifier(
      { entity, claims: [claim({ id: "financials.revenueLatest", period: "FY2023", statement: "Revenue: ₹900 crore (FY2023).", sourceIds: ["fin"] })], sources: [fin], latestReportedPeriod: "FY2025" },
      testContext()
    )
    expect(out.verdicts[0]).toMatchObject({ verdict: "supported", stale: true })
    expect(out.counts.stale).toBe(1)
    expect(isStale(claim({ period: "FY2025" }), "FY2025")).toBe(false)
  })

  it("marks computed claims supported only when every input is supported", async () => {
    judgeWith([{ sourceId: "drhp", stance: "states", quote: "₹68 to ₹72 per Equity Share" }])
    const computed = claim({ id: "computed.market_cap_at_high", field: "market_cap_at_high", statement: "Market value: ₹7,200 crore.", derivedFrom: ["price_band.priceHigh", "share_capital.shares"], sourceIds: ["drhp"] })
    const out = await runVerifier({ entity, claims: [claim(), computed], sources: [DRHP] }, testContext())

    expect(out.verdicts.find((v) => v.claimId === "computed.market_cap_at_high")!.verdict).toBe("unsupported")
  })

  it("marks claims without sources unsupported and handles LLM failure without throwing", async () => {
    vi.mocked(extract).mockRejectedValue(new Error("overloaded"))
    const out = await runVerifier({ entity, claims: [claim({ sourceIds: [] }), claim({ id: "b" })], sources: [DRHP] }, testContext())
    expect(out.status).toBe("ok")
    expect(out.verdicts.map((v) => v.verdict)).toEqual(["unsupported", "unsupported"])
  })

  it("returns unverifiable when there are no claims, and has no advice language", async () => {
    const out = await runVerifier({ entity, claims: [], sources: [] }, testContext())
    expect(out.status).toBe("unverifiable")
    expect(scanForAdvice(out)).toEqual([])
  })
})

describe("verifier v1 (naive baseline)", () => {
  it("accepts any claim with any source, including AI overviews and the company's own site", async () => {
    const out = await runVerifier(
      { entity, claims: [claim({ id: "a", sourceIds: ["ai"] }), claim({ id: "b", sourceIds: ["site"] })], sources: [AI, SITE] },
      testContext("v1")
    )
    expect(out.verdicts.map((v) => v.verdict)).toEqual(["supported", "supported"])
    expect(extract).not.toHaveBeenCalled()
  })
})
