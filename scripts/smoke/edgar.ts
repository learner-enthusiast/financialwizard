import { preview } from "./_setup"
import { smokeRun } from "./_run"

import { callTool } from "@/lib/clients/callTool"
import { companyFacts, tickerToCik } from "@/lib/clients/edgar"

async function main() {
  if (!process.env.SEC_USER_AGENT) throw new Error("SEC_USER_AGENT is not set (.env.local)")

  const run = smokeRun()
  const cik = await callTool(run, "edgar", { ticker: "AAPL" }, (signal) => tickerToCik("AAPL", signal))
  preview("AAPL CIK", cik)

  if (cik) {
    const facts = await callTool(run, "edgar", { companyFacts: cik }, (signal) => companyFacts(cik, signal))
    preview(
      "companyFacts keys",
      facts && typeof facts === "object" ? Object.keys(facts as object).slice(0, 8) : facts
    )
  }
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
