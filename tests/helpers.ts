import { NextRequest } from "next/server"

import type { ApiResponseBody } from "@/lib/api/api-response"
import type { User } from "@/repositories/users.repository"

export type LogLine = Record<string, unknown> & { level: number; msg: string }

/** Builds a pino logger that records parsed JSON lines; use inside vi.mock factories. */
export async function createCapturingLogger(lines: LogLine[]) {
  const pino = (await import("pino")).default
  return pino(
    { level: "debug" },
    { write: (chunk: string) => void lines.push(JSON.parse(chunk) as LogLine) }
  )
}

export function makeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
) {
  return new NextRequest(new URL(url, "http://localhost"), init)
}

export const noParams = { params: Promise.resolve({}) }

export async function readBody<T = unknown>(response: Response) {
  return (await response.json()) as ApiResponseBody<T>
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "0190a8f0-0000-7000-8000-000000000001",
    clerkId: "user_123",
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    imageUrl: null,
    clerkUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    role: "USER",
    baseCurrency: "USD",
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }
}

export function prismaError(code: string, name = "PrismaClientKnownRequestError") {
  const error = new Error(`Invalid prisma call: SELECT * FROM users WHERE password='hunter2' (${code})`) as Error & {
    code: string
  }
  error.name = name
  error.code = code
  return error
}
