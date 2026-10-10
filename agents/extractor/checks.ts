/**
 * Per-check extraction specs. Each field says what the LLM must find and how
 * code should interpret it. Keys are the field names used by compute/.
 */
import type { CheckId } from "@/agents/packs"

export type FieldKind =
  /** Monetary amount: value × scale, in the field's currency. */
  | "money"
  /** Price per share. */
  | "per_share"
  /** Plain count (shares, cases, people, lot size). value × scale. */
  | "count"
  | "days"
  | "year"
  /** ISO date YYYY-MM-DD. */
  | "date"
  | "boolean"
  | "text"

export type FieldSpec = {
  kind: FieldKind
  label: string
  /** Extra guidance for the model. */
  hint?: string
  /** Whether the value refers to a reporting period (e.g. FY2024). */
  periodic?: boolean
}

export type CheckSpec = { fields: Record<string, FieldSpec> }

export const CHECK_SPECS: Record<CheckId, CheckSpec> = {
  offer_document: {
    fields: {
      documentType: { kind: "text", label: "Offer document type", hint: "e.g. DRHP, RHP, S-1, F-1" },
      filingDate: { kind: "date", label: "Offer document filing date" },
    },
  },
  price_band: {
    fields: {
      priceLow: { kind: "per_share", label: "Price band lower end" },
      priceHigh: { kind: "per_share", label: "Price band upper end" },
      lotSize: { kind: "count", label: "Minimum lot size (shares)" },
    },
  },
  issue_structure: {
    fields: {
      freshIssueAmount: { kind: "money", label: "Fresh issue size", hint: "new shares sold by the company" },
      ofsAmount: { kind: "money", label: "Offer for sale size", hint: "existing shares sold by current holders" },
    },
  },
  share_capital: {
    fields: {
      sharesOutstandingPostIssue: { kind: "count", label: "Shares outstanding after the issue" },
    },
  },
  financials: {
    fields: {
      latestPeriod: { kind: "text", label: "Latest reported period", hint: "e.g. FY2025 or year ended 31 March 2025" },
      revenueLatest: { kind: "money", label: "Revenue (latest period)", periodic: true },
      netIncomeLatest: { kind: "money", label: "Net profit or loss (latest period)", hint: "negative for a loss", periodic: true },
      priorPeriod: { kind: "text", label: "Prior reported period" },
      revenuePrior: { kind: "money", label: "Revenue (prior period)", periodic: true },
    },
  },
  lock_in: {
    fields: {
      listingDate: { kind: "date", label: "Listing or pricing date" },
      lockInDays: { kind: "days", label: "Lock-in / lock-up period (days)", hint: "convert months to days only if the text gives days; otherwise leave null" },
    },
  },
  litigation: {
    fields: {
      pendingCasesCount: { kind: "count", label: "Outstanding litigation cases involving the company" },
      regulatoryActionMentioned: { kind: "boolean", label: "Regulatory action against the company mentioned" },
    },
  },
  identity: {
    fields: {
      incorporationYear: { kind: "year", label: "Year of incorporation" },
      headquarters: { kind: "text", label: "Headquarters city" },
    },
  },
  funding_rounds: {
    fields: {
      lastRoundDate: { kind: "date", label: "Latest funding round date" },
      lastRoundType: { kind: "text", label: "Latest funding round type" },
      lastRoundAmount: { kind: "money", label: "Latest funding round amount" },
    },
  },
  headcount_trend: {
    fields: {
      headcountLatest: { kind: "count", label: "Current headcount" },
      headcountYearAgo: { kind: "count", label: "Headcount one year earlier" },
    },
  },
  unlisted_quotes: {
    fields: {
      quotedPricePerShare: { kind: "per_share", label: "Unlisted-market quoted price" },
      quoteDate: { kind: "date", label: "Date of the quote" },
    },
  },
}

export const SCALE_MULTIPLIER = {
  units: 1,
  thousand: 1e3,
  lakh: 1e5,
  million: 1e6,
  crore: 1e7,
  billion: 1e9,
} as const
export type Scale = keyof typeof SCALE_MULTIPLIER
