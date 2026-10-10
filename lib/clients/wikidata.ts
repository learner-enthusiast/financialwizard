/*
 * Docs used:
 *   https://www.wikidata.org/wiki/Wikidata:Data_access
 */
import "server-only"

export type WikidataCompany = {
  /** Wikidata item id, e.g. "Q95". */
  id: string
  label?: string
  description?: string
  website?: string
  exchange?: string
  ticker?: string
}

type WbSearchEntity = {
  id?: string
  label?: string
  description?: string
}

type WbEntityData = {
  entities?: Record<
    string,
    {
      claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>
    }
  >
}

const API = "https://www.wikidata.org/w/api.php"

async function wbGet(params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const url = new URL(API)
  url.searchParams.set("format", "json")
  url.searchParams.set("origin", "*")
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`)
  return res.json()
}

function claimString(data: WbEntityData, entityId: string, property: string): string | undefined {
  const claim = data.entities?.[entityId]?.claims?.[property]?.[0]?.mainsnak?.datavalue?.value
  if (typeof claim === "string") return claim
  if (claim && typeof claim === "object" && "text" in claim) {
    return typeof (claim as { text?: string }).text === "string" ? (claim as { text: string }).text : undefined
  }
  return undefined
}

export async function lookupCompany(name: string, signal?: AbortSignal): Promise<WikidataCompany | null> {
  const search = (await wbGet(
    { action: "wbsearchentities", search: name, language: "en", type: "item", limit: "1" },
    signal
  )) as { search?: WbSearchEntity[] }

  const hit = search.search?.[0]
  const entityId = hit?.id
  if (!entityId) return null

  const entity = (await wbGet(
    { action: "wbgetentities", ids: entityId, props: "claims", languages: "en" },
    signal
  )) as WbEntityData

  const website = claimString(entity, entityId, "P856")
  const ticker = claimString(entity, entityId, "P249")
  const exchange = claimString(entity, entityId, "P414")

  return { id: entityId, label: hit.label, description: hit.description, website, exchange, ticker }
}
