import { z } from "zod"

/*
 * Isomorphic schemas: shared by route handlers (server validation) and forms
 * (client validation). The server always re-validates.
 */

export const userRoleSchema = z.enum(["USER", "ADMIN"])
export type UserRole = z.infer<typeof userRoleSchema>

export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Enter a 3-letter ISO currency code, e.g. USD.")

/** PATCH /api/me — only application-managed fields are user-editable. */
export const updateCurrentUserSchema = z
  .object({
    baseCurrency: currencyCodeSchema,
  })
  .strict()
export type UpdateCurrentUserInput = z.infer<typeof updateCurrentUserSchema>

/** Public shape of a user returned by the API. Never includes internal-only fields. */
export const userDtoSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  imageUrl: z.string().nullable(),
  role: userRoleSchema,
  baseCurrency: z.string(),
  createdAt: z.string(),
})
export type UserDto = z.infer<typeof userDtoSchema>

/**
 * Identity fields synchronized from Clerk, normalized from either a webhook
 * payload or the Clerk Backend API. The only fields sync is allowed to write.
 */
export type ClerkUserProfile = {
  clerkId: string
  email: string | null
  firstName: string | null
  lastName: string | null
  imageUrl: string | null
  clerkUpdatedAt: Date
}
