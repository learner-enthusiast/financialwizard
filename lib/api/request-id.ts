import { REQUEST_ID_HEADER } from "@/lib/api/api-response"

/*
 * Dependency-free so it can be shared by the proxy and route handlers.
 * Uses the Web Crypto global (available in Node.js and the proxy runtime).
 */

const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{8,64}$/

export function generateRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`
}

export function isValidRequestId(value: string | null | undefined): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value)
}

/**
 * Reuses the request ID assigned by the proxy when it is well-formed,
 * otherwise generates a new one.
 */
export function resolveRequestId(headers: Headers): string {
  const incoming = headers.get(REQUEST_ID_HEADER)
  return isValidRequestId(incoming) ? incoming : generateRequestId()
}
