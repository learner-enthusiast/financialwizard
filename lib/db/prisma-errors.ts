import { ApiError } from "@/lib/api/api-error"

/*
 * Maps Prisma errors to safe application errors. Detection is structural
 * (error name + code) so it works for any generated client instance and in
 * tests without constructing real Prisma errors. Raw Prisma messages, SQL and
 * metadata are kept only as `cause` for server logs.
 */

type PrismaLikeError = Error & { code?: string; meta?: unknown }

const CONNECTION_ERROR_CODES = new Set([
  "P1000", // authentication failed
  "P1001", // can't reach database server
  "P1002", // database server timed out
  "P1008", // operations timed out
  "P1017", // server closed the connection
  "P2024", // connection pool timeout
])

function isPrismaKnownRequestError(error: unknown): error is PrismaLikeError {
  return (
    error instanceof Error &&
    error.name === "PrismaClientKnownRequestError" &&
    typeof (error as PrismaLikeError).code === "string"
  )
}

export function isPrismaError(error: unknown): error is Error {
  return error instanceof Error && error.name.startsWith("PrismaClient")
}

export function isUniqueConstraintError(error: unknown): boolean {
  return isPrismaKnownRequestError(error) && error.code === "P2002"
}

export function isRecordNotFoundError(error: unknown): boolean {
  return isPrismaKnownRequestError(error) && error.code === "P2025"
}

export function mapPrismaError(error: unknown): ApiError | undefined {
  if (!isPrismaError(error)) return undefined

  if (isPrismaKnownRequestError(error)) {
    const code = error.code as string
    if (code === "P2002") return new ApiError("CONFLICT", { cause: error, logContext: { prismaCode: code } })
    if (code === "P2025") return new ApiError("NOT_FOUND", { cause: error, logContext: { prismaCode: code } })
    if (CONNECTION_ERROR_CODES.has(code)) {
      return new ApiError("SERVICE_UNAVAILABLE", { cause: error, logContext: { prismaCode: code } })
    }
    return new ApiError("DATABASE_ERROR", { cause: error, logContext: { prismaCode: code } })
  }

  if (error.name === "PrismaClientInitializationError") {
    return new ApiError("SERVICE_UNAVAILABLE", { cause: error })
  }

  // PrismaClientValidationError, PrismaClientRustPanicError, unknown request errors.
  return new ApiError("DATABASE_ERROR", { cause: error })
}
