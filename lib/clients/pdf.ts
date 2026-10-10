/*
 * Docs used:
 *   https://github.com/unjs/unpdf
 */
import "server-only"

import { extractText, getDocumentProxy } from "unpdf"

export async function pdfToText(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(buffer)
  const { text } = await extractText(pdf, { mergePages: true })
  return text
}

/**
 * Slices `text` into the sections that start at each heading (case-insensitive),
 * ending at the next heading found. Missing headings map to "".
 * Works on already-extracted text (e.g. stored Source excerpts).
 */
export function sliceSections(text: string, headings: string[]): Record<string, string> {
  const lower = text.toLowerCase()
  const out: Record<string, string> = {}

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!
    const start = lower.indexOf(heading.toLowerCase())
    if (start < 0) {
      out[heading] = ""
      continue
    }
    const nextStarts = headings
      .filter((_, j) => j !== i)
      .map((h) => lower.indexOf(h.toLowerCase(), start + 1))
      .filter((idx) => idx > start)
    const end = nextStarts.length ? Math.min(...nextStarts) : text.length
    out[heading] = text.slice(start, end).trim()
  }

  return out
}

export async function extractSections(
  pdfBuffer: ArrayBuffer | Uint8Array,
  headings: string[]
): Promise<Record<string, string>> {
  return sliceSections(await pdfToText(pdfBuffer), headings)
}
