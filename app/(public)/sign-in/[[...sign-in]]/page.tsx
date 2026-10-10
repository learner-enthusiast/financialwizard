import { Suspense } from "react"
import { SignIn } from "@clerk/nextjs"

import { Spinner } from "@/components/ui/spinner"

export default function SignInPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      {/* Clerk reads the URL at runtime; Suspense lets the rest of the page prerender. */}
      <Suspense fallback={<Spinner />}>
        <SignIn />
      </Suspense>
    </main>
  )
}
