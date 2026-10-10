import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { ApiError } from "@/lib/api/api-error"
import { createApiHandler } from "@/lib/api/api-handler"
import { parseJsonBody } from "@/lib/validation/request"

import { makeRequest, noParams, prismaError, readBody, type LogLine } from "../helpers"

const logs = vi.hoisted(() => [] as LogLine[])
vi.mock("@/lib/logger/logger", async () => {
  const { createCapturingLogger } = await import("../helpers")
  return { logger: await createCapturingLogger(logs) }
})

const bodySchema = z.object({ email: z.email("Enter a valid email address."), age: z.number().int() })

const echoHandler = createApiHandler(
  async ({ request }) => {
    const body = await parseJsonBody(request, bodySchema)
    return { data: body, status: 201 }
  },
  { route: "/api/test" }
)

function postJson(body: string, headers: Record<string, string> = {}) {
  return makeRequest("/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  })
}

beforeEach(() => {
  logs.length = 0
})

describe("createApiHandler", () => {
  it("wraps successful results in the success envelope with a request ID", async () => {
    const response = await echoHandler(postJson(JSON.stringify({ email: "a@b.co", age: 30 })), noParams)
    const body = await readBody(response)

    expect(response.status).toBe(201)
    expect(body).toEqual({
      success: true,
      data: { email: "a@b.co", age: 30 },
      meta: { requestId: expect.stringMatching(/^req_/) },
    })
    expect(response.headers.get("x-request-id")).toBe(body.meta.requestId)
  })

  it("reuses a well-formed proxy request ID and replaces malformed ones", async () => {
    const proxied = await echoHandler(
      postJson(JSON.stringify({ email: "a@b.co", age: 1 }), { "x-request-id": "req_abcdef123456" }),
      noParams
    )
    expect((await readBody(proxied)).meta.requestId).toBe("req_abcdef123456")

    const spoofed = await echoHandler(
      postJson(JSON.stringify({ email: "a@b.co", age: 1 }), { "x-request-id": "<script>" }),
      noParams
    )
    expect((await readBody(spoofed)).meta.requestId).not.toBe("<script>")
  })

  it("returns 422 VALIDATION_ERROR with field-level details for Zod failures", async () => {
    const response = await echoHandler(postJson(JSON.stringify({ email: "nope", age: 1.5 })), noParams)
    const body = await readBody(response)

    expect(response.status).toBe(422)
    expect(body.success).toBe(false)
    if (body.success) return
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(body.error.message).toBe("Please correct the highlighted fields.")
    expect(body.error.details?.email).toEqual(["Enter a valid email address."])
    expect(body.error.details?.age).toHaveLength(1)
  })

  it("returns 400 BAD_REQUEST for malformed JSON", async () => {
    const response = await echoHandler(postJson("{ not json"), noParams)
    const body = await readBody(response)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({
      success: false,
      error: { code: "BAD_REQUEST", message: "Request body contains malformed JSON." },
    })
  })

  it("returns 400 when the body is not JSON", async () => {
    const request = makeRequest("/api/test", { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" })
    const response = await echoHandler(request, noParams)
    expect(response.status).toBe(400)
  })

  it("maps known application errors to their status and safe message", async () => {
    const handler = createApiHandler(async () => {
      throw new ApiError("CONFLICT", { message: "That account already exists." })
    })
    const response = await handler(makeRequest("/api/test"), noParams)
    const body = await readBody(response)

    expect(response.status).toBe(409)
    expect(body).toMatchObject({ error: { code: "CONFLICT", message: "That account already exists." } })
    expect(logs.at(-1)).toMatchObject({ level: 40, errorCode: "CONFLICT" })
  })

  it("returns a generic 500 for unexpected exceptions without leaking internals", async () => {
    const handler = createApiHandler(async () => {
      throw new Error("connect ECONNREFUSED postgres://admin:s3cret@db:5432 at /srv/app/lib/db.ts")
    })
    const response = await handler(makeRequest("/api/test"), noParams)
    const raw = await response.text()

    expect(response.status).toBe(500)
    expect(raw).not.toMatch(/s3cret|ECONNREFUSED|\/srv\/app|stack/)
    expect(JSON.parse(raw)).toMatchObject({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
    })
  })

  it("logs unexpected failures once, with the same request ID as the response", async () => {
    const handler = createApiHandler(async () => {
      throw new TypeError("boom")
    }, { route: "/api/test" })
    const response = await handler(makeRequest("/api/test"), noParams)
    const body = await readBody(response)

    const errorLogs = logs.filter((line) => line.level >= 50)
    expect(errorLogs).toHaveLength(1)
    expect(errorLogs[0]).toMatchObject({
      requestId: body.meta.requestId,
      route: "/api/test",
      method: "GET",
      status: 500,
      errorCode: "INTERNAL_ERROR",
      err: { type: "TypeError", message: "boom", stack: expect.any(String) },
    })
    expect(response.headers.get("x-request-id")).toBe(body.meta.requestId)
  })

  it("logs successful requests at info with status and duration", async () => {
    const handler = createApiHandler(async () => ({ data: { ok: true } }), { route: "/api/test" })
    const response = await handler(makeRequest("/api/test"), noParams)
    const body = await readBody(response)

    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      level: 30,
      requestId: body.meta.requestId,
      status: 200,
      durationMs: expect.any(Number),
    })
  })

  it.each([
    ["P2002", 409, "CONFLICT"],
    ["P2025", 404, "NOT_FOUND"],
    ["P1001", 503, "SERVICE_UNAVAILABLE"],
    ["P2010", 500, "DATABASE_ERROR"],
  ])("maps Prisma error %s to %i %s without leaking SQL", async (code, status, errorCode) => {
    const handler = createApiHandler(async () => {
      throw prismaError(code)
    })
    const response = await handler(makeRequest("/api/test"), noParams)
    const raw = await response.text()

    expect(response.status).toBe(status)
    expect(JSON.parse(raw).error.code).toBe(errorCode)
    expect(raw).not.toMatch(/SELECT|hunter2|prisma/i)
  })

  it("maps Prisma initialization failures to 503", async () => {
    const handler = createApiHandler(async () => {
      throw prismaError("", "PrismaClientInitializationError")
    })
    const response = await handler(makeRequest("/api/test"), noParams)
    expect(response.status).toBe(503)
  })
})
