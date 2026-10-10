import type { CallToolRun } from "@/lib/clients/callTool"
import { DEFAULT_TOOL_BUDGETS } from "@/lib/clients/callTool"

export function smokeRun(runId = "smoke-run"): CallToolRun {
  return {
    runId,
    budget: { ...DEFAULT_TOOL_BUDGETS },
    trace: { version: "v1", country: "US", instrument: "smoke" },
  }
}
