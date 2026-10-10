import type { AgentContext, AgentResult } from "@/agents/types"

export type RouterInput = unknown
export type RouterOutput = unknown

export async function runRouter(
  ctx: AgentContext,
  input: RouterInput
): Promise<AgentResult<RouterOutput>> {
  void ctx
  void input
  throw new Error("not implemented")
}
