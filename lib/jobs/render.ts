/*
 * Docs used:
 *   https://render.com/docs/workflows-sdk-typescript
 *   https://render.com/docs/workflows-running
 */
import "server-only"

import { Render } from "@renderinc/sdk"

import { getJobsEnv } from "@/lib/env"

let render: Render | undefined

function getRender(): Render {
  render ??= new Render({ token: getJobsEnv().RENDER_API_KEY })
  return render
}

export async function enqueueRunRender(runId: string): Promise<void> {
  const workflow = getJobsEnv().RENDER_WORKFLOW_NAME!
  await getRender().workflows.startTask(`${workflow}/runResearch`, [runId])
}
