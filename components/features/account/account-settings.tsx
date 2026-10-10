"use client"

import { useState, type FormEvent } from "react"

import { QueryErrorAlert } from "@/components/shared/query-error-alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { useCurrentUser, useUpdateCurrentUser } from "@/hooks/api/use-current-user"
import { updateCurrentUserSchema, type UserDto } from "@/schemas/user.schema"

export function AccountSettings() {
  const { data: user, error, isPending, refetch } = useCurrentUser()

  if (isPending) return <Skeleton className="h-48 w-full" />
  if (error) return <QueryErrorAlert error={error} title="Could not load your account" onRetry={() => refetch()} />

  return <AccountSettingsForm key={user.baseCurrency} user={user} />
}

function AccountSettingsForm({ user }: { user: UserDto }) {
  const updateUser = useUpdateCurrentUser()
  const [baseCurrency, setBaseCurrency] = useState(user.baseCurrency)
  const [clientErrors, setClientErrors] = useState<Record<string, string[]>>({})

  // Server-side field errors (422) take the same shape as client-side ones.
  const fieldErrors = updateUser.error?.details ?? clientErrors
  const currencyErrors = fieldErrors.baseCurrency?.map((message) => ({ message }))
  const formError = updateUser.error && !updateUser.error.details ? updateUser.error : null

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    updateUser.reset()

    const parsed = updateCurrentUserSchema.safeParse({ baseCurrency })
    if (!parsed.success) {
      const errors: Record<string, string[]> = {}
      for (const issue of parsed.error.issues) {
        ;(errors[issue.path.join(".")] ??= []).push(issue.message)
      }
      setClientErrors(errors)
      return
    }

    setClientErrors({})
    updateUser.mutate(parsed.data, {
      onSuccess: () => toast.add({ title: "Preferences saved", type: "success" }),
    })
  }

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Your account"

  return (
    <Card>
      <CardHeader>
        <CardTitle>{displayName}</CardTitle>
        <CardDescription>{user.email ?? "No verified email address"}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {formError ? <QueryErrorAlert error={formError} title="Could not save preferences" /> : null}
          <Field data-invalid={Boolean(currencyErrors?.length)}>
            <FieldLabel htmlFor="baseCurrency">Base currency</FieldLabel>
            <Input
              id="baseCurrency"
              name="baseCurrency"
              value={baseCurrency}
              maxLength={3}
              aria-invalid={Boolean(currencyErrors?.length)}
              onChange={(event) => setBaseCurrency(event.target.value)}
            />
            <FieldDescription>Used for reporting totals, e.g. USD, EUR, INR.</FieldDescription>
            <FieldError errors={currencyErrors} />
          </Field>
          <Button type="submit" disabled={updateUser.isPending} className="self-start">
            {updateUser.isPending ? <Spinner /> : null}
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
