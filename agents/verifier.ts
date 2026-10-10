import type { AgentContext, AgentResult } from "@/agents/types"

export type VerifierInput = unknown
export type VerifierOutput = unknown

export async function runVerifier(
  ctx: AgentContext,
  input: VerifierInput
): Promise<AgentResult<VerifierOutput>> {
  void ctx
  void input
  throw new Error("not implemented")
}
