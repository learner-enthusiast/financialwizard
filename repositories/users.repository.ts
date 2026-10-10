import "server-only"

import type { User } from "@/generated/prisma/client"
import { getPrisma } from "@/lib/db/prisma"
import { isUniqueConstraintError } from "@/lib/db/prisma-errors"
import type { ClerkUserProfile } from "@/schemas/user.schema"

export type { User }

/** Fields Clerk sync may write. Application-managed fields are excluded by construction. */
function toSyncedFields(profile: ClerkUserProfile) {
  return {
    email: profile.email,
    firstName: profile.firstName,
    lastName: profile.lastName,
    imageUrl: profile.imageUrl,
    clerkUpdatedAt: profile.clerkUpdatedAt,
  }
}

export const usersRepository = {
  findByClerkId(clerkId: string): Promise<User | null> {
    return getPrisma().user.findUnique({ where: { clerkId } })
  },

  findById(id: string): Promise<User | null> {
    return getPrisma().user.findUnique({ where: { id } })
  },

  /**
   * Idempotent upsert keyed by the unique `clerkId`. On update only
   * Clerk-synced fields are written. If two requests race to create the same
   * user, the loser hits the unique constraint and re-reads the winner's row.
   */
  async upsertFromClerk(profile: ClerkUserProfile): Promise<User> {
    const synced = toSyncedFields(profile)
    try {
      return await getPrisma().user.upsert({
        where: { clerkId: profile.clerkId },
        create: { clerkId: profile.clerkId, ...synced },
        update: synced,
      })
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
      const existing = await getPrisma().user.findUnique({ where: { clerkId: profile.clerkId } })
      if (!existing) throw error
      return existing
    }
  },

  /**
   * Soft delete: keeps the row (and every foreign key pointing at it) but
   * clears synced personal data. Application data is retained. When no row
   * exists yet, a tombstone is created so a late `user.created` delivery
   * cannot resurrect the user.
   */
  async markDeletedByClerkId(clerkId: string, deletedAt: Date): Promise<User> {
    const cleared = { deletedAt, email: null, firstName: null, lastName: null, imageUrl: null }
    try {
      return await getPrisma().user.upsert({
        where: { clerkId },
        create: { clerkId, ...cleared },
        update: cleared,
      })
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
      return getPrisma().user.update({ where: { clerkId }, data: cleared })
    }
  },

  updateBaseCurrency(id: string, baseCurrency: string): Promise<User> {
    return getPrisma().user.update({ where: { id }, data: { baseCurrency } })
  },
}

export type UsersRepository = typeof usersRepository
