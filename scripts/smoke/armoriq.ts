import { preview } from "./_setup"

import { guard } from "@/lib/clients/armoriq"

async function main() {
  const decision = await guard("smoke", "ping", { ts: Date.now() })
  preview("armoriq.guard", decision)
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
