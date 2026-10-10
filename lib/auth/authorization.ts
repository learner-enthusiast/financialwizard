import "server-only"

import { auth } from "@clerk/nextjs/server"

import { ApiError } from "@/lib/api/api-error"
import type { User } from "@/repositories/users.repository"
import type { UserRole } from "@/schemas/user.schema"
import { usersService } from "@/services/users.service"

export type AuthContext = {
  /** Verified Clerk user ID from the session token. */
  clerkUserId: string
  /** Internal application user; use `user.id` for foreign keys. */
  user: User
}

/**
 * Server-side authentication guard for route handlers and server actions.
 * Identity comes only from Clerk's verified session; client-supplied IDs are
 * never trusted. Throws UNAUTHORIZED (401) when there is no valid session.
 */
export async function requireAuth(): Promise<AuthContext> {
  const { userId } = await auth()
  if (!userId) throw new ApiError("UNAUTHORIZED")

  const user = await usersService.resolveAuthenticatedUser(userId)
  return { clerkUserId: userId, user }
}

/** Throws FORBIDDEN (403) unless the user has one of the allowed roles. */
export function requireRole(user: User, ...allowed: UserRole[]): void {
  if (!allowed.includes(user.role)) {
    throw new ApiError("FORBIDDEN", { logContext: { requiredRoles: allowed } })
  }
}

/**
 * Ownership check for user-scoped resources. Responds NOT_FOUND rather than
 * FORBIDDEN so other users' resource IDs cannot be probed.
 */
export function assertOwnership(user: User, resource: { userId: string } | null | undefined): void {
  if (!resource || resource.userId !== user.id) {
    throw new ApiError("NOT_FOUND")
  }
}
