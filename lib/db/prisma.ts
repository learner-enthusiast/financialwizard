import "server-only"

import { PrismaPg } from "@prisma/adapter-pg"

import { PrismaClient } from "@/generated/prisma/client"
import { getServerEnv } from "@/lib/env"

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getServerEnv().DATABASE_URL })
  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient }

/**
 * Lazily created singleton. Reused across HMR reloads in development so the
 * connection pool is not exhausted. Only repositories should import this.
 */
export function getPrisma(): PrismaClient {
  if (!globalForPrisma.__prisma) {
    globalForPrisma.__prisma = createPrismaClient()
  }
  return globalForPrisma.__prisma
}

export type { PrismaClient }
