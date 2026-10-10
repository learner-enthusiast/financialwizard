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

export async function extractSections(
  pdfBuffer: ArrayBuffer | Uint8Array,
  headings: string[]
): Promise<Record<string, string>> {
  const full = await pdfToText(pdfBuffer)
  const lower = full.toLowerCase()
  const out: Record<string, string> = {}

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!
    const start = lower.indexOf(heading.toLowerCase())
    if (start < 0) {
      out[heading] = ""
      continue
    }
    const nextStarts = headings
      .slice(i + 1)
      .map((h) => lower.indexOf(h.toLowerCase(), start + 1))
      .filter((idx) => idx >= 0)
    const end = nextStarts.length ? Math.min(...nextStarts) : full.length
    out[heading] = full.slice(start, end).trim()
  }

  return out
}
