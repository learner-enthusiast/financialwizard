import { describe, expect, it } from "vitest"

import { addDays, computeMetrics } from "@/compute"

const n = (value: number, claimId: string, sourceIds = [`s_${claimId}`]) => ({ value, claimId, sourceIds })

describe("computeMetrics", () => {
  it("computes market cap, P/E and P/S from extracted inputs with merged sourceIds", () => {
    const out = computeMetrics({
      priceLow: n(95, "price_low"),
      priceHigh: n(100, "price_high"),
      sharesOutstandingPostIssue: n(1_000_000, "shares"),
      netIncomeLatest: n(5_000_000, "income"),
      revenueLatest: n(20_000_000, "revenue"),
    })
    const byMetric = Object.fromEntries(out.map((v) => [v.metric, v]))

    expect(byMetric.market_cap_at_low.value).toBe(95_000_000)
    expect(byMetric.market_cap_at_high.value).toBe(100_000_000)
    expect(byMetric.pe_at_high.value).toBe(20)
    expect(byMetric.ps_at_high.value).toBe(5)
    expect(byMetric.pe_at_high.sourceIds.sort()).toEqual(["s_income", "s_price_high", "s_shares"])
    expect(byMetric.pe_at_high.inputClaimIds).toEqual(["price_high", "shares", "income"])
  })

  it("skips P/E for loss-making companies", () => {
    const out = computeMetrics({
      priceHigh: n(10, "p"),
      sharesOutstandingPostIssue: n(10, "s"),
      netIncomeLatest: n(-5, "i"),
    })
    expect(out.map((v) => v.metric)).toEqual(["market_cap_at_high"])
  })

  it("computes OFS %, revenue growth and lock-in end", () => {
    const out = computeMetrics({
      freshIssueAmount: n(300, "fresh"),
      ofsAmount: n(700, "ofs"),
      revenueLatest: n(120, "r1"),
      revenuePrior: n(100, "r0"),
      listingDate: { value: "2026-01-10", claimId: "listing", sourceIds: ["s_l"] },
      lockInDays: n(180, "lock"),
    })
    const byMetric = Object.fromEntries(out.map((v) => [v.metric, v.value]))
    expect(byMetric.ofs_percent).toBe(70)
    expect(byMetric.revenue_growth_pct).toBe(20)
    expect(byMetric.lock_in_end_date).toBe("2026-07-09")
  })

  it("returns nothing when inputs are missing", () => {
    expect(computeMetrics({ priceHigh: n(1, "p") })).toEqual([])
    expect(addDays("not a date", 3)).toBeUndefined()
  })
})
