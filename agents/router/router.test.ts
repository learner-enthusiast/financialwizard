import { beforeEach, describe, expect, it, vi } from "vitest"

import { runRouter, routeByRules, supportFor } from "@/agents/router"
import { scanForAdvice } from "@/agents/shared/advice"
import type { Entity } from "@/agents/types"
import { extract } from "@/lib/clients/llm"
import { testContext } from "@/tests/support/agent-mocks"

vi.mock("@/lib/clients/trace", async () => (await import("@/tests/support/agent-mocks")).traceMock())
vi.mock("@/lib/clients/callTool", async () => (await import("@/tests/support/agent-mocks")).callToolMock())
vi.mock("@/repositories/sources.repository", async () => (await import("@/tests/support/agent-mocks")).sourcesRepositoryMock())
vi.mock("@/lib/clients/llm", () => ({ extract: vi.fn(), complete: vi.fn() }))

const entity = (overrides: Partial<Entity> = {}): Entity => ({
  legalName: "Jio Platforms Limited",
  country: "IN",
  status: "unlisted",
  symbols: [],
  sourceIds: ["src_1"],
  ...overrides,
})

beforeEach(() => {
  vi.mocked(extract).mockResolvedValue({ instrument: "listed", reason: "The company already trades." })
})

describe("router", () => {
  it.each([
    [entity({ status: "ipo_filed" }), "Jio IPO", "ipo", true],
    [entity({ status: "unlisted" }), "Jio unlisted shares", "unlisted", true],
    [entity({ status: "unlisted" }), "Jio IPO", "ipo", true],
    [entity({ country: "US", status: "ipo_filed", legalName: "Zeta Inc." }), "Zeta IPO", "ipo", true],
    [entity({ country: "US", status: "listed", legalName: "Apple Inc.", symbols: ["US:AAPL"] }), "Apple", "listed", false],
    [entity({ country: "OTHER", status: "ipo_filed", legalName: "Foo GmbH" }), "Foo IPO", "ipo", false],
    [entity({ country: "US", status: "unlisted", legalName: "Stripe, Inc." }), "Stripe", "unlisted", false],
  ] as const)("routes %#: %s → %s (supported=%s) by rules", async (e, query, instrument, supported) => {
    const out = await runRouter({ entity: e, query }, testContext())
    expect(out).toMatchObject({ status: "ok", instrument, country: e.country, supported, basis: "rules" })
    if (!supported) expect(out.reason).toMatch(/not supported/)
    expect(extract).not.toHaveBeenCalled()
  })

  it("asks the LLM only when query wording conflicts with listing status", async () => {
    const out = await runRouter(
      { entity: entity({ status: "listed", symbols: ["NSE:JIOFIN"], legalName: "Jio Financial Services Limited" }), query: "Jio Financial IPO" },
      testContext()
    )
    expect(extract).toHaveBeenCalledOnce()
    expect(out).toMatchObject({ instrument: "listed", basis: "llm", supported: false })
  })

  it("falls back to the listing status when the LLM call fails", async () => {
    vi.mocked(extract).mockRejectedValue(new Error("rate limited"))
    const out = await runRouter({ entity: entity({ status: "listed", symbols: ["NSE:X"] }), query: "X ETF" }, testContext())
    expect(out).toMatchObject({ status: "ok", instrument: "listed", basis: "llm" })
  })

  it("returns failed on invalid input instead of throwing", async () => {
    const out = await runRouter({ query: "x" }, testContext())
    expect(out).toMatchObject({ status: "failed", supported: false })
  })

  it("has no advice language", async () => {
    const out = await runRouter({ entity: entity(), query: "Jio" }, testContext())
    expect(scanForAdvice(out)).toEqual([])
  })

  it("exposes pure helpers", () => {
    expect(routeByRules(entity({ status: "listed" }), "X etf")).toBeUndefined()
    expect(supportFor("IN", "unlisted").supported).toBe(true)
    expect(supportFor("IN", "mf").supported).toBe(false)
  })
})
