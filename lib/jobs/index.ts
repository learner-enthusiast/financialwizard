import "server-only"

import { getJobsEnv } from "@/lib/env"
import { enqueueRunInngest } from "@/lib/jobs/inngest"
import { enqueueRunRender } from "@/lib/jobs/render"

export async function enqueueRun(runId: string): Promise<void> {
  const runner = getJobsEnv().JOB_RUNNER
  if (runner === "render") {
    await enqueueRunRender(runId)
    return
  }
  await enqueueRunInngest(runId)
}
