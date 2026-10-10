import "server-only"

import { AsyncLocalStorage } from "node:async_hooks"

import type { Logger } from "pino"

import { logger } from "@/lib/logger/logger"

export type RequestContext = {
  requestId: string
  method: string
  route: string
  logger: Logger
}

const storage = new AsyncLocalStorage<RequestContext>()

/**
 * Runs `fn` with a request-scoped context so services and repositories can log
 * with the same request ID without threading it through every call.
 */
export function runWithRequestContext<T>(
  context: Omit<RequestContext, "logger">,
  fn: () => T
): T {
  const child = logger.child({
    requestId: context.requestId,
    method: context.method,
    route: context.route,
  })
  return storage.run({ ...context, logger: child }, fn)
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

/** Logger bound to the current request (falls back to the root logger). */
export function getLogger(): Logger {
  return storage.getStore()?.logger ?? logger
}
