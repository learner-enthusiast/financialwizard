/*
 * Shared setup for smoke scripts. Loads .env.local then .env (same order as
 * Next.js). Run scripts with the react-server condition so `server-only`
 * modules can be imported outside Next.js:
 *   pnpm smoke <client>
 */
import { config } from "dotenv"

config({ path: [".env.local", ".env"], quiet: true })

/** Prints a trimmed JSON preview of a value. */
export function preview(label: string, value: unknown, maxChars = 1500): void {
  const json = JSON.stringify(value, null, 2) ?? String(value)
  console.log(`\n=== ${label} ===`)
  console.log(json.length > maxChars ? `${json.slice(0, maxChars)}\n… (${json.length - maxChars} more chars)` : json)
}
