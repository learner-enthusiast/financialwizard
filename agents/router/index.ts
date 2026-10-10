import type { AgentContext } from "@/agents/types"

/** Placeholder until implemented; replaced in its own commit. */
export async function runRouter(input: unknown, ctx: AgentContext): Promise<{ status: "failed"; reason: string }> {
  void input
  void ctx
  return { status: "failed", reason: "not implemented" }
}
