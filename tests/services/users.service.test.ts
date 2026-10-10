import type { UserJSON, WebhookEvent } from "@clerk/nextjs/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { fetchClerkUser } from "@/lib/clients/clerk/clerk-users.client"
import { ApiError } from "@/lib/api/api-error"
import { usersRepository } from "@/repositories/users.repository"
import { selectVerifiedEmail, toClerkUserProfile, usersService } from "@/services/users.service"

import { makeUser } from "../helpers"

vi.mock("@/repositories/users.repository", () => ({
  usersRepository: {
    findByClerkId: vi.fn(),
    upsertFromClerk: vi.fn(),
    markDeletedByClerkId: vi.fn(),
    updateBaseCurrency: vi.fn(),
  },
}))
vi.mock("@/lib/clients/clerk/clerk-users.client", () => ({ fetchClerkUser: vi.fn() }))

const repo = vi.mocked(usersRepository)

function userJson(overrides: Partial<UserJSON> = {}): UserJSON {
  return {
    id: "user_123",
    first_name: "Ada",
    last_name: "Lovelace",
    image_url: "https://img.clerk.com/ada.png",
    primary_email_address_id: "idn_1",
    email_addresses: [
      { id: "idn_1", email_address: "Ada@Example.com", verification: { status: "verified" } },
    ],
    updated_at: Date.parse("2026-02-01T00:00:00Z"),
    ...overrides,
  } as unknown as UserJSON
}

function userEvent(type: "user.created" | "user.updated", data = userJson()): WebhookEvent {
  return { type, data, object: "event" } as unknown as WebhookEvent
}

beforeEach(() => {
  repo.findByClerkId.mockResolvedValue(null)
  repo.upsertFromClerk.mockImplementation(async (profile) => makeUser({ ...profile }))
})

describe("Clerk user mapping", () => {
  it("normalizes the verified primary email to lowercase", () => {
    expect(toClerkUserProfile({
      id: "user_1", primaryEmailAddressId: "a", firstName: " Ada ", lastName: null, imageUrl: "", updatedAt: 0,
      emailAddresses: [{ id: "a", emailAddress: "Ada@Example.com", verified: true }],
    })).toMatchObject({ email: "ada@example.com", firstName: "Ada", lastName: null, imageUrl: null })
  })

  it("returns null when the user has no email addresses", () => {
    expect(selectVerifiedEmail({
      id: "u", primaryEmailAddressId: null, emailAddresses: [], firstName: null, lastName: null, imageUrl: null, updatedAt: 0,
    })).toBeNull()
  })

  it("never stores an unverified email; falls back to another verified address", () => {
    const base = { id: "u", firstName: null, lastName: null, imageUrl: null, updatedAt: 0 }
    expect(selectVerifiedEmail({
      ...base, primaryEmailAddressId: "a",
      emailAddresses: [{ id: "a", emailAddress: "unverified@x.io", verified: false }],
    })).toBeNull()
    expect(selectVerifiedEmail({
      ...base, primaryEmailAddressId: "a",
      emailAddresses: [
        { id: "a", emailAddress: "unverified@x.io", verified: false },
        { id: "b", emailAddress: "verified@x.io", verified: true },
      ],
    })).toBe("verified@x.io")
  })
})

