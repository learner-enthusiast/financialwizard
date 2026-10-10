import { preview } from "./_setup"
import { smokeRun } from "./_run"

import { callTool } from "@/lib/clients/callTool"
import { complete } from "@/lib/clients/llm"

async function main() {
  const run = smokeRun()
  const text = await callTool(
    run,
    "llm",
    { prompt: "Reply with exactly: smoke-ok" },
    (signal) => complete({ prompt: "Reply with exactly: smoke-ok", maxTokens: 32, signal })
  )
  preview("llm complete (trimmed)", text?.slice(0, 200))
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
