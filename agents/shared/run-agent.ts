import "server-only"

import type { z } from "zod"

import type { AgentContext, AgentStatus } from "@/agents/types"
import { scanForAdvice } from "@/agents/shared/advice"
import { span, type SetSpanAttributes } from "@/lib/clients/trace"

export type AgentName = "resolver" | "router" | "planner" | "extractor" | "verifier" | "reporter"

type FailStatus = Exclude<AgentStatus, "ok">

type RunAgentOptions<I extends z.ZodType, O extends z.ZodType> = {
  name: AgentName
  promptVersion: string
  ctx: AgentContext
  input: unknown
  inputSchema: I
  outputSchema: O
  /** Builds a valid output for a failure. Must not depend on parsed input. */
  fail: (status: FailStatus, reason: string) => z.input<O>
  body: (input: z.infer<I>, setAttributes: SetSpanAttributes) => Promise<z.input<O>>
}

function collectSourceIds(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => collectSourceIds(item, into))
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "sourceIds" && Array.isArray(item)) item.forEach((id) => typeof id === "string" && into.add(id))
      else collectSourceIds(item, into)
    }
  }
  return into
}

function countClaims(value: unknown): number {
  const claims = (value as { claims?: unknown })?.claims
  return Array.isArray(claims) ? claims.length : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Standard agent envelope:
 *   span → validate input → body → validate output → advice scan → counts.
 * Never throws: any failure becomes a schema-valid output with status
 * "failed" (or "unverifiable" when the body reports it) and a short reason.
 */
export async function runAgent<I extends z.ZodType, O extends z.ZodType>(
  opts: RunAgentOptions<I, O>
): Promise<z.infer<O>> {
  const { name, promptVersion, ctx, outputSchema } = opts
  const failed = (status: FailStatus, reason: string): z.infer<O> =>
    outputSchema.parse(opts.fail(status, reason.slice(0, 300)))

  try {
    return await span(
      `agent.${name}`,
      async (setAttributes) => {
        const parsedInput = opts.inputSchema.safeParse(opts.input)
        if (!parsedInput.success) {
          const paths = parsedInput.error.issues.map((issue) => issue.path.join(".") || "(root)")
          setAttributes({ "agent.error": "invalid input", "agent.status": "failed" })
          return failed("failed", `invalid input: ${[...new Set(paths)].join(", ")}`)
        }

        let output: z.infer<O>
        try {
          output = outputSchema.parse(await opts.body(parsedInput.data, setAttributes))
        } catch (error) {
          setAttributes({ "agent.error": errorMessage(error).slice(0, 500), "agent.status": "failed" })
          return failed("failed", `${name} failed: ${errorMessage(error)}`)
        }

        const advice = scanForAdvice(output)
        if (advice.length > 0) {
          setAttributes({ "agent.error": `advice language: ${advice.slice(0, 5).join("; ")}`, "agent.status": "failed" })
          return failed("failed", "output contained investment-advice language and was withheld")
        }

        setAttributes({
          "agent.status": String((output as { status?: unknown }).status ?? "ok"),
          "agent.claims": countClaims(output),
          "agent.sources": collectSourceIds(output, new Set()).size,
        })
        return output
      },
      {
        "agent.name": name,
        "agent.prompt_version": promptVersion,
        "research.version": ctx.version,
        "research.run_id": ctx.runId,
      },
      "AGENT"
    )
  } catch (error) {
    // Tracing itself failed; still honour the never-throw contract.
    return failed("failed", `${name} failed: ${errorMessage(error)}`)
  }
}
