/* Smoke test: one real span exported to neatlogs. */
import { preview } from "./_setup"

import { flush, initTracing, span } from "@/lib/clients/trace"

async function main() {
  if (!process.env.NEATLOGS_API_KEY) throw new Error("NEATLOGS_API_KEY is not set (.env.local)")
  await initTracing()

  const result = await span(
    "smoke.trace",
    async () => ({ ok: true, at: new Date().toISOString() }),
    { "smoke.client": "trace" },
    "WORKFLOW"
  )

  const flushed = await flush()
  preview("span result", result)
  preview("flushed", flushed)
  console.log("\nCheck the neatlogs dashboard for workflow 'pre-purchase-research', span 'smoke.trace'.")
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
