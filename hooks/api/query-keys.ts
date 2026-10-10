/**
 * Query key factory. Every feature adds a namespace here so keys stay
 * hierarchical and invalidation can target a whole feature or one entry:
 *
 *   queryClient.invalidateQueries({ queryKey: queryKeys.users.all })
 */
export const queryKeys = {
  users: {
    all: ["users"] as const,
    me: () => [...queryKeys.users.all, "me"] as const,
  },
} as const
