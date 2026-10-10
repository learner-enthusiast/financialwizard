import { createApiHandler } from "@/lib/api/api-handler"
import { healthService } from "@/services/health.service"

/** GET /api/health — public liveness + database/pgvector readiness probe. */
export const GET = createApiHandler(
  async () => ({ data: await healthService.check() }),
  { route: "/api/health" }
)
