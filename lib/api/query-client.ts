import { QueryClient } from "@tanstack/react-query"

import { API_ERROR_CODES } from "@/lib/api/api-error-codes"
import { isApiClientError } from "@/lib/api/api-client"

export const MAX_QUERY_RETRIES = 2

/**
 * Retry only failures that may succeed on a second attempt:
 * network errors, 408/429, and 5xx/retryable error codes.
 * Ordinary 4xx, malformed responses and cancellations are never retried.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false
  if (!isApiClientError(error)) return false

  switch (error.kind) {
    case "network":
      return true
    case "aborted":
    case "parse":
    case "invalid_response":
      return false
    case "http": {
      if (error.code) return API_ERROR_CODES[error.code].retryable
      const status = error.status ?? 0
      return status === 408 || status === 429 || status >= 500
    }
  }
}

export function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 8000)
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
        retryDelay,
      },
      mutations: {
        retry: false,
      },
    },
  })
}
