/**
 * Provider-neutral view of a Clerk user, produced from either a webhook
 * payload (snake_case JSON) or the Backend API (`User` resource).
 */
export type ClerkUserSource = {
  id: string
  primaryEmailAddressId: string | null
  emailAddresses: Array<{ id: string; emailAddress: string; verified: boolean }>
  firstName: string | null
  lastName: string | null
  imageUrl: string | null
  /** Epoch milliseconds. */
  updatedAt: number
}
