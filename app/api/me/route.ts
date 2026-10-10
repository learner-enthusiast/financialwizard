import { createApiHandler } from "@/lib/api/api-handler"
import { requireAuth } from "@/lib/auth/authorization"
import { parseJsonBody } from "@/lib/validation/request"
import { updateCurrentUserSchema } from "@/schemas/user.schema"
import { toUserDto, usersService } from "@/services/users.service"

/** GET /api/me — the signed-in user's application profile. */
export const GET = createApiHandler(
  async () => {
    const { user } = await requireAuth()
    return { data: toUserDto(user) }
  },
  { route: "/api/me" }
)

/** PATCH /api/me — update application-managed preferences. */
export const PATCH = createApiHandler(
  async ({ request }) => {
    const { user } = await requireAuth()
    const input = await parseJsonBody(request, updateCurrentUserSchema)
    const updated = await usersService.updateCurrentUser(user, input)
    return { data: toUserDto(updated) }
  },
  { route: "/api/me" }
)
