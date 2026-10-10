/*
 * Docs used:
 *   https://www.inngest.com/docs/durable-execution/durable-workflows
 *   https://www.inngest.com/docs/durable-execution/deploying-functions/platforms/vercel
 */
import { runExtractor } from "@/agents/extractor"
import { runPlanner } from "@/agents/planner"
import { runReporter } from "@/agents/reporter"
import { runResolver } from "@/agents/resolver"
import { runRouter } from "@/agents/router"
import { runVerifier } from "@/agents/verifier"
import type { AgentContext } from "@/agents/types"
import { DEFAULT_TOOL_BUDGETS } from "@/lib/clients/callTool"
import { inngest } from "@/inngest/client"

function stubContext(runId: string): AgentContext {
  return {
    runId,
    entity: { name: "stub" },
    budget: { ...DEFAULT_TOOL_BUDGETS },
    trace: { version: "v1", country: "US", instrument: "equity" },
  }
}

export const runResearch = inngest.createFunction(
  { id: "run-research", triggers: [{ event: "research/run.requested" }] },
  async ({ event, step }) => {
    const runId = String((event.data as { runId?: string }).runId ?? "")
    const ctx = stubContext(runId)

    const safe = async (fn: () => Promise<unknown>) => {
      try {
        await fn()
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }

    await step.run("resolver", () => safe(() => runResolver(ctx, {})))
    await step.run("router", () => safe(() => runRouter(ctx, {})))
    await step.run("planner", () => safe(() => runPlanner(ctx, {})))
    await step.run("extractor", () => safe(() => runExtractor(ctx, {})))
    await step.run("verifier", () => safe(() => runVerifier(ctx, {})))
    await step.run("reporter", () => safe(() => runReporter(ctx, {})))

    return { runId, status: "stubbed" }
  }
)
