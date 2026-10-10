"use client"

import type { ReactNode } from "react"

import { Toaster } from "@/components/ui/toast"
import { QueryProvider } from "@/providers/query-provider"

/** Client-side providers composed once for the whole app. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <Toaster>{children}</Toaster>
    </QueryProvider>
  )
}
