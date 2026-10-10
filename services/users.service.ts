import "server-only"

import type { UserJSON, WebhookEvent } from "@clerk/nextjs/server"

import { fetchClerkUser } from "@/lib/clients/clerk/clerk-users.client"
import type { ClerkUserSource } from "@/lib/clients/clerk/types"
import { ApiError } from "@/lib/api/api-error"
import { getLogger } from "@/lib/logger/request-context"
import { usersRepository, type User } from "@/repositories/users.repository"
import type { ClerkUserProfile, UpdateCurrentUserInput, UserDto } from "@/schemas/user.schema"

export type SyncOutcome =
  | "upserted"
  | "skipped_stale"
  | "skipped_deleted"
  | "deleted"
  | "already_deleted"
  | "ignored"

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function fromWebhookUser(json: UserJSON): ClerkUserSource {
  return {
    id: json.id,
    primaryEmailAddressId: json.primary_email_address_id,
    emailAddresses: (json.email_addresses ?? []).map((address) => ({
      id: address.id,
      emailAddress: address.email_address,
      verified: address.verification?.status === "verified",
    })),
    firstName: json.first_name,
    lastName: json.last_name,
    imageUrl: json.image_url || null,
    updatedAt: json.updated_at,
  }
}

/**
 * Picks the primary email only if verified, otherwise the first verified
 * email, otherwise null. Unverified addresses are never stored.
 */
export function selectVerifiedEmail(source: ClerkUserSource): string | null {
  const verified = source.emailAddresses.filter((address) => address.verified)
  const primary = verified.find((address) => address.id === source.primaryEmailAddressId)
  return (primary ?? verified[0])?.emailAddress.toLowerCase() ?? null
}

export function toClerkUserProfile(source: ClerkUserSource): ClerkUserProfile {
  return {
    clerkId: source.id,
    email: selectVerifiedEmail(source),
    firstName: source.firstName?.trim() || null,
    lastName: source.lastName?.trim() || null,
    imageUrl: source.imageUrl || null,
    clerkUpdatedAt: new Date(source.updatedAt),
  }
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    imageUrl: user.imageUrl,
    role: user.role,
    baseCurrency: user.baseCurrency,
    createdAt: user.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const usersService = {
  /**
   * Idempotent Clerk -> database sync. Safe under at-least-once delivery:
   * repeated events produce the same row, older events never overwrite newer
   * data, and deleted users are never resurrected.
   */
  async syncFromClerk(source: ClerkUserSource): Promise<{ outcome: SyncOutcome; user?: User }> {
    const profile = toClerkUserProfile(source)
    const existing = await usersRepository.findByClerkId(profile.clerkId)

    if (existing?.deletedAt) {
      return { outcome: "skipped_deleted" }
    }
    if (existing?.clerkUpdatedAt && existing.clerkUpdatedAt > profile.clerkUpdatedAt) {
      return { outcome: "skipped_stale", user: existing }
    }

    const user = await usersRepository.upsertFromClerk(profile)
    return { outcome: "upserted", user }
  },

  async markDeleted(clerkId: string): Promise<SyncOutcome> {
    const existing = await usersRepository.findByClerkId(clerkId)
    if (existing?.deletedAt) return "already_deleted"
    await usersRepository.markDeletedByClerkId(clerkId, new Date())
    return "deleted"
  },

  /** Dispatches a verified Clerk webhook event. Unknown types are acknowledged and ignored. */
  async handleClerkWebhookEvent(event: WebhookEvent): Promise<SyncOutcome> {
    switch (event.type) {
      case "user.created":
      case "user.updated":
        return (await usersService.syncFromClerk(fromWebhookUser(event.data))).outcome
      case "user.deleted": {
        const clerkId = event.data.id
        if (!clerkId) {
          throw new ApiError("BAD_REQUEST", { message: "Webhook payload is missing the user ID." })
        }
        return usersService.markDeleted(clerkId)
      }
      default:
        return "ignored"
    }
  },

  /**
   * Resolves the internal user for a verified Clerk ID. Normal path is a
   * single local lookup; the Clerk API is called only when the webhook has
   * not yet created the row.
   */
  async resolveAuthenticatedUser(clerkId: string): Promise<User> {
    const existing = await usersRepository.findByClerkId(clerkId)
    if (existing) {
      if (existing.deletedAt) throw new ApiError("FORBIDDEN", { message: "This account has been deactivated." })
      return existing
    }

    getLogger().info({ event: "user.sync.fallback" }, "local user missing; syncing from Clerk")
    const source = await fetchClerkUser(clerkId)
    if (!source) throw new ApiError("UNAUTHORIZED")

    const { user } = await usersService.syncFromClerk(source)
    if (!user) throw new ApiError("FORBIDDEN", { message: "This account has been deactivated." })
    return user
  },

  async updateCurrentUser(user: User, input: UpdateCurrentUserInput): Promise<User> {
    return usersRepository.updateBaseCurrency(user.id, input.baseCurrency)
  },
}
