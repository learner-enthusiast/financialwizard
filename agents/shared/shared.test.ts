import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { scanForAdvice } from "@/agents/shared/advice"
import { normalizeLegalName, textNamesEntity } from "@/agents/shared/names"
import { runAgent } from "@/agents/shared/run-agent"
import { classifyUrl } from "@/agents/shared/sources"
import { testContext, traceMock } from "@/tests/support/agent-mocks"

const trace = vi.hoisted(() => ({ value: undefined as ReturnType<typeof traceMock> | undefined }))
vi.mock("@/lib/clients/trace", async () => {
  const { traceMock } = await import("@/tests/support/agent-mocks")
  trace.value = traceMock()
  return trace.value
})
vi.mock("@/repositories/sources.repository", () => ({ sourcesRepository: {} }))

const out = z.object({
  status: z.enum(["ok", "unverifiable", "failed"]),
  reason: z.string().optional(),
  note: z.string().optional(),
  claims: z.array(z.object({ sourceIds: z.array(z.string()) })).default([]),
})

function agent(body: () => Promise<z.input<typeof out>>, input: unknown = { q: "x" }) {
  return runAgent({
    name: "router",
    promptVersion: "test@1",
    ctx: testContext(),
    input,
    inputSchema: z.object({ q: z.string() }),
    outputSchema: out,
    fail: (status, reason) => ({ status, reason }),
    body: async () => body(),
  })
}

describe("runAgent", () => {
  it("returns validated output and records counts on the span", async () => {
    const result = await agent(async () => ({ status: "ok", claims: [{ sourceIds: ["a", "b"] }, { sourceIds: ["a"] }] }))
    expect(result.status).toBe("ok")
    const span = trace.value!.__spans.at(-1)!
    expect(span.name).toBe("agent.router")
    expect(span.attrs).toMatchObject({
      "agent.name": "router",
      "agent.prompt_version": "test@1",
      "research.version": "v2",
      "agent.claims": 2,
      "agent.sources": 2,
    })
  })

  it("never throws: body errors become status failed with a reason", async () => {
    const result = await agent(async () => {
      throw new Error("boom")
    })
    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("boom") })
    expect(trace.value!.__spans.at(-1)!.attrs["agent.error"]).toBe("boom")
  })

  it("rejects invalid input without running the body", async () => {
    const body = vi.fn()
    const result = await agent(body, { nope: 1 })
    expect(result).toMatchObject({ status: "failed", reason: "invalid input: q" })
    expect(body).not.toHaveBeenCalled()
  })

  it("withholds outputs that contain advice language", async () => {
    const result = await agent(async () => ({ status: "ok", note: "This looks like a strong buy." }))
    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("advice") })
  })

  it("rejects outputs that fail the output schema", async () => {
    const result = await agent(async () => ({ status: "maybe" }) as never)
    expect(result.status).toBe("failed")
  })
})

describe("advice scan", () => {
  it.each(["buy", "Sell", "strong", "guaranteed", "price target", "we recommend"])("flags %s", (word) => {
    expect(scanForAdvice({ summary: `Note: ${word} now` })).not.toEqual([])
  })

  it("ignores names, urls and verbatim quotes", () => {
    expect(scanForAdvice({ legalName: "Strong Foods Ltd", url: "https://buy.example", quote: "strong demand" })).toEqual([])
  })
})

describe("names and sources", () => {
  it("normalizes legal names", () => {
    expect(normalizeLegalName("Jio Platforms Limited")).toBe("jio platforms")
    expect(normalizeLegalName("Apple Inc.")).toBe("apple")
  })

  it("detects whether text names the entity", () => {
    expect(textNamesEntity("Jio Platforms Ltd reported…", { legalName: "Jio Platforms Limited" })).toBe(true)
    expect(textNamesEntity("Jio Financial Services…", { legalName: "Jio Platforms Limited" })).toBe(false)
    expect(textNamesEntity("see jio.com", { legalName: "X", domain: "jio.com" })).toBe(true)
  })

  it("classifies regulator, company and news URLs", () => {
    expect(classifyUrl("https://www.sebi.gov.in/filings/x.pdf")).toBe("REGULATOR")
    expect(classifyUrl("https://investors.jio.com/press", "jio.com")).toBe("COMPANY")
    expect(classifyUrl("https://economictimes.com/a")).toBe("NEWS")
  })
})
