import type { AgentContext, AgentResult } from "@/agents/types"

export type ExtractorInput = unknown
export type ExtractorOutput = unknown

export async function runExtractor(
  ctx: AgentContext,
  input: ExtractorInput
): Promise<AgentResult<ExtractorOutput>> {
  void ctx
  void input
  throw new Error("not implemented")
}
