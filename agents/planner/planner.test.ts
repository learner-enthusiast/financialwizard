import { beforeEach, describe, expect, it, vi } from "vitest"

import { runPlanner } from "@/agents/planner"
import { scanForAdvice } from "@/agents/shared/advice"
import type { Entity } from "@/agents/types"
import { extract } from "@/lib/clients/llm"
import { testContext } from "@/tests/support/agent-mocks"

vi.mock("@/lib/clients/trace", async () => (await import("@/tests/support/agent-mocks")).traceMock())
vi.mock("@/lib/clients/callTool", async () => (await import("@/tests/support/agent-mocks")).callToolMock())
vi.mock("@/repositories/sources.repository", async () => (await import("@/tests/support/agent-mocks")).sourcesRepositoryMock())
vi.mock("@/lib/clients/llm", () => ({ extract: vi.fn(), complete: vi.fn() }))

const entity = (overrides: Partial<Entity> = {}): Entity => ({
  legalName: "Example Tech Limited",
  country: "IN",
  status: "ipo_filed",
  symbols: [],
  sourceIds: ["src_1"],
  ...overrides,
})

const route = (country: "IN" | "US", instrument: "ipo" | "unlisted" | "listed", supported = true) => ({ country, instrument, supported })

beforeEach(() => {
  vi.mocked(extract).mockResolvedValue({ skip: [] })
})

describe("planner", () => {
  it("plans every IN IPO check in pack order when the DRHP link is known (no LLM)", async () => {
    const out = await runPlanner({ route: route("IN", "ipo"), entity: entity({ filingUrl: "https://www.sebi.gov.in/drhp.pdf" }) }, testContext())

    expect(out.packId).toBe("in-ipo")
    expect(out.checks.map((c) => c.id)).toEqual([
      "offer_document",
      "price_band",
      "issue_structure",
      "share_capital",
      "financials",
      "lock_in",
      "litigation",
    ])
    expect(out.declaredIntent.sort()).toEqual(["firecrawl", "inFilings", "pdf", "serp"])
    expect(extract).not.toHaveBeenCalled()
  })

  it("skips filing checks by rule for an unlisted company with no filing", async () => {
    const out = await runPlanner({ route: route("IN", "ipo"), entity: entity({ status: "unlisted" }) }, testContext())

    expect(out.skipped.filter((s) => s.basis === "rules").map((s) => s.id)).toEqual([
      "offer_document",
      "issue_structure",
      "share_capital",
      "financials",
      "lock_in",
    ])
    expect(out.checks.map((c) => c.id)).toEqual(["price_band", "litigation"])
    expect(out.declaredIntent).not.toContain("edgar")
  })

  it("lets the LLM skip only uncertain checks, with a reason", async () => {
    vi.mocked(extract).mockResolvedValue({
      skip: [
        { checkId: "offer_document", reason: "No S-1 found for this company." },
        { checkId: "litigation", reason: "not in the uncertain list" },
        { checkId: "made_up", reason: "x" },
      ],
    })

    const out = await runPlanner({ route: route("US", "ipo"), entity: entity({ country: "US", legalName: "Zeta Inc." }) }, testContext())

    expect(extract).toHaveBeenCalledOnce()
    expect(out.skipped).toEqual([{ id: "offer_document", reason: "No S-1 found for this company.", basis: "llm" }])
    expect(out.checks.map((c) => c.id)).toEqual(["price_band", "share_capital", "financials", "lock_in"])
    expect(out.declaredIntent.sort()).toEqual(["edgar", "serp"])
  })

  it("keeps uncertain checks when the LLM call fails", async () => {
    vi.mocked(extract).mockRejectedValue(new Error("timeout"))
    const out = await runPlanner({ route: route("US", "ipo"), entity: entity({ country: "US" }) }, testContext())
    expect(out.status).toBe("ok")
    expect(out.checks).toHaveLength(5)
  })

  it("returns unverifiable for unsupported routes", async () => {
    const out = await runPlanner({ route: route("US", "listed", false), entity: entity({ country: "US", status: "listed" }) }, testContext())
    expect(out).toMatchObject({ status: "unverifiable", checks: [], declaredIntent: [] })
  })

  it("plans IN unlisted checks including Crustdata tools", async () => {
    const out = await runPlanner({ route: route("IN", "unlisted"), entity: entity({ status: "unlisted", domain: "example.in" }) }, testContext())
    expect(out.packId).toBe("in-unlisted")
    expect(out.declaredIntent).toContain("crustdata")
    expect(scanForAdvice(out)).toEqual([])
  })

  it("returns failed on invalid input", async () => {
    const out = await runPlanner({ route: route("IN", "ipo") }, testContext())
    expect(out.status).toBe("failed")
  })
})
