import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiClient, type ApiClientError } from "@/lib/api/api-client"
import { queryKeys } from "@/hooks/api/query-keys"
import type { UpdateCurrentUserInput, UserDto } from "@/schemas/user.schema"

/*
 * Convention: one file per feature resource. Each file exports
 *  - use<Resource>()        queries (pass `signal` through for cancellation)
 *  - use<Verb><Resource>()  mutations that update/invalidate the cache on success
 */

export function useCurrentUser() {
  return useQuery<UserDto, ApiClientError>({
    queryKey: queryKeys.users.me(),
    queryFn: ({ signal }) => apiClient.get<UserDto>("/api/me", { signal }),
  })
}

export function useUpdateCurrentUser() {
  const queryClient = useQueryClient()

  return useMutation<UserDto, ApiClientError, UpdateCurrentUserInput>({
    mutationFn: (input) => apiClient.patch<UserDto>("/api/me", input),
    // Returning the promise keeps the mutation pending until fresh data is loaded.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  })
}
