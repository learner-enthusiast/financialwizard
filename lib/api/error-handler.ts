import "server-only"

import { z } from "zod"

import { ApiError, isApiError, type ApiErrorDetails } from "@/lib/api/api-error"
import { mapPrismaError } from "@/lib/db/prisma-errors"

/** Converts Zod issues into `{ "field.path": ["message"] }`. */
export function zodErrorToDetails(error: z.ZodError): ApiErrorDetails {
  const details: ApiErrorDetails = {}
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_root"
    ;(details[key] ??= []).push(issue.message)
  }
  return details
}

/**
 * Normalizes any thrown value into an ApiError with a client-safe message.
 * Unknown errors become INTERNAL_ERROR; their message is never exposed.
 */
export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error

  if (error instanceof z.ZodError) {
    return new ApiError("VALIDATION_ERROR", {
      details: zodErrorToDetails(error),
      cause: error,
    })
  }

  const prismaError = mapPrismaError(error)
  if (prismaError) return prismaError

  return new ApiError("INTERNAL_ERROR", { cause: error })
}
