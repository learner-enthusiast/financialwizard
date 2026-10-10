import "server-only"

import { z } from "zod"

import type { AgentContext } from "@/agents/types"
import type { AgentName } from "@/agents/shared/run-agent"
import { callTool } from "@/lib/clients/callTool"
import { complete, extract } from "@/lib/clients/llm"
import { span } from "@/lib/clients/trace"

type LlmCallMeta = {
  agent: AgentName
  promptVersion: string
  /** Short purpose label used in span names and cache keys, e.g. "candidates". */
  label: string
  system: string
  maxTokens?: number
}

/**
 * Structured LLM call: span → callTool("llm") → llm.extract → re-validate.
 * Returns null when the model call fails or the output does not match `schema`.
 */
export async function llmExtract<S extends z.ZodType>(
  ctx: AgentContext,
  meta: LlmCallMeta & { text: string; schema: S }
): Promise<z.infer<S> | null> {
  return span(
    `llm.${meta.agent}.${meta.label}`,
    async (setAttributes) => {
      const result = await callTool(
        ctx,
        "llm",
        {
          op: "extract",
          agent: meta.agent,
          promptVersion: meta.promptVersion,
          label: meta.label,
          system: meta.system,
          text: meta.text,
          schema: z.toJSONSchema(meta.schema),
        },
        (signal) => extract(meta.text, meta.schema, { system: meta.system, maxTokens: meta.maxTokens, signal })
      )
      // Cached values come back from JSON storage; validate again.
      const parsed = result === null ? null : meta.schema.safeParse(result)
      setAttributes({ "llm.ok": Boolean(parsed?.success) })
      return parsed?.success ? parsed.data : null
    },
    { "agent.name": meta.agent, "agent.prompt_version": meta.promptVersion, "research.version": ctx.version },
    "LLM"
  )
}

/** Free-text LLM call with the same tracing and caching. Returns null on failure. */
export async function llmComplete(
  ctx: AgentContext,
  meta: LlmCallMeta & { prompt: string; maxTokens: number }
): Promise<string | null> {
  return span(
    `llm.${meta.agent}.${meta.label}`,
    async () =>
      callTool(
        ctx,
        "llm",
        { op: "complete", agent: meta.agent, promptVersion: meta.promptVersion, label: meta.label, system: meta.system, prompt: meta.prompt },
        (signal) => complete({ system: meta.system, prompt: meta.prompt, maxTokens: meta.maxTokens, signal })
      ),
    { "agent.name": meta.agent, "agent.prompt_version": meta.promptVersion, "research.version": ctx.version },
    "LLM"
  )
}
