/*
 * India DRHP access: local data/ first; live fallback via lib/clients/firecrawl.ts only.
 * PDF sections: lib/clients/pdf.ts (unpdf — https://github.com/unjs/unpdf)
 */
import "server-only"

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { scrapePage } from "@/lib/clients/firecrawl"

const DATA_DIR = path.join(process.cwd(), "data", "in-filings", "drhp")

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

async function listLocalPdfBasenames(): Promise<string[]> {
  try {
    const files = await readdir(DATA_DIR)
    return files.filter((f) => f.toLowerCase().endsWith(".pdf"))
  } catch {
    return []
  }
}

/** Row of data/in-filings/companies.json (maintained by the owner). */
export type KnownIndianCompany = {
  legalName: string
  status?: "unlisted" | "ipo_filed" | "listed"
  domain?: string
  nseSymbol?: string
  bseCode?: string
  drhpUrl?: string
}

/** Local company list for India (IPO / unlisted). Empty when the file is absent or invalid. */
export async function listKnownCompanies(): Promise<KnownIndianCompany[]> {
  try {
    const raw = await readFile(path.join(process.cwd(), "data", "in-filings", "companies.json"), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (row): row is KnownIndianCompany =>
        typeof row === "object" && row !== null && typeof (row as KnownIndianCompany).legalName === "string"
    )
  } catch {
    return []
  }
}

export async function findDrhp(legalName: string, signal?: AbortSignal): Promise<Buffer | null> {
  const target = normalizeName(legalName)
  const pdfs = await listLocalPdfBasenames()

  for (const file of pdfs) {
    const base = normalizeName(file.replace(/\.pdf$/i, ""))
    if (base.includes(target) || target.includes(base)) {
      return readFile(path.join(DATA_DIR, file))
    }
  }

  const listPath = path.join(process.cwd(), "data", "in-filings", "companies.json")
  try {
    const raw = await readFile(listPath, "utf8")
    const companies = JSON.parse(raw) as Array<{ legalName: string; drhpUrl?: string }>
    const match = companies.find((c) => normalizeName(c.legalName) === target)
    if (match?.drhpUrl) {
      const markdown = await scrapePage(match.drhpUrl, signal)
      if (!markdown) return null
      return Buffer.from(markdown, "utf8")
    }
  } catch {
    /* no list or fetch */
  }

  return null
}
