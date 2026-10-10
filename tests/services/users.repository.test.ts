import { beforeEach, describe, expect, it, vi } from "vitest"

import { getPrisma } from "@/lib/db/prisma"
import { usersRepository } from "@/repositories/users.repository"

import { makeUser, prismaError } from "../helpers"

const prismaUser = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
}
vi.mock("@/lib/db/prisma", () => ({ getPrisma: vi.fn() }))

const profile = {
  clerkId: "user_123",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: null,
  imageUrl: null,
  clerkUpdatedAt: new Date("2026-02-01T00:00:00Z"),
}

beforeEach(() => {
  vi.mocked(getPrisma).mockReturnValue({ user: prismaUser } as never)
})

describe("usersRepository.upsertFromClerk", () => {
  it("upserts keyed by clerkId and writes only synced fields on update", async () => {
    prismaUser.upsert.mockResolvedValue(makeUser())
    await usersRepository.upsertFromClerk(profile)

    const args = prismaUser.upsert.mock.calls[0][0]
    expect(args.where).toEqual({ clerkId: "user_123" })
    expect(Object.keys(args.update).sort()).toEqual(
      ["clerkUpdatedAt", "email", "firstName", "imageUrl", "lastName"]
    )
  })

  it("recovers from a concurrent-create unique violation by re-reading the row", async () => {
    const winner = makeUser()
    prismaUser.upsert.mockRejectedValue(prismaError("P2002"))
    prismaUser.findUnique.mockResolvedValue(winner)

    await expect(usersRepository.upsertFromClerk(profile)).resolves.toBe(winner)
  })

  it("rethrows other database errors for central mapping", async () => {
    const error = prismaError("P1001")
    prismaUser.upsert.mockRejectedValue(error)

    await expect(usersRepository.upsertFromClerk(profile)).rejects.toBe(error)
  })
})

describe("usersRepository.markDeletedByClerkId", () => {
  it("clears personal data and sets deletedAt, creating a tombstone if needed", async () => {
    prismaUser.upsert.mockResolvedValue(makeUser())
    const deletedAt = new Date()
    await usersRepository.markDeletedByClerkId("user_123", deletedAt)

    const args = prismaUser.upsert.mock.calls[0][0]
    expect(args.create).toEqual({ clerkId: "user_123", deletedAt, email: null, firstName: null, lastName: null, imageUrl: null })
    expect(args.update).toMatchObject({ deletedAt, email: null })
  })
})
