/**
 * No-investment-advice guard. Outputs are evidence, never recommendations.
 * Scans free-text fields only: names, URLs, ids and verbatim source quotes are
 * skipped (a company called "Strong Ltd" or a quoted "strong growth" is data).
 */

const ADVICE_PATTERN =
  /\b(buy|buys|buying|sell|sells|selling|strong|strongly|guarantee|guaranteed|price[- ]targets?|target price|recommend\w*|outperform|underperform)\b/gi

const SKIPPED_KEYS = new Set([
  "id",
  "ids",
  "url",
  "domain",
  "legalName",
  "name",
  "title",
  "symbols",
  "cik",
  "filingUrl",
  "quote",
  "says",
  "sourceIds",
  "contentHash",
  "claimId",
  "checkId",
])

export function findAdviceTerms(text: string): string[] {
  return [...new Set((text.match(ADVICE_PATTERN) ?? []).map((term) => term.toLowerCase()))]
}

/** Returns "path: term" for every advice term found in free-text fields of `value`. */
export function scanForAdvice(value: unknown, path = ""): string[] {
  if (typeof value === "string") {
    return findAdviceTerms(value).map((term) => `${path || "(root)"}: ${term}`)
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => scanForAdvice(item, `${path}[${index}]`))
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      SKIPPED_KEYS.has(key) ? [] : scanForAdvice(item, path ? `${path}.${key}` : key)
    )
  }
  return []
}
