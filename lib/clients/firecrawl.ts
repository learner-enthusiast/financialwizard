/*
 * Docs used:
 *   https://docs.firecrawl.dev/sdks/node
 */
import "server-only"

import { Firecrawl } from "firecrawl"

import { getFirecrawlApiKey } from "@/lib/env"

let client: Firecrawl | undefined

function getClient(): Firecrawl {
  client ??= new Firecrawl({ apiKey: getFirecrawlApiKey() })
  return client
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

async function fetchFallback(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, headers: { Accept: "text/html" } })
  if (!res.ok) throw new Error(`fetch HTTP ${res.status}`)
  return htmlToText(await res.text())
}

export async function scrapePage(url: string, signal?: AbortSignal): Promise<string> {
  try {
    const result = await getClient().scrape(url, { formats: ["markdown"] })
    const markdown = (result as { markdown?: string }).markdown
    if (typeof markdown === "string" && markdown.trim()) return markdown
    const html = (result as { html?: string }).html
    if (typeof html === "string" && html.trim()) return htmlToText(html)
    throw new Error("empty scrape result")
  } catch {
    return fetchFallback(url, signal)
  }
}
