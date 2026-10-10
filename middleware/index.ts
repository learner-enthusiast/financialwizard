import type { ClerkMiddlewareAuth } from "@clerk/nextjs/server"
import type { NextRequest } from "next/server"

import { isApiRoute, isPublicPage } from "@/middleware/auth.middleware"
import { withRequestId } from "@/middleware/request-id.middleware"

/**
 * Proxy pipeline, run inside `clerkMiddleware` from the root `proxy.ts`.
 * 1. Protect non-public pages (redirect to sign-in when signed out).
 * 2. Attach a request ID for downstream logging and responses.
 */
export async function proxyHandler(auth: ClerkMiddlewareAuth, request: NextRequest) {
  if (!isApiRoute(request) && !isPublicPage(request)) {
    await auth.protect()
  }
  return withRequestId(request)
}
