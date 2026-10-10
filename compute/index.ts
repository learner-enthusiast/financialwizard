/**
 * Deterministic financial arithmetic. The LLM never writes these numbers
 * (v2): it extracts inputs, and every computed value carries the union of
 * its inputs' sourceIds.
 */

/** An extracted input value with its evidence. */
export type SourcedNumber = { value: number; sourceIds: string[]; claimId: string }
export type SourcedString = { value: string; sourceIds: string[]; claimId: string }

export type ComputedMetric =
  | "market_cap_at_low"
  | "market_cap_at_high"
  | "pe_at_high"
  | "ps_at_high"
  | "ofs_percent"
  | "lock_in_end_date"
  | "revenue_growth_pct"
  | "implied_valuation_from_quote"
  | "headcount_change_pct"

export type ComputedValue = {
  metric: ComputedMetric
  value: number | string
  unit: "currency" | "ratio" | "percent" | "date"
  formula: string
  /** Claim ids of the inputs. */
  inputClaimIds: string[]
  sourceIds: string[]
}

/** Inputs available to compute, keyed by extracted field name. */
export type ComputeInputs = Partial<{
  priceLow: SourcedNumber
  priceHigh: SourcedNumber
  sharesOutstandingPostIssue: SourcedNumber
  revenueLatest: SourcedNumber
  revenuePrior: SourcedNumber
  netIncomeLatest: SourcedNumber
  freshIssueAmount: SourcedNumber
  ofsAmount: SourcedNumber
  listingDate: SourcedString
  lockInDays: SourcedNumber
  quotedPricePerShare: SourcedNumber
  headcountLatest: SourcedNumber
  headcountYearAgo: SourcedNumber
}>

function union(...inputs: Array<{ sourceIds: string[] }>): string[] {
  return [...new Set(inputs.flatMap((input) => input.sourceIds))]
}

function claims(...inputs: Array<{ claimId: string }>): string[] {
  return inputs.map((input) => input.claimId)
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function marketCap(price: SourcedNumber, shares: SourcedNumber): number {
  return price.value * shares.value
}

export function percentChange(latest: number, prior: number): number | undefined {
  return prior === 0 ? undefined : ((latest - prior) / Math.abs(prior)) * 100
}

/** Adds `days` to an ISO date (YYYY-MM-DD). Returns undefined for invalid dates. */
export function addDays(isoDate: string, days: number): string | undefined {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return undefined
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Computes every metric whose inputs are present. Pure and deterministic. */
export function computeMetrics(inputs: ComputeInputs): ComputedValue[] {
  const out: ComputedValue[] = []
  const { priceLow, priceHigh, sharesOutstandingPostIssue: shares } = inputs

  if (priceLow && shares) {
    out.push({
      metric: "market_cap_at_low",
      value: marketCap(priceLow, shares),
      unit: "currency",
      formula: "priceLow × sharesOutstandingPostIssue",
      inputClaimIds: claims(priceLow, shares),
      sourceIds: union(priceLow, shares),
    })
  }

  if (priceHigh && shares) {
    const capHigh = marketCap(priceHigh, shares)
    out.push({
      metric: "market_cap_at_high",
      value: capHigh,
      unit: "currency",
      formula: "priceHigh × sharesOutstandingPostIssue",
      inputClaimIds: claims(priceHigh, shares),
      sourceIds: union(priceHigh, shares),
    })

    const income = inputs.netIncomeLatest
    if (income && income.value > 0) {
      out.push({
        metric: "pe_at_high",
        value: round(capHigh / income.value, 2),
        unit: "ratio",
        formula: "(priceHigh × shares) ÷ netIncomeLatest",
        inputClaimIds: claims(priceHigh, shares, income),
        sourceIds: union(priceHigh, shares, income),
      })
    }

    const revenue = inputs.revenueLatest
    if (revenue && revenue.value > 0) {
      out.push({
        metric: "ps_at_high",
        value: round(capHigh / revenue.value, 2),
        unit: "ratio",
        formula: "(priceHigh × shares) ÷ revenueLatest",
        inputClaimIds: claims(priceHigh, shares, revenue),
        sourceIds: union(priceHigh, shares, revenue),
      })
    }
  }

  const { freshIssueAmount: fresh, ofsAmount: ofs } = inputs
  if (fresh && ofs && fresh.value + ofs.value > 0) {
    out.push({
      metric: "ofs_percent",
      value: round((ofs.value / (fresh.value + ofs.value)) * 100, 1),
      unit: "percent",
      formula: "ofsAmount ÷ (freshIssueAmount + ofsAmount) × 100",
      inputClaimIds: claims(fresh, ofs),
      sourceIds: union(fresh, ofs),
    })
  }

  const { listingDate, lockInDays } = inputs
  if (listingDate && lockInDays) {
    const end = addDays(listingDate.value, lockInDays.value)
    if (end) {
      out.push({
        metric: "lock_in_end_date",
        value: end,
        unit: "date",
        formula: "listingDate + lockInDays",
        inputClaimIds: claims(listingDate, lockInDays),
        sourceIds: union(listingDate, lockInDays),
      })
    }
  }

  const { revenueLatest, revenuePrior } = inputs
  if (revenueLatest && revenuePrior) {
    const growth = percentChange(revenueLatest.value, revenuePrior.value)
    if (growth !== undefined) {
      out.push({
        metric: "revenue_growth_pct",
        value: round(growth, 1),
        unit: "percent",
        formula: "(revenueLatest − revenuePrior) ÷ |revenuePrior| × 100",
        inputClaimIds: claims(revenueLatest, revenuePrior),
        sourceIds: union(revenueLatest, revenuePrior),
      })
    }
  }

  const quote = inputs.quotedPricePerShare
  if (quote && shares) {
    out.push({
      metric: "implied_valuation_from_quote",
      value: marketCap(quote, shares),
      unit: "currency",
      formula: "quotedPricePerShare × sharesOutstandingPostIssue",
      inputClaimIds: claims(quote, shares),
      sourceIds: union(quote, shares),
    })
  }

  const { headcountLatest, headcountYearAgo } = inputs
  if (headcountLatest && headcountYearAgo) {
    const change = percentChange(headcountLatest.value, headcountYearAgo.value)
    if (change !== undefined) {
      out.push({
        metric: "headcount_change_pct",
        value: round(change, 1),
        unit: "percent",
        formula: "(headcountLatest − headcountYearAgo) ÷ headcountYearAgo × 100",
        inputClaimIds: claims(headcountLatest, headcountYearAgo),
        sourceIds: union(headcountLatest, headcountYearAgo),
      })
    }
  }

  return out
}
