import { createRouteMatcher } from "@clerk/nextjs/server"

/**
 * Pages reachable without signing in. Everything else that is a page
 * requires a session and redirects to sign-in.
 */
export const isPublicPage = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"])

/**
 * API routes are never redirected by the proxy. Each route handler enforces
 * auth itself (`requireAuth()`) so it can return a JSON 401 instead of an
 * HTML redirect, and public endpoints (health, webhooks) stay reachable.
 */
export const isApiRoute = createRouteMatcher(["/api(.*)"])
