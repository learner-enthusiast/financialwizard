import { API_ERROR_CODES, isApiErrorCode, type ApiErrorCode } from "@/lib/api/api-error-codes"
import type { ApiErrorDetails } from "@/lib/api/api-error"
import type { ApiResponseBody } from "@/lib/api/api-response"

/*
 * Typed browser client for the internal API. No server-only imports: only
 * types and the isomorphic error-code registry.
 */

export type ApiClientErrorKind =
  /** Server answered with the standard error envelope (or a non-2xx status). */
  | "http"
  /** fetch() rejected: offline, DNS, CORS, connection reset. */
  | "network"
  /** Body was not valid JSON. */
  | "parse"
  /** Body was JSON but not the expected envelope. */
  | "invalid_response"
  /** Request was cancelled via AbortSignal. */
  | "aborted"

export class ApiClientError extends Error {
  readonly kind: ApiClientErrorKind
  readonly status: number | null
  readonly code: ApiErrorCode | null
  readonly requestId: string | null
  readonly details?: ApiErrorDetails

  constructor(init: {
    kind: ApiClientErrorKind
    message: string
    status?: number | null
    code?: ApiErrorCode | null
    requestId?: string | null
    details?: ApiErrorDetails
    cause?: unknown
  }) {
    super(init.message, { cause: init.cause })
    this.name = "ApiClientError"
    this.kind = init.kind
    this.status = init.status ?? null
    this.code = init.code ?? null
    this.requestId = init.requestId ?? null
    this.details = init.details
  }
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError
}

const NETWORK_MESSAGE = "Unable to reach the server. Check your connection and try again."
const UNEXPECTED_MESSAGE = "The server returned an unexpected response. Please try again."

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  body?: unknown
  signal?: AbortSignal
  headers?: HeadersInit
}

function isEnvelope(value: unknown): value is ApiResponseBody<unknown> {
  if (typeof value !== "object" || value === null) return false
  const body = value as Record<string, unknown>
  const meta = body.meta as Record<string, unknown> | undefined
  if (typeof meta?.requestId !== "string") return false
  if (body.success === true) return "data" in body
  if (body.success === false) {
    const error = body.error as Record<string, unknown> | undefined
    return typeof error?.code === "string" && typeof error?.message === "string"
  }
  return false
}

function fallbackCodeForStatus(status: number): ApiErrorCode {
  const match = (Object.keys(API_ERROR_CODES) as ApiErrorCode[]).find(
    (code) => API_ERROR_CODES[code].status === status
  )
  return match ?? (status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST")
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set("Accept", "application/json")
  const hasBody = options.body !== undefined
  if (hasBody) headers.set("Content-Type", "application/json")

  let response: Response
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      credentials: "same-origin",
    })
  } catch (error) {
    if (options.signal?.aborted || (error as Error)?.name === "AbortError") {
      throw new ApiClientError({ kind: "aborted", message: "Request was cancelled.", cause: error })
    }
    throw new ApiClientError({ kind: "network", message: NETWORK_MESSAGE, cause: error })
  }

  // fetch() resolves for 4xx/5xx, so the status must be checked explicitly.
  const headerRequestId = response.headers.get("x-request-id")

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new ApiClientError({
      kind: response.ok ? "parse" : "http",
      message: UNEXPECTED_MESSAGE,
      status: response.status,
      code: response.ok ? null : fallbackCodeForStatus(response.status),
      requestId: headerRequestId,
      cause: error,
    })
  }

  if (!isEnvelope(body)) {
    throw new ApiClientError({
      kind: response.ok ? "invalid_response" : "http",
      message: UNEXPECTED_MESSAGE,
      status: response.status,
      code: response.ok ? null : fallbackCodeForStatus(response.status),
      requestId: headerRequestId,
    })
  }

  if (body.success && response.ok) return body.data as T

  if (!body.success) {
    throw new ApiClientError({
      kind: "http",
      message: body.error.message,
      status: response.status,
      code: isApiErrorCode(body.error.code) ? body.error.code : fallbackCodeForStatus(response.status),
      requestId: body.meta.requestId,
      details: body.error.details,
    })
  }

  // success: true with a non-2xx status is a contract violation.
  throw new ApiClientError({
    kind: "invalid_response",
    message: UNEXPECTED_MESSAGE,
    status: response.status,
    requestId: body.meta.requestId,
  })
}

export const apiClient = {
  get: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "POST", body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "PUT", body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "PATCH", body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "DELETE" }),
}

/** Safe, user-presentable message for any error thrown by the client or hooks. */
export function getErrorMessage(error: unknown): string {
  if (isApiClientError(error)) return error.message
  return API_ERROR_CODES.INTERNAL_ERROR.message
}
