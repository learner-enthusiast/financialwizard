/*
 * Docs used (endpoint details):
 *   docs/vendor/crustdata.md  — REQUIRED; paste real endpoint docs before enabling.
 * Product reference (fields only):
 *   https://www.crustdata.com/apis/company-enrichment
 *   https://www.crustdata.com/apis/company-discovery
 */
import "server-only"

import { requireCrustdataApiKey } from "@/lib/env"

function docsMissing(): never {
  throw new Error(
    "Crustdata client blocked: add docs/vendor/crustdata.md with authenticated endpoint docs, then implement enrichCompany/searchCompanies."
  )
}

export async function enrichCompany(
  _target: { domain?: string; name?: string },
  _fields: string[],
  _opts: { realtime?: boolean; signal?: AbortSignal } = {}
): Promise<unknown> {
  void requireCrustdataApiKey()
  docsMissing()
}

export async function searchCompanies(
  _filters: Record<string, unknown>,
  _opts: { realtime?: boolean; signal?: AbortSignal } = {}
): Promise<unknown> {
  void requireCrustdataApiKey()
  docsMissing()
}
