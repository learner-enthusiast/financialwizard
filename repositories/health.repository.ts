import "server-only"

import { getPrisma } from "@/lib/db/prisma"

export const healthRepository = {
  async ping(): Promise<void> {
    await getPrisma().$queryRaw`SELECT 1`
  },

  /** Installed pgvector version, or null when the extension is not enabled. */
  async getVectorExtensionVersion(): Promise<string | null> {
    const rows = await getPrisma().$queryRaw<Array<{ extversion: string }>>`
      SELECT extversion FROM pg_extension WHERE extname = 'vector'
    `
    return rows[0]?.extversion ?? null
  },
}
