import { afterEach, describe, expect, it, vi } from "vitest"

import { apiClient, ApiClientError } from "@/lib/api/api-client"
import { shouldRetryQuery } from "@/lib/api/query-client"

function mockFetch(impl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl))
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_header123456" },
  })
}

async function capture(promise: Promise<unknown>): Promise<ApiClientError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiClientError) return error
    throw error
  }
  throw new Error("expected rejection")
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("apiClient", () => {
  it("unwraps data from the success envelope and sends JSON", async () => {
    mockFetch(async () => json({ success: true, data: { id: 1 }, meta: { requestId: "req_abc12345" } }))

    await expect(apiClient.patch("/api/me", { baseCurrency: "EUR" })).resolves.toEqual({ id: 1 })

    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json")
    expect(init?.body).toBe('{"baseCurrency":"EUR"}')
  })

  it("throws a typed http error with code, status, request ID and details", async () => {
    mockFetch(async () =>
      json(
        {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "Please correct the highlighted fields.", details: { email: ["Bad"] } },
          meta: { requestId: "req_err12345" },
        },
        422
      )
    )

    const error = await capture(apiClient.post("/api/x", {}))
    expect(error).toMatchObject({
      kind: "http",
      status: 422,
      code: "VALIDATION_ERROR",
      requestId: "req_err12345",
      details: { email: ["Bad"] },
      message: "Please correct the highlighted fields.",
    })
  })

  it("distinguishes network failures", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch")
    })
    const error = await capture(apiClient.get("/api/x"))
    expect(error.kind).toBe("network")
    expect(error.status).toBeNull()
  })

  it("distinguishes malformed JSON on success responses", async () => {
    mockFetch(async () => new Response("<html>oops</html>", { status: 200 }))
    const error = await capture(apiClient.get("/api/x"))
    expect(error.kind).toBe("parse")
  })

  it("distinguishes unexpected response shapes", async () => {
    mockFetch(async () => json({ hello: "world" }))
    const error = await capture(apiClient.get("/api/x"))
    expect(error).toMatchObject({ kind: "invalid_response", requestId: "req_header123456" })
  })

  it("treats a non-JSON 5xx (e.g. proxy error page) as an http error", async () => {
    mockFetch(async () => new Response("Bad Gateway", { status: 502 }))
    const error = await capture(apiClient.get("/api/x"))
    expect(error).toMatchObject({ kind: "http", status: 502, code: "UPSTREAM_ERROR" })
    expect(error.message).not.toContain("Bad Gateway")
  })

  it("reports cancellation as aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    mockFetch(async () => {
      throw new DOMException("aborted", "AbortError")
    })
    const error = await capture(apiClient.get("/api/x", { signal: controller.signal }))
    expect(error.kind).toBe("aborted")
  })
})

describe("shouldRetryQuery", () => {
  const httpError = (status: number, code: ApiClientError["code"]) =>
    new ApiClientError({ kind: "http", message: "x", status, code })

  it.each([
    [400, "BAD_REQUEST"],
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [422, "VALIDATION_ERROR"],
  ] as const)("does not retry %i %s", (status, code) => {
    expect(shouldRetryQuery(0, httpError(status, code))).toBe(false)
  })

  it.each([
    [429, "RATE_LIMITED"],
    [500, "INTERNAL_ERROR"],
    [502, "UPSTREAM_ERROR"],
    [503, "SERVICE_UNAVAILABLE"],
  ] as const)("retries %i %s", (status, code) => {
    expect(shouldRetryQuery(0, httpError(status, code))).toBe(true)
  })

  it("retries network errors but stops at the retry limit", () => {
    const error = new ApiClientError({ kind: "network", message: "x" })
    expect(shouldRetryQuery(0, error)).toBe(true)
    expect(shouldRetryQuery(2, error)).toBe(false)
  })

  it("never retries malformed responses, cancellations, or unknown errors", () => {
    expect(shouldRetryQuery(0, new ApiClientError({ kind: "parse", message: "x" }))).toBe(false)
    expect(shouldRetryQuery(0, new ApiClientError({ kind: "invalid_response", message: "x" }))).toBe(false)
    expect(shouldRetryQuery(0, new ApiClientError({ kind: "aborted", message: "x" }))).toBe(false)
    expect(shouldRetryQuery(0, new Error("x"))).toBe(false)
  })
})
