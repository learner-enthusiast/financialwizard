import { CircleAlertIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { getErrorMessage, isApiClientError } from "@/lib/api/api-client"

/** Standard inline error state for failed queries. Shows the request ID for support. */
export function QueryErrorAlert({
  error,
  title = "Something went wrong",
  onRetry,
}: {
  error: unknown
  title?: string
  onRetry?: () => void
}) {
  const requestId = isApiClientError(error) ? error.requestId : null

  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{getErrorMessage(error)}</p>
        {requestId ? <p className="text-xs opacity-70">Reference: {requestId}</p> : null}
        {onRetry ? (
          <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
