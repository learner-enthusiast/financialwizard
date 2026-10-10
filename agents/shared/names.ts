/** Company-name helpers shared by resolver and verifier. */

const SUFFIXES =
  /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|pvt|private|plc|llc|llp|holdings?|group|the)\b/g

/** "Jio Platforms Limited" -> "jio platforms" */
export function normalizeLegalName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function sameCompanyName(a: string, b: string): boolean {
  const left = normalizeLegalName(a)
  return left.length > 0 && left === normalizeLegalName(b)
}

/** True when `text` names the company (normalized legal name) or its domain. */
export function textNamesEntity(text: string, entity: { legalName: string; domain?: string }): boolean {
  const haystack = ` ${normalizeLegalName(text)} `
  const name = normalizeLegalName(entity.legalName)
  if (name && haystack.includes(` ${name} `)) return true
  return Boolean(entity.domain && text.toLowerCase().includes(entity.domain.toLowerCase()))
}
