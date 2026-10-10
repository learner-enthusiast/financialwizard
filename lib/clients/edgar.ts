/*
 * Docs used:
 *   https://www.sec.gov/search-filings/edgar-application-programming-interfaces
 *   https://www.sec.gov/os/webmaster-faq#developers
 *   https://www.sec.gov/files/company_tickers.json
 */
import "server-only"

import { requireSecUserAgent } from "@/lib/env"

const SEC_ORIGIN = "https://data.sec.gov"
const SEC_FILES = "https://www.sec.gov"

/** SEC fair-access guidance: max 10 requests per second. */
const MIN_INTERVAL_MS = 100
let lastRequestAt = 0

async function secFetch(path: string, signal?: AbortSignal): Promise<Response> {
  const now = Date.now()
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestAt))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()

  return fetch(`${SEC_ORIGIN}${path}`, {
    signal,
    headers: {
      Accept: "application/json",
      "User-Agent": requireSecUserAgent(),
    },
  })
}

export function formatCik(cik: number | string): string {
  const digits = String(cik).replace(/\D/g, "")
  return digits.padStart(10, "0")
}

export type SecTickerRow = { cik: string; ticker: string; title: string }

let tickersPromise: Promise<SecTickerRow[]> | undefined

/** company_tickers.json rows: { cik_str, ticker, title } (SEC "Ticker -> CIK" file). */
async function loadTickers(signal?: AbortSignal): Promise<SecTickerRow[]> {
  tickersPromise ??= (async () => {
    const res = await fetch(`${SEC_FILES}/files/company_tickers.json`, {
      signal,
      headers: { Accept: "application/json", "User-Agent": requireSecUserAgent() },
    })
    if (!res.ok) throw new Error(`SEC tickers HTTP ${res.status}`)
    const json = (await res.json()) as Record<string, { cik_str: number; ticker: string; title: string }>
    return Object.values(json).map((row) => ({
      cik: formatCik(row.cik_str),
      ticker: row.ticker.toUpperCase(),
      title: row.title,
    }))
  })().catch((error: unknown) => {
    tickersPromise = undefined
    throw error
  })
  return tickersPromise
}

export async function tickerToCik(ticker: string, signal?: AbortSignal): Promise<string | null> {
  const rows = await loadTickers(signal)
  return rows.find((row) => row.ticker === ticker.toUpperCase())?.cik ?? null
}

function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|corp|corporation|co|ltd|limited|plc|holdings?|group|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Local lookup in the SEC ticker file by exact ticker or company-name match.
 * Returns at most `limit` rows; exact ticker matches first.
 */
export async function searchTickers(query: string, limit = 5, signal?: AbortSignal): Promise<SecTickerRow[]> {
  const rows = await loadTickers(signal)
  const q = query.trim()
  const byTicker = rows.filter((row) => row.ticker === q.toUpperCase())
  const target = normalizeCompanyName(q)
  if (!target) return byTicker.slice(0, limit)
  const byName = rows.filter((row) => {
    const name = normalizeCompanyName(row.title)
    return name === target || name.split(" ").slice(0, target.split(" ").length).join(" ") === target
  })
  const seen = new Set<string>()
  return [...byTicker, ...byName].filter((row) => !seen.has(row.cik + row.ticker) && seen.add(row.cik + row.ticker)).slice(0, limit)
}

export async function submissions(cik: string, signal?: AbortSignal): Promise<unknown> {
  const padded = formatCik(cik)
  const res = await secFetch(`/submissions/CIK${padded}.json`, signal)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`SEC submissions HTTP ${res.status}`)
  return res.json()
}

export async function companyFacts(cik: string, signal?: AbortSignal): Promise<unknown> {
  const padded = formatCik(cik)
  const res = await secFetch(`/api/xbrl/companyfacts/CIK${padded}.json`, signal)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`SEC companyFacts HTTP ${res.status}`)
  return res.json()
}

export function documentUrl(cik: string, accession: string, primaryDoc: string): string {
  const cikNum = formatCik(cik).replace(/^0+/, "") || "0"
  const accessionNoDash = accession.replace(/-/g, "")
  return `${SEC_FILES}/Archives/edgar/data/${cikNum}/${accessionNoDash}/${primaryDoc}`
}
