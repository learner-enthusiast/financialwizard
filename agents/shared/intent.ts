/** Query-intent helpers shared by resolver and router. */

const IPO_WORDS = /\b(ipo|drhp|rhp|s-1|listing|pre-ipo)\b/i

export type Intent = "ipo" | "any"

export function detectIntent(query: string): Intent {
  return IPO_WORDS.test(query) ? "ipo" : "any"
}
