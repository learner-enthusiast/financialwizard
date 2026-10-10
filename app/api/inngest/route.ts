/*
 * Docs used:
 *   https://www.inngest.com/docs/getting-started/nextjs-quick-start
 */
import { serve } from "inngest/next"

import { inngest } from "@/inngest/client"
import { functions } from "@/inngest/index"

export const { GET, POST, PUT } = serve({ client: inngest, functions })
