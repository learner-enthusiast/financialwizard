"use client"

import { useState, type ReactNode } from "react"
import { QueryClientProvider } from "@tanstack/react-query"

import { createQueryClient } from "@/lib/api/query-client"

export function QueryProvider({ children }: { children: ReactNode }) {
  // One client per browser session; never shared between server requests.
  const [queryClient] = useState(createQueryClient)
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
