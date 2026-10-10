import { NextResponse, type NextRequest } from "next/server"

import { REQUEST_ID_HEADER } from "@/lib/api/api-response"
import { generateRequestId } from "@/lib/api/request-id"

/**
 * Assigns a fresh request ID to every request passing through the proxy.
 * Client-supplied values are overwritten so logs cannot be spoofed. The ID is
 * forwarded to route handlers as a request header and echoed on the response.
 */
export function withRequestId(request: NextRequest): NextResponse {
  const requestId = generateRequestId()
  const headers = new Headers(request.headers)
  headers.set(REQUEST_ID_HEADER, requestId)

  const response = NextResponse.next({ request: { headers } })
  response.headers.set(REQUEST_ID_HEADER, requestId)
  return response
}
