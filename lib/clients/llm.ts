/*
 * Docs used:
 *   https://platform.claude.com/docs/en/cli-sdks-libraries/overview
 *   https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock
 *   https://platform.claude.com/docs/en/build-with-claude/claude-on-amazon-bedrock-legacy
 *   https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 *   https://github.com/openai/openai-node
 *   https://platform.openai.com/docs/guides/structured-outputs
 */
import "server-only"

import Anthropic from "@anthropic-ai/sdk"
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk"
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"
import OpenAI from "openai"
import { zodTextFormat } from "openai/helpers/zod"
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages"
import type { z } from "zod"

import { getLlmEnv } from "@/lib/env"
import { wrapAnthropic, wrapOpenAI } from "@/lib/clients/trace"

const BEDROCK_EXTRACT_TOOL = "emit_structured_extract"

export type CompleteInput = {
  system?: string
  prompt: string
  maxTokens: number
  signal?: AbortSignal
}

let anthropicClient: Anthropic | undefined
let openaiClient: OpenAI | undefined
let bedrockClient: AnthropicBedrockMantle | undefined

function getAnthropic(): Anthropic {
  anthropicClient ??= wrapAnthropic(
    new Anthropic({ apiKey: getLlmEnv().ANTHROPIC_API_KEY })
  )
  return anthropicClient
}

function getOpenAI(): OpenAI {
  openaiClient ??= wrapOpenAI(
    new OpenAI({ apiKey: getLlmEnv().OPENAI_API_KEY })
  )
  return openaiClient
}

function bedrockMantle(): AnthropicBedrockMantle {
  if (!bedrockClient) {
    const env = getLlmEnv()
    bedrockClient = new AnthropicBedrockMantle({ awsRegion: env.AWS_REGION! })
  }
  return bedrockClient
}

function modelId(): string {
  const env = getLlmEnv()
  if (env.LLM_PROVIDER === "anthropic") return env.ANTHROPIC_MODEL!
  if (env.LLM_PROVIDER === "openai") return env.OPENAI_MODEL!
  return env.BEDROCK_MODEL_ID!
}

export async function complete(input: CompleteInput): Promise<string> {
  const { system, prompt, maxTokens, signal } = input
  const provider = getLlmEnv().LLM_PROVIDER

  if (provider === "anthropic") {
    const message = await getAnthropic().messages.create(
      {
        model: modelId(),
        max_tokens: maxTokens,
        system: system ?? undefined,
        messages: [{ role: "user", content: prompt }],
      },
      { signal }
    )
    const block = message.content.find((b) => b.type === "text")
    return block?.type === "text" ? block.text : ""
  }

  if (provider === "openai") {
    const response = await getOpenAI().responses.create(
      {
        model: modelId(),
        max_output_tokens: maxTokens,
        input: [
          ...(system ? [{ role: "developer" as const, content: system }] : []),
          { role: "user", content: prompt },
        ],
      },
      { signal }
    )
    return response.output_text ?? ""
  }

  const message = await bedrockMantle().messages.create(
    {
      model: modelId(),
      max_tokens: maxTokens,
      system: system ?? undefined,
      messages: [{ role: "user", content: prompt }],
    },
    { signal }
  )
  const block = message.content.find((b) => b.type === "text")
  return block?.type === "text" ? block.text : ""
}

function zodIssuesMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
}

function toolInputSchema<T extends z.ZodType>(schema: T): Tool.InputSchema {
  return schema.toJSONSchema({ target: "draft-2020-12" }) as Tool.InputSchema
}

/**
 * Bedrock Mantle docs list structured outputs as unsupported; try `messages.parse`
 * for newer model/API support, then fall back to forced tool use (supported on Bedrock).
 */
async function bedrockExtract<T extends z.ZodType>(
  text: string,
  schema: T,
  signal?: AbortSignal
): Promise<z.infer<T> | null> {
  const basePrompt = `Extract structured data from the following text:\n\n${text}`

  try {
    const message = await bedrockMantle().messages.parse(
      {
        model: modelId(),
        max_tokens: 4096,
        messages: [{ role: "user", content: basePrompt }],
        output_config: { format: zodOutputFormat(schema) },
      },
      { signal }
    )
    if (message.parsed_output) {
      const validated = schema.safeParse(message.parsed_output)
      if (validated.success) return validated.data
    }
  } catch {
    // Structured outputs unavailable for this model/endpoint — use tool-use fallback.
  }

  const attempt = async (
    prompt: string
  ): Promise<{ ok: true; data: z.infer<T> } | { ok: false; reason: string }> => {
    const message = await bedrockMantle().messages.create(
      {
        model: modelId(),
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        tools: [
          {
            name: BEDROCK_EXTRACT_TOOL,
            description: "Return the extracted structured payload.",
            input_schema: toolInputSchema(schema),
          },
        ],
        tool_choice: {
          type: "tool",
          name: BEDROCK_EXTRACT_TOOL,
          disable_parallel_tool_use: true,
        },
      },
      { signal }
    )

    const toolUse = message.content.find(
      (block) => block.type === "tool_use" && block.name === BEDROCK_EXTRACT_TOOL
    )
    if (!toolUse || toolUse.type !== "tool_use") {
      return { ok: false, reason: "model did not return required tool_use block" }
    }

    const validated = schema.safeParse(toolUse.input)
    if (validated.success) return { ok: true, data: validated.data }
    return { ok: false, reason: zodIssuesMessage(validated.error) }
  }

  const first = await attempt(basePrompt)
  if (first.ok) return first.data

  const retryPrompt = `${basePrompt}\n\nYour previous ${BEDROCK_EXTRACT_TOOL} input failed validation: ${first.reason}\nFix every issue and call ${BEDROCK_EXTRACT_TOOL} again.`
  const second = await attempt(retryPrompt)
  if (second.ok) return second.data

  return null
}

export async function extract<T extends z.ZodType>(
  text: string,
  schema: T,
  signal?: AbortSignal
): Promise<z.infer<T> | null> {
  const provider = getLlmEnv().LLM_PROVIDER
  const prompt = `Extract structured data from the following text:\n\n${text}`

  if (provider === "anthropic") {
    const message = await getAnthropic().messages.parse(
      {
        model: modelId(),
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: zodOutputFormat(schema) },
      },
      { signal }
    )
    if (!message.parsed_output) throw new Error("LLM structured output missing")
    return message.parsed_output as z.infer<T>
  }

  if (provider === "openai") {
    const response = await getOpenAI().responses.parse(
      {
        model: modelId(),
        input: prompt,
        text: { format: zodTextFormat(schema, "extract") },
      },
      { signal }
    )
    if (!response.output_parsed) throw new Error("LLM structured output missing")
    return response.output_parsed as z.infer<T>
  }

  return bedrockExtract(text, schema, signal)
}
