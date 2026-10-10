import { clerkMiddleware } from "@clerk/nextjs/server"

import { proxyHandler } from "@/middleware"

// Next.js 16 request interception entry point (replaces middleware.ts).
export default clerkMiddleware(proxyHandler)

export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/api(.*)",
  ],
}
