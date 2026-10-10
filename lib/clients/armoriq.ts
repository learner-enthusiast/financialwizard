/*
 * Docs used:
 *   https://docs.armoriq.ai/sdk
 *   https://docs.armoriq.ai/sdk/installation
 *   https://docs.armoriq.ai/cookbook
 *
 * Pass-through until ARMORIQ_API_KEY is configured.
 */
import "server-only"

import { getArmoriqEnv } from "@/lib/env"
import { span } from "@/lib/clients/trace"

export type GuardDecision = "allow" | "deny" | "hold"

export async function guard(
  intent: string,
  action: string,
  args: Record<string, unknown>
): Promise<GuardDecision> {
  return span(
    "armoriq.guard",
    async (): Promise<GuardDecision> => {
      const configured = Boolean(getArmoriqEnv().ARMORIQ_API_KEY)
      if (!configured) return "allow"
      // SDK wiring deferred until Flow State week configuration.
      void intent
      void action
      void args
      return "allow"
    },
    { "armoriq.configured": configuredAttr(getArmoriqEnv().ARMORIQ_API_KEY) },
    "GUARDRAIL"
  )
}

function configuredAttr(key: string | undefined): boolean {
  return Boolean(key)
}
