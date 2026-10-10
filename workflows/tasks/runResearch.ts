/*
 * Docs used:
 *   https://render.com/docs/workflows-defining
 *   https://render.com/docs/workflows-sdk-typescript
 */
import { task, type TaskContext } from "@renderinc/sdk/workflows"

import { runExtractor } from "@/agents/extractor"
import { runPlanner } from "@/agents/planner"
import { runReporter } from "@/agents/reporter"
import { runResolver } from "@/agents/resolver"
import { runRouter } from "@/agents/router"
import { runVerifier } from "@/agents/verifier"
import type { AgentContext } from "@/agents/types"
import { DEFAULT_TOOL_BUDGETS } from "@/lib/clients/callTool"

function stubContext(runId: string): AgentContext {
  return {
    runId,
    entity: { name: "stub" },
    budget: { ...DEFAULT_TOOL_BUDGETS },
    trace: { version: "v1", country: "US", instrument: "equity" },
  }
}

async function safeAgent(fn: () => Promise<unknown>): Promise<{ ok: boolean }> {
  try {
    await fn()
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

export const runResolverStage = task({ name: "runResolverStage" }, async (_ctx, runId: string) =>
  safeAgent(() => runResolver(stubContext(runId), {}))
)

export const runRouterStage = task({ name: "runRouterStage" }, async (_ctx, runId: string) =>
  safeAgent(() => runRouter(stubContext(runId), {}))
)

export const runPlannerStage = task({ name: "runPlannerStage" }, async (_ctx, runId: string) =>
  safeAgent(() => runPlanner(stubContext(runId), {}))
)

export const runExtractorStage = task({ name: "runExtractorStage" }, async (_ctx, runId: string) =>
  safeAgent(() => runExtractor(stubContext(runId), {}))
)

export const runVerifierStage = task({ name: "runVerifierStage" }, async (_ctx, runId: string) =>
  safeAgent(() => runVerifier(stubContext(runId), {}))
)

export const runReporterStage = task({ name: "runReporterStage" }, async (_ctx, runId: string) =>
  safeAgent(() => runReporter(stubContext(runId), {}))
)

export const runResearch = task(
  { name: "runResearch" },
  async (ctx: TaskContext, runId: string) => {
    await ctx.run(runResolverStage, runId)
    await ctx.run(runRouterStage, runId)
    await ctx.run(runPlannerStage, runId)
    await ctx.run(runExtractorStage, runId)
    await ctx.run(runVerifierStage, runId)
    await ctx.run(runReporterStage, runId)
    return { runId, status: "stubbed" }
  }
)
