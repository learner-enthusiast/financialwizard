import "server-only"

import { clerkClient } from "@clerk/nextjs/server"

import { ApiError } from "@/lib/api/api-error"
import type { ClerkUserSource } from "@/lib/clients/clerk/types"

/**
 * Fetches a user from the Clerk Backend API. Only used as a fallback when a
 * signed-in user has no local record yet (webhooks are the normal sync path).
 * Returns null when Clerk does not know the user.
 */
export async function fetchClerkUser(clerkId: string): Promise<ClerkUserSource | null> {
  try {
    const client = await clerkClient()
    const user = await client.users.getUser(clerkId)
    return {
      id: user.id,
      primaryEmailAddressId: user.primaryEmailAddressId,
      emailAddresses: user.emailAddresses.map((address) => ({
        id: address.id,
        emailAddress: address.emailAddress,
        verified: address.verification?.status === "verified",
      })),
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
      updatedAt: user.updatedAt,
    }
  } catch (error) {
    if ((error as { status?: unknown })?.status === 404) return null
    throw new ApiError("UPSTREAM_ERROR", { cause: error, logContext: { upstream: "clerk" } })
  }
}
