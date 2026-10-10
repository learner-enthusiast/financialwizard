import { verifyWebhook } from "@clerk/nextjs/webhooks"

import { ApiError } from "@/lib/api/api-error"
import { createApiHandler } from "@/lib/api/api-handler"
import { getServerEnv } from "@/lib/env"
import { usersService } from "@/services/users.service"

/**
 * Clerk webhook receiver (public route; authenticity comes from the Svix signature).
 *
 * - 2xx: processed or intentionally ignored. Clerk will not retry.
 * - 400: signature or payload invalid. Retrying cannot help.
 * - 5xx: transient failure (e.g. database down). Clerk retries with backoff.
 */
export const POST = createApiHandler(
  async ({ request, logger }) => {
    // Bind the Svix message ID to the request logger so every line for this
    // delivery (including the wrapper's failure log) can be correlated.
    const eventId = request.headers.get("svix-id") ?? undefined
    logger.setBindings({ webhookEventId: eventId })

    const signingSecret = getServerEnv().CLERK_WEBHOOK_SIGNING_SECRET
    if (!signingSecret) {
      throw new ApiError("SERVICE_UNAVAILABLE", {
        logContext: { reason: "CLERK_WEBHOOK_SIGNING_SECRET is not configured" },
      })
    }

    let event
    try {
      event = await verifyWebhook(request, { signingSecret })
    } catch (error) {
      throw new ApiError("BAD_REQUEST", {
        message: "Invalid webhook signature.",
        cause: error,
      })
    }

    const outcome = await usersService.handleClerkWebhookEvent(event)
    logger.info({ webhookType: event.type, outcome }, "clerk webhook processed")

    return { data: { received: true, outcome } }
  },
  { route: "/api/webhooks/clerk" }
)
