import "server-only"

import { healthRepository } from "@/repositories/health.repository"

export type HealthStatus = {
  status: "ok"
  database: "ok"
  vectorExtension: boolean
}

export const healthService = {
  /** Throws (mapped to 503 by the API handler) when the database is unreachable. */
  async check(): Promise<HealthStatus> {
    await healthRepository.ping()
    const vectorVersion = await healthRepository.getVectorExtensionVersion()
    return { status: "ok", database: "ok", vectorExtension: vectorVersion !== null }
  },
}