describe("usersService.handleClerkWebhookEvent", () => {
  it("upserts on user.created with only Clerk-synced fields", async () => {
    const outcome = await usersService.handleClerkWebhookEvent(userEvent("user.created"))

    expect(outcome).toBe("upserted")
    expect(repo.upsertFromClerk).toHaveBeenCalledWith({
      clerkId: "user_123",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      imageUrl: "https://img.clerk.com/ada.png",
      clerkUpdatedAt: new Date("2026-02-01T00:00:00Z"),
    })
  })

  it("updates without passing application-managed fields (role, baseCurrency)", async () => {
    repo.findByClerkId.mockResolvedValue(
      makeUser({ role: "ADMIN", baseCurrency: "EUR", clerkUpdatedAt: new Date("2026-01-01T00:00:00Z") })
    )

    await usersService.handleClerkWebhookEvent(userEvent("user.updated", userJson({ first_name: "Augusta" })))

    const profile = repo.upsertFromClerk.mock.calls[0][0]
    expect(profile.firstName).toBe("Augusta")
    expect(profile).not.toHaveProperty("role")
    expect(profile).not.toHaveProperty("baseCurrency")
    expect(profile).not.toHaveProperty("deletedAt")
  })

  it("is idempotent under duplicate delivery", async () => {
    const event = userEvent("user.created")
    const first = await usersService.handleClerkWebhookEvent(event)
    repo.findByClerkId.mockResolvedValue(makeUser({ clerkUpdatedAt: new Date("2026-02-01T00:00:00Z") }))
    const second = await usersService.handleClerkWebhookEvent(event)

    expect([first, second]).toEqual(["upserted", "upserted"])
    expect(repo.upsertFromClerk.mock.calls[0][0]).toEqual(repo.upsertFromClerk.mock.calls[1][0])
  })

  it("ignores out-of-order (older) updates", async () => {
    repo.findByClerkId.mockResolvedValue(makeUser({ clerkUpdatedAt: new Date("2026-03-01T00:00:00Z") }))

    const outcome = await usersService.handleClerkWebhookEvent(userEvent("user.updated"))

    expect(outcome).toBe("skipped_stale")
    expect(repo.upsertFromClerk).not.toHaveBeenCalled()
  })

  it("syncs users with no email address", async () => {
    await usersService.handleClerkWebhookEvent(
      userEvent("user.created", userJson({ email_addresses: [], primary_email_address_id: null }))
    )
    expect(repo.upsertFromClerk.mock.calls[0][0].email).toBeNull()
  })

  it("soft-deletes on user.deleted, retaining the row for foreign keys", async () => {
    // A user with related financial data: the row must survive.
    repo.findByClerkId.mockResolvedValue(makeUser())
    repo.markDeletedByClerkId.mockResolvedValue(makeUser({ deletedAt: new Date() }))

    const outcome = await usersService.handleClerkWebhookEvent({
      type: "user.deleted", data: { id: "user_123", deleted: true, object: "user" },
    } as unknown as WebhookEvent)

    expect(outcome).toBe("deleted")
    expect(repo.markDeletedByClerkId).toHaveBeenCalledWith("user_123", expect.any(Date))
    expect(usersRepository).not.toHaveProperty("delete")
  })

  it("treats repeated user.deleted as already handled", async () => {
    repo.findByClerkId.mockResolvedValue(makeUser({ deletedAt: new Date() }))
    const outcome = await usersService.handleClerkWebhookEvent({
      type: "user.deleted", data: { id: "user_123", deleted: true, object: "user" },
    } as unknown as WebhookEvent)

    expect(outcome).toBe("already_deleted")
    expect(repo.markDeletedByClerkId).not.toHaveBeenCalled()
  })

  it("does not resurrect a deleted user on a late user.created", async () => {
    repo.findByClerkId.mockResolvedValue(makeUser({ deletedAt: new Date() }))
    const outcome = await usersService.handleClerkWebhookEvent(userEvent("user.created"))

    expect(outcome).toBe("skipped_deleted")
    expect(repo.upsertFromClerk).not.toHaveBeenCalled()
  })

  it("acknowledges unrelated event types without side effects", async () => {
    const outcome = await usersService.handleClerkWebhookEvent({ type: "session.created", data: {} } as unknown as WebhookEvent)
    expect(outcome).toBe("ignored")
  })
})

describe("usersService.resolveAuthenticatedUser", () => {
  it("returns the local user without calling Clerk", async () => {
    const user = makeUser()
    repo.findByClerkId.mockResolvedValue(user)

    await expect(usersService.resolveAuthenticatedUser("user_123")).resolves.toBe(user)
    expect(fetchClerkUser).not.toHaveBeenCalled()
  })

  it("syncs from Clerk when the local record is missing", async () => {
    vi.mocked(fetchClerkUser).mockResolvedValue({
      id: "user_123", primaryEmailAddressId: null, emailAddresses: [], firstName: "Ada",
      lastName: null, imageUrl: null, updatedAt: Date.now(),
    })

    const user = await usersService.resolveAuthenticatedUser("user_123")

    expect(fetchClerkUser).toHaveBeenCalledWith("user_123")
    expect(repo.upsertFromClerk).toHaveBeenCalledOnce()
    expect(user.clerkId).toBe("user_123")
  })

  it("rejects deactivated users with FORBIDDEN", async () => {
    repo.findByClerkId.mockResolvedValue(makeUser({ deletedAt: new Date() }))
    await expect(usersService.resolveAuthenticatedUser("user_123")).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("rejects with UNAUTHORIZED when Clerk does not know the user", async () => {
    vi.mocked(fetchClerkUser).mockResolvedValue(null)
    await expect(usersService.resolveAuthenticatedUser("user_gone")).rejects.toBeInstanceOf(ApiError)
    await expect(usersService.resolveAuthenticatedUser("user_gone")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })
})
