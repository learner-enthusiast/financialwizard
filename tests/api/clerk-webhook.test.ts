import { verifyWebhook } from "@clerk/nextjs/webhooks"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { POST } from "@/app/api/webhooks/clerk/route"
import { getServerEnv } from "@/lib/env"
import { usersRepository } from "@/repositories/users.repository"

import { makeRequest, makeUser, noParams, prismaError, readBody } from "../helpers"

vi.mock("@clerk/nextjs/webhooks", () => ({ verifyWebhook: vi.fn() }))
vi.mock("@/lib/env", () => ({ getServerEnv: vi.fn(), getLogLevel: () => "silent" }))
vi.mock("@/lib/clients/clerk/clerk-users.client", () => ({ fetchClerkUser: vi.fn() }))
vi.mock("@/repositories/users.repository", () => ({
  usersRepository: {
    findByClerkId: vi.fn(),
    upsertFromClerk: vi.fn(),
    markDeletedByClerkId: vi.fn(),
  },
}))

const repo = vi.mocked(usersRepository)

const createdEvent = {
  type: "user.created",
  object: "event",
  data: {
    id: "user_123",
    first_name: "Ada",
    last_name: null,
    image_url: "",
    primary_email_address_id: null,
    email_addresses: [],
    updated_at: Date.now(),
  },
}

function webhookRequest() {
  return makeRequest("/api/webhooks/clerk", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": "msg_1", "svix-signature": "v1,sig" },
    body: JSON.stringify(createdEvent),
  })
}

beforeEach(() => {
  vi.mocked(getServerEnv).mockReturnValue({ CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test" } as never)
  vi.mocked(verifyWebhook).mockResolvedValue(createdEvent as never)
  repo.findByClerkId.mockResolvedValue(null)
  repo.upsertFromClerk.mockResolvedValue(makeUser())
})

describe("POST /api/webhooks/clerk", () => {
  it("verifies the signature with the configured secret and upserts the user", async () => {
    const response = await POST(webhookRequest(), noParams)
    const body = await readBody(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true, data: { received: true, outcome: "upserted" } })
    expect(verifyWebhook).toHaveBeenCalledWith(expect.anything(), { signingSecret: "whsec_test" })
  })

  it("returns 2xx for duplicate deliveries", async () => {
    expect((await POST(webhookRequest(), noParams)).status).toBe(200)
    expect((await POST(webhookRequest(), noParams)).status).toBe(200)
  })

  it("rejects invalid signatures with 400 and never touches the database", async () => {
    vi.mocked(verifyWebhook).mockRejectedValue(new Error("No matching signature found"))

    const response = await POST(webhookRequest(), noParams)
    const raw = await response.text()

    expect(response.status).toBe(400)
    expect(JSON.parse(raw).error).toEqual({ code: "BAD_REQUEST", message: "Invalid webhook signature." })
    expect(raw).not.toContain("No matching signature")
    expect(repo.upsertFromClerk).not.toHaveBeenCalled()
  })

  it("returns 503 when the signing secret is not configured", async () => {
    vi.mocked(getServerEnv).mockReturnValue({} as never)
    const response = await POST(webhookRequest(), noParams)
    expect(response.status).toBe(503)
    expect(verifyWebhook).not.toHaveBeenCalled()
  })

  it("returns a retryable 5xx when the database is unavailable", async () => {
    repo.upsertFromClerk.mockRejectedValue(prismaError("P1001"))
    const response = await POST(webhookRequest(), noParams)
    expect(response.status).toBe(503)
  })

  it("returns 500 for unexpected processing failures so Clerk retries", async () => {
    repo.upsertFromClerk.mockRejectedValue(new Error("unexpected"))
    const response = await POST(webhookRequest(), noParams)
    expect(response.status).toBe(500)
  })
})

describe("webhook logging", () => {
  it("correlates failure logs with the Svix event ID and the response request ID", async () => {
    const lines: Record<string, unknown>[] = []
    const { createCapturingLogger } = await import("../helpers")
    const capture = await createCapturingLogger(lines as never)
    const loggerModule = await import("@/lib/logger/logger")
    vi.spyOn(loggerModule.logger, "child").mockImplementation((bindings) => capture.child(bindings))

    repo.upsertFromClerk.mockRejectedValue(new Error("db exploded"))
    const response = await POST(webhookRequest(), noParams)
    const body = await readBody(response)

    const errorLine = lines.find((line) => (line.level as number) >= 50)
    expect(errorLine).toMatchObject({ requestId: body.meta.requestId, webhookEventId: "msg_1", status: 500 })
    expect(JSON.stringify(lines)).not.toContain("v1,sig")
  })
})
