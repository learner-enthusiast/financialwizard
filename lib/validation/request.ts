import "server-only"

import type { NextRequest } from "next/server"
import type { z } from "zod"

import { ApiError } from "@/lib/api/api-error"

/*
 * Request parsing helpers. Zod failures are thrown as-is and converted to
 * VALIDATION_ERROR (422) with field details by the API handler.
 */

export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S
): Promise<z.infer<S>> {
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError("BAD_REQUEST", { message: "Request body must be JSON." })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch (error) {
    throw new ApiError("BAD_REQUEST", { message: "Request body contains malformed JSON.", cause: error })
  }

  return schema.parse(body)
}

export function parseSearchParams<S extends z.ZodType>(
  request: NextRequest,
  schema: S
): z.infer<S> {
  return schema.parse(Object.fromEntries(request.nextUrl.searchParams))
}

export function parseParams<S extends z.ZodType>(params: unknown, schema: S): z.infer<S> {
  return schema.parse(params)
}
