import "server-only"

import pino, { type Logger } from "pino"

import { getLogLevel } from "@/lib/env"

/**
 * Paths redacted from every log line. Prefer logging explicit, sanitized
 * fields over whole objects; this list is a safety net, not a licence.
 */
const REDACT_PATHS = [
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "secret",
  "apiKey",
  "authorization",
  "cookie",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.apiKey",
  "*.authorization",
  "*.cookie",
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  'headers["svix-signature"]',
  "req.headers.authorization",
  "req.headers.cookie",
  "email",
  "*.email",
]

const isDevelopment = process.env.NODE_ENV === "development"

function createLogger(): Logger {
  return pino({
    level: getLogLevel(),
    base: { service: "financialwizard" },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.err },
    // Pretty output locally; structured JSON everywhere else.
    ...(isDevelopment
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,service" },
          },
        }
      : {}),
  })
}

const globalForLogger = globalThis as unknown as { __appLogger?: Logger }

/** Shared server-only logger. Reused across HMR reloads in development. */
export const logger: Logger = globalForLogger.__appLogger ?? createLogger()

if (isDevelopment) globalForLogger.__appLogger = logger
