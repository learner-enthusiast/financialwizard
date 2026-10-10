import type { AgentContext, AgentResult } from "@/agents/types"

export type ResolverInput = unknown
export type ResolverOutput = unknown

export async function runResolver(
  ctx: AgentContext,
  input: ResolverInput
): Promise<AgentResult<ResolverOutput>> {
  void ctx
  void input
  throw new Error("not implemented")
}
