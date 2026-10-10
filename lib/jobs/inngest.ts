import "server-only"

import { inngest } from "@/inngest/client"

export async function enqueueRunInngest(runId: string): Promise<void> {
  await inngest.send({ name: "research/run.requested", data: { runId } })
}
