/**
 * Reads Step rows and writes docs/economics/inputs.json for cfo.ai scenarios.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { config } from "dotenv"

config({ path: [".env.local", ".env"], quiet: true })

import { getPrisma } from "@/lib/db/prisma"

async function main() {
  const steps = await getPrisma().step.findMany({ orderBy: { createdAt: "desc" }, take: 10_000 })
  const byRun = new Map<string, typeof steps>()
  for (const step of steps) {
    const list = byRun.get(step.runId) ?? []
    list.push(step)
    byRun.set(step.runId, list)
  }

  const runs = [...byRun.values()]
  const count = runs.length || 1

  const avg = (tool: string) => {
    const perRun = runs.map((rs) => rs.filter((s) => s.tool === tool && s.status === "ok").length)
    return perRun.reduce((a, b) => a + b, 0) / count
  }

  const payload = {
    avgLlmCostPerRunUsd: null as number | null,
    avgCrustdataCreditsPerRun: avg("crustdata"),
    avgSerpCallsPerRun: avg("serp"),
    avgFirecrawlPagesPerRun: avg("firecrawl"),
    hostingPerMonthUsd: null as number | null,
    sampleRuns: count,
    generatedAt: new Date().toISOString(),
  }

  const outDir = path.join(process.cwd(), "docs", "economics")
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, "inputs.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  console.log("Wrote docs/economics/inputs.json")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
