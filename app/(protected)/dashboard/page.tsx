import type { Metadata } from "next"

import { AccountSettings } from "@/components/features/account/account-settings"

export const metadata: Metadata = {
  title: "Dashboard",
}

/** Protected by the proxy (redirects to sign-in); data comes from auth-checked API routes. */
export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-12">
      <h1 className="font-heading text-2xl font-semibold">Dashboard</h1>
      <AccountSettings />
    </main>
  )
}
