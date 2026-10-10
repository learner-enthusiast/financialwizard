import { preview } from "./_setup"
import { smokeRun } from "./_run"

import { callTool } from "@/lib/clients/callTool"
import { search } from "@/lib/clients/serp"

async function main() {
  if (!process.env.SERPAPI_KEY) throw new Error("SERPAPI_KEY is not set (.env.local)")

  const run = smokeRun()
  const result = await callTool(run, "serp", { q: "OpenAI", gl: "us", hl: "en" }, (signal) =>
    search("OpenAI", { gl: "us", hl: "en", signal })
  )

  preview(
    "serp",
    result
      ? {
          organicCount: result.organic.length,
          first: result.organic[0],
          knowledgeGraph: result.knowledgeGraph?.title,
          hasAiOverview: Boolean(result.aiOverview),
        }
      : null
  )
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
