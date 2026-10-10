import { NextResponse } from "next/server"

import type { ApiErrorCode } from "@/lib/api/api-error-codes"
import type { ApiError, ApiErrorDetails } from "@/lib/api/api-error"

/*
 * The single API response contract. Types here are shared with the client
 * (import them with `import type` from client code); the builders are server-side.
 */

export const REQUEST_ID_HEADER = "x-request-id"

export type ApiMeta = {
  requestId: string
}

export type ApiSuccessBody<T> = {
  success: true
  data: T
  meta: ApiMeta
}

export type ApiErrorBody = {
  success: false
  error: {
    code: ApiErrorCode
    message: string
    details?: ApiErrorDetails
  }
  meta: ApiMeta
}

export type ApiResponseBody<T> = ApiSuccessBody<T> | ApiErrorBody

type ResponseInit = {
  status?: number
  headers?: HeadersInit
}

export function successResponse<T>(
  data: T,
  requestId: string,
  init: ResponseInit = {}
): NextResponse<ApiSuccessBody<T>> {
  const headers = new Headers(init.headers)
  headers.set(REQUEST_ID_HEADER, requestId)

  return NextResponse.json(
    { success: true, data, meta: { requestId } },
    { status: init.status ?? 200, headers }
  )
}

export function errorResponse(
  error: ApiError,
  requestId: string
): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = {
    success: false,
    error: {
      code: error.code,
      message: error.publicMessage,
      ...(error.details ? { details: error.details } : {}),
    },
    meta: { requestId },
  }

  return NextResponse.json(body, {
    status: error.status,
    headers: { [REQUEST_ID_HEADER]: requestId },
  })
}
