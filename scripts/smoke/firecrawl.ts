import { preview } from "./_setup"
import { smokeRun } from "./_run"

import { callTool } from "@/lib/clients/callTool"
import { scrapePage } from "@/lib/clients/firecrawl"

async function main() {
  const run = smokeRun()
  const md = await callTool(run, "firecrawl", { url: "https://example.com" }, (signal) =>
    scrapePage("https://example.com", signal)
  )
  preview("firecrawl markdown (trimmed)", md?.slice(0, 500))
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
