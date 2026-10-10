/**
 * Country packs: the ordered checklist the planner runs for each supported
 * (country, instrument). DRAFT — pending owner review. Changing checks here
 * needs no code change elsewhere except a matching schema in
 * agents/extractor/checks.ts for any new check id.
 */
import type { Country, Entity, Instrument } from "@/agents/types"
import type { CallToolName } from "@/lib/clients/callTool"

export const CHECK_IDS = [
  "offer_document",
  "price_band",
  "issue_structure",
  "share_capital",
  "financials",
  "lock_in",
  "litigation",
  "identity",
  "funding_rounds",
  "headcount_trend",
  "unlisted_quotes",
] as const
export type CheckId = (typeof CHECK_IDS)[number]

/** Entity facts a check cannot run without. */
export type Requirement = "filing" | "cik" | "domain"

export type CheckDef = {
  id: CheckId
  title: string
  tools: CallToolName[]
  requires?: Requirement[]
  /** Filing headings whose sections the extractor reads (never the whole document). */
  sectionHeadings?: string[]
}

export type PackId = "in-ipo" | "in-unlisted" | "us-ipo"

export type CountryPack = {
  id: PackId
  country: Country
  instrument: Instrument
  currency: "INR" | "USD"
  checks: CheckDef[]
}

export const PACKS: CountryPack[] = [
  {
    id: "in-ipo",
    country: "IN",
    instrument: "ipo",
    currency: "INR",
    checks: [
      { id: "offer_document", title: "Offer document filed", tools: ["inFilings", "pdf"], requires: ["filing"] },
      {
        id: "price_band",
        title: "Price band and lot size",
        tools: ["serp", "firecrawl", "inFilings", "pdf"],
        sectionHeadings: ["Price Band", "The Offer", "Basis for Offer Price"],
      },
      {
        id: "issue_structure",
        title: "Fresh issue vs offer for sale",
        tools: ["inFilings", "pdf"],
        requires: ["filing"],
        sectionHeadings: ["The Offer", "Offer for Sale", "Fresh Issue", "Objects of the Offer"],
      },
      {
        id: "share_capital",
        title: "Shares outstanding after the issue",
        tools: ["inFilings", "pdf"],
        requires: ["filing"],
        sectionHeadings: ["Capital Structure"],
      },
      {
        id: "financials",
        title: "Revenue and profit (last two years)",
        tools: ["inFilings", "pdf"],
        requires: ["filing"],
        sectionHeadings: ["Summary of Financial Information", "Restated Financial Information"],
      },
      {
        id: "lock_in",
        title: "Promoter lock-in",
        tools: ["inFilings", "pdf"],
        requires: ["filing"],
        sectionHeadings: ["Lock-in", "Promoters' Contribution"],
      },
      {
        id: "litigation",
        title: "Outstanding litigation",
        tools: ["inFilings", "pdf", "serp"],
        sectionHeadings: ["Outstanding Litigation and Material Developments"],
      },
    ],
  },
  {
    id: "in-unlisted",
    country: "IN",
    instrument: "unlisted",
    currency: "INR",
    checks: [
      { id: "identity", title: "Company identity", tools: ["crustdata", "firecrawl", "serp"] },
      { id: "funding_rounds", title: "Latest funding round", tools: ["crustdata", "serp"] },
      { id: "financials", title: "Revenue and profit (last two years)", tools: ["serp", "firecrawl"] },
      { id: "headcount_trend", title: "Headcount trend", tools: ["crustdata"], requires: ["domain"] },
      { id: "share_capital", title: "Shares outstanding", tools: ["serp", "firecrawl"] },
      { id: "unlisted_quotes", title: "Unlisted-market price quotes", tools: ["serp", "firecrawl"] },
    ],
  },
  {
    id: "us-ipo",
    country: "US",
    instrument: "ipo",
    currency: "USD",
    checks: [
      { id: "offer_document", title: "Registration statement filed", tools: ["edgar"], requires: ["cik"] },
      {
        id: "price_band",
        title: "Price range",
        tools: ["edgar", "serp"],
        requires: ["cik"],
        sectionHeadings: ["The Offering", "Pricing of the Offering"],
      },
      {
        id: "share_capital",
        title: "Shares outstanding after the offering",
        tools: ["edgar"],
        requires: ["cik"],
        sectionHeadings: ["The Offering", "Capitalization"],
      },
      { id: "financials", title: "Revenue and net income (last two years)", tools: ["edgar"], requires: ["cik"] },
      {
        id: "lock_in",
        title: "Lock-up period",
        tools: ["edgar"],
        requires: ["cik"],
        sectionHeadings: ["Lock-up Agreements", "Shares Eligible for Future Sale"],
      },
    ],
  },
]

export function findPack(country: Country, instrument: Instrument): CountryPack | undefined {
  return PACKS.find((pack) => pack.country === country && pack.instrument === instrument)
}

/**
 * Which requirements the entity clearly meets (true), clearly lacks (false),
 * or leaves unknown (undefined).
 */
export function requirementState(req: Requirement, entity: Entity): boolean | undefined {
  switch (req) {
    case "filing":
      if (entity.filingUrl) return true
      return entity.status === "ipo_filed" || entity.status === "listed" ? undefined : false
    case "cik":
      return entity.cik ? true : entity.country === "US" ? undefined : false
    case "domain":
      return entity.domain ? true : undefined
  }
}
