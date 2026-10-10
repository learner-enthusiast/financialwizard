import "server-only"

import type { NextRequest } from "next/server"
import type { Logger } from "pino"

import type { ApiErrorCode } from "@/lib/api/api-error-codes"
import { toApiError } from "@/lib/api/error-handler"
import { errorResponse, successResponse } from "@/lib/api/api-response"
import { resolveRequestId } from "@/lib/api/request-id"
import { getLogger, runWithRequestContext } from "@/lib/logger/request-context"

type RouteParams = Record<string, string | string[] | undefined>

export type ApiHandlerArgs<P extends RouteParams> = {
  request: NextRequest
  params: P
  requestId: string
  logger: Logger
}

export type ApiHandlerResult<T> = {
  data: T
  status?: number
  headers?: HeadersInit
}

type ApiHandlerOptions = {
  /** Route pattern used in logs, e.g. "/api/accounts/[id]". Avoids logging raw IDs. */
  route?: string
}

/** Expected rejections that deserve operator attention; others log at info. */
const WARN_CODES = new Set<ApiErrorCode>(["FORBIDDEN", "CONFLICT", "RATE_LIMITED"])

/**
 * Wraps a route handler with request IDs, request-scoped logging, timing and
 * the standard response envelope. Handlers return data or throw; they never
 * build error responses themselves.
 */
export function createApiHandler<T, P extends RouteParams = RouteParams>(
  handler: (args: ApiHandlerArgs<P>) => Promise<ApiHandlerResult<T>>,
  options: ApiHandlerOptions = {}
) {
  return async function routeHandler(
    request: NextRequest,
    context: { params: Promise<P> }
  ): Promise<Response> {
    const requestId = resolveRequestId(request.headers)
    const method = request.method
    const route = options.route ?? request.nextUrl.pathname
    const startedAt = performance.now()

    return runWithRequestContext({ requestId, method, route }, async () => {
      const log = getLogger()
      const durationMs = () => Math.round(performance.now() - startedAt)

      try {
        const params = (await context?.params) ?? ({} as P)
        const result = await handler({ request, params, requestId, logger: log })
        const response = successResponse(result.data, requestId, {
          status: result.status,
          headers: result.headers,
        })
        log.info({ status: response.status, durationMs: durationMs() }, "request completed")
        return response
      } catch (thrown) {
        const apiError = toApiError(thrown)
        const fields = {
          status: apiError.status,
          errorCode: apiError.code,
          durationMs: durationMs(),
          ...apiError.logContext,
        }

        if (apiError.isServerError) {
          // Single log entry for the failure, including name and stack of the root cause.
          log.error({ ...fields, err: apiError.cause ?? thrown }, "request failed")
        } else if (WARN_CODES.has(apiError.code)) {
          log.warn(fields, "request rejected")
        } else {
          log.info(fields, "request rejected")
        }

        return errorResponse(apiError, requestId)
      }
    })
  }
}
