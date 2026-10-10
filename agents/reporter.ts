import type { AgentContext, AgentResult } from "@/agents/types"

export type ReporterInput = unknown
export type ReporterOutput = unknown

export async function runReporter(
  ctx: AgentContext,
  input: ReporterInput
): Promise<AgentResult<ReporterOutput>> {
  void ctx
  void input
  throw new Error("not implemented")
}
