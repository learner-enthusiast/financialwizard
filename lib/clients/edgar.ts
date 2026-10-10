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

let tickersPromise: Promise<Map<string, string>> | undefined

async function loadTickers(signal?: AbortSignal): Promise<Map<string, string>> {
  tickersPromise ??= (async () => {
    const res = await fetch(`${SEC_FILES}/files/company_tickers.json`, {
      signal,
      headers: { Accept: "application/json", "User-Agent": requireSecUserAgent() },
    })
    if (!res.ok) throw new Error(`SEC tickers HTTP ${res.status}`)
    const json = (await res.json()) as Record<string, { cik_str: number; ticker: string }>
    const map = new Map<string, string>()
    for (const row of Object.values(json)) {
      map.set(row.ticker.toUpperCase(), formatCik(row.cik_str))
    }
    return map
  })()
  return tickersPromise
}

export async function tickerToCik(ticker: string, signal?: AbortSignal): Promise<string | null> {
  const map = await loadTickers(signal)
  return map.get(ticker.toUpperCase()) ?? null
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
