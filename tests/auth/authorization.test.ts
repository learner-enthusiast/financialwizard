import { auth } from "@clerk/nextjs/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { GET, PATCH } from "@/app/api/me/route"
import { createApiHandler } from "@/lib/api/api-handler"
import { assertOwnership, requireAuth, requireRole } from "@/lib/auth/authorization"
import { usersService } from "@/services/users.service"

import { makeRequest, makeUser, noParams, readBody } from "../helpers"

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }))
vi.mock("@/services/users.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/users.service")>()
  return {
    ...actual,
    usersService: { resolveAuthenticatedUser: vi.fn(), updateCurrentUser: vi.fn() },
  }
})

function signedIn(userId: string | null) {
  vi.mocked(auth).mockResolvedValue({ userId } as never)
}

beforeEach(() => {
  vi.mocked(usersService.resolveAuthenticatedUser).mockResolvedValue(makeUser())
})

describe("requireAuth", () => {
  it("returns 401 UNAUTHORIZED when there is no Clerk session", async () => {
    signedIn(null)
    const response = await GET(makeRequest("/api/me"), noParams)
    const body = await readBody(response)

    expect(response.status).toBe(401)
    expect(body).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } })
    expect(usersService.resolveAuthenticatedUser).not.toHaveBeenCalled()
  })

  it("resolves the internal user from the verified Clerk ID only", async () => {
    signedIn("user_123")
    const result = await requireAuth()

    expect(usersService.resolveAuthenticatedUser).toHaveBeenCalledWith("user_123")
    expect(result.user.id).toBe(makeUser().id)
  })

  it("ignores client-supplied user IDs", async () => {
    signedIn("user_123")
    await GET(makeRequest("/api/me?userId=user_attacker", { headers: { "x-user-id": "user_attacker" } }), noParams)
    expect(usersService.resolveAuthenticatedUser).toHaveBeenCalledWith("user_123")
  })

  it("returns the user DTO without internal fields", async () => {
    signedIn("user_123")
    const body = await readBody<Record<string, unknown>>(await GET(makeRequest("/api/me"), noParams))

    expect(body.success).toBe(true)
    if (!body.success) return
    expect(body.data).toMatchObject({ email: "ada@example.com", baseCurrency: "USD" })
    expect(body.data).not.toHaveProperty("clerkId")
    expect(body.data).not.toHaveProperty("deletedAt")
  })
})

describe("PATCH /api/me", () => {
  it("returns 422 with field details for invalid input", async () => {
    signedIn("user_123")
    const request = makeRequest("/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseCurrency: "dollars" }),
    })
    const body = await readBody(await PATCH(request, noParams))

    expect(body).toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR", details: { baseCurrency: [expect.any(String)] } },
    })
  })

  it("rejects unknown fields such as role (no privilege escalation)", async () => {
    signedIn("user_123")
    const request = makeRequest("/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseCurrency: "EUR", role: "ADMIN" }),
    })
    const response = await PATCH(request, noParams)

    expect(response.status).toBe(422)
    expect(usersService.updateCurrentUser).not.toHaveBeenCalled()
  })
})

describe("requireRole / assertOwnership", () => {
  it("returns 403 FORBIDDEN when the user lacks the role", async () => {
    signedIn("user_123")
    const adminOnly = createApiHandler(async () => {
      const { user } = await requireAuth()
      requireRole(user, "ADMIN")
      return { data: { ok: true } }
    })

    const response = await adminOnly(makeRequest("/api/admin"), noParams)
    expect(response.status).toBe(403)
    expect(await readBody(response)).toMatchObject({ error: { code: "FORBIDDEN" } })
  })

  it("allows users with the role", () => {
    expect(() => requireRole(makeUser({ role: "ADMIN" }), "ADMIN")).not.toThrow()
  })

  it("hides other users' resources as NOT_FOUND", () => {
    const user = makeUser()
    expect(() => assertOwnership(user, { userId: "someone-else" })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
    expect(() => assertOwnership(user, null)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
    expect(() => assertOwnership(user, { userId: user.id })).not.toThrow()
  })
})
