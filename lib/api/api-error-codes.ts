/**
 * Central registry of application error codes.
 *
 * Isomorphic: safe to import from both server and client code (no runtime deps).
 */
export const API_ERROR_CODES = {
  BAD_REQUEST: {
    status: 400,
    message: "The request could not be processed.",
    retryable: false,
  },
  UNAUTHORIZED: {
    status: 401,
    message: "You must be signed in to perform this action.",
    retryable: false,
  },
  FORBIDDEN: {
    status: 403,
    message: "You do not have permission to perform this action.",
    retryable: false,
  },
  NOT_FOUND: {
    status: 404,
    message: "The requested resource was not found.",
    retryable: false,
  },
  CONFLICT: {
    status: 409,
    message: "The request conflicts with the current state of the resource.",
    retryable: false,
  },
  VALIDATION_ERROR: {
    status: 422,
    message: "Please correct the highlighted fields.",
    retryable: false,
  },
  RATE_LIMITED: {
    status: 429,
    message: "Too many requests. Please try again shortly.",
    retryable: true,
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "Something went wrong. Please try again.",
    retryable: true,
  },
  DATABASE_ERROR: {
    status: 500,
    message: "Something went wrong. Please try again.",
    retryable: true,
  },
  UPSTREAM_ERROR: {
    status: 502,
    message: "A dependent service failed. Please try again.",
    retryable: true,
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "The service is temporarily unavailable. Please try again.",
    retryable: true,
  },
} as const satisfies Record<
  string,
  { status: number; message: string; retryable: boolean }
>

export type ApiErrorCode = keyof typeof API_ERROR_CODES

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && Object.hasOwn(API_ERROR_CODES, value)
}

export function getErrorStatus(code: ApiErrorCode): number {
  return API_ERROR_CODES[code].status
}
