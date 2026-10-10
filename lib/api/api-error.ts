import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/api/api-error-codes"

/** Field-level validation details: `{ "email": ["Enter a valid email address."] }`. */
export type ApiErrorDetails = Record<string, string[]>

type ApiErrorOptions = {
  /**
   * Message shown to the client. Must be safe to expose; defaults to the
   * registry message for the code. Never pass raw exception messages here.
   */
  message?: string
  details?: ApiErrorDetails
  /** Original error, kept for server-side logging only. */
  cause?: unknown
  /** Extra context for server logs only. Never sent to clients. */
  logContext?: Record<string, unknown>
}

/**
 * Typed application error for expected failures.
 * Services throw these; the API handler converts them into the response envelope.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly publicMessage: string
  readonly details?: ApiErrorDetails
  readonly logContext?: Record<string, unknown>

  constructor(code: ApiErrorCode, options: ApiErrorOptions = {}) {
    const publicMessage = options.message ?? API_ERROR_CODES[code].message
    super(publicMessage, { cause: options.cause })
    this.name = "ApiError"
    this.code = code
    this.status = API_ERROR_CODES[code].status
    this.publicMessage = publicMessage
    this.details = options.details
    this.logContext = options.logContext
  }

  get isServerError(): boolean {
    return this.status >= 500
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}
