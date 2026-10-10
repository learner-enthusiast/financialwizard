import { preview } from "./_setup"
import { smokeRun } from "./_run"

import { callTool } from "@/lib/clients/callTool"

async function main() {
  const run = smokeRun()
  const result = await callTool(run, "serp", { ping: true }, async () => ({ pong: true }), {
    skipCache: false,
    cacheTtlMs: 60_000,
  })
  preview("callTool result", result)
  preview("remaining serp budget", run.budget.serp)
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
