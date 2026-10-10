import type { AgentContext, AgentResult } from "@/agents/types"

export type PlannerInput = unknown
export type PlannerOutput = unknown

export async function runPlanner(
  ctx: AgentContext,
  input: PlannerInput
): Promise<AgentResult<PlannerOutput>> {
  void ctx
  void input
  throw new Error("not implemented")
}
