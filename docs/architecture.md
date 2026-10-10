# Application architecture

Next.js 16 (App Router, Cache Components) · Clerk (Core 3) · Prisma 7 + PostgreSQL/pgvector · Zod 4 · Pino · TanStack Query 5 · Vitest.

## Layers

| Layer | Location | Responsibility | Must not |
|---|---|---|---|
| Proxy | `proxy.ts`, `middleware/` | Clerk session handling, page protection, request IDs | Query the DB; enforce API auth on its own |
| Route handlers | `app/api/**/route.ts` | Parse/validate input, `requireAuth()`, call services, return data | Contain Prisma queries or business rules |
| API plumbing | `lib/api/` | Response envelope, `ApiError`, error-code registry, `createApiHandler`, typed client | Contain domain logic |
| Auth | `lib/auth/authorization.ts` | `requireAuth`, `requireRole`, `assertOwnership` | Trust client-supplied IDs |
| Services | `services/` | Business rules and orchestration; throw `ApiError` | Import Prisma or `NextResponse` |
| Repositories | `repositories/` | All Prisma queries, transactions, raw SQL | Format HTTP responses; contain workflows |
| External clients | `lib/clients/` | Third-party APIs (see `lib/clients/README.md`) | Be called from handlers or repositories |
| Schemas | `schemas/` | Zod schemas + inferred types, shared client/server | Import server-only code |
| Hooks | `hooks/api/` | TanStack Query hooks + query keys | Import Prisma, repositories, or server-only modules |
| Providers | `providers/` | Client providers (Query, toasts) | Hold server state |

Everything server-side starts with `import "server-only"`, so an accidental
client import fails the build instead of leaking code.

## Request lifecycle

1. **`proxy.ts`** runs `clerkMiddleware(proxyHandler)`:
   - non-public **pages** → `auth.protect()` (redirects signed-out users to `/sign-in`);
   - **API routes are never redirected** (handlers return JSON 401 instead);
   - assigns a fresh `x-request-id` (client values are overwritten) on the forwarded request and the response.
2. **`createApiHandler`** reuses that ID (or generates one), opens an
   AsyncLocalStorage request context with a child logger, runs the handler,
   and turns the result or the thrown error into the response envelope.
3. **One log line per request**: `info` for success and for ordinary 4xx;
   `warn` for 403/409/429; `error` with stack trace for 5xx. Every line
   carries `requestId`, `method`, `route`, `status`, `durationMs`, `errorCode`.

## Response contract

```json
{ "success": true, "data": { "id": "…" }, "meta": { "requestId": "req_…" } }
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Please correct the highlighted fields.",
    "details": { "baseCurrency": ["Enter a 3-letter ISO currency code, e.g. USD."] }
  },
  "meta": { "requestId": "req_…" }
}
```

| Code | HTTP | Source |
|---|---|---|
| `BAD_REQUEST` | 400 | malformed JSON, non-JSON body, invalid webhook signature |
| `UNAUTHORIZED` | 401 | no Clerk session |
| `FORBIDDEN` | 403 | role check failed, deactivated account |
| `NOT_FOUND` | 404 | missing record (Prisma P2025), or a resource owned by someone else |
| `CONFLICT` | 409 | unique constraint (Prisma P2002) |
| `VALIDATION_ERROR` | 422 | any `ZodError` |
| `RATE_LIMITED` | 429 | reserved |
| `INTERNAL_ERROR` / `DATABASE_ERROR` | 500 | unexpected exceptions / other Prisma errors |
| `UPSTREAM_ERROR` | 502 | external client failures |
| `SERVICE_UNAVAILABLE` | 503 | DB unreachable (P1001 etc.), missing webhook secret |

Rules: unexpected errors always return the generic message. Raw exception
messages, SQL, and stacks only reach server logs (`cause`). Unsupported HTTP
methods get Next.js's built-in `405` with an `Allow` header.

## Authentication & authorization

- **Pages**: public = `/`, `/sign-in*`, `/sign-up*` (`middleware/auth.middleware.ts`).
  Everything else redirects to sign-in from the proxy.
- **APIs**: each protected handler calls `requireAuth()`, which reads the
  verified Clerk session (`auth()`), then resolves the internal `User` by
  `clerkId`. `/api/health` and `/api/webhooks/clerk` are intentionally public.
- `requireRole(user, "ADMIN")` → 403. `assertOwnership(user, resource)` → 404
  (does not reveal that the resource exists).
- Foreign keys always use `User.id` (internal UUID), never `clerkId`.

## Clerk → database user sync

- **Normal path**: Clerk webhook → `POST /api/webhooks/clerk` → `verifyWebhook`
  (Svix signature, `CLERK_WEBHOOK_SIGNING_SECRET`) → `usersService.handleClerkWebhookEvent`.
- `user.created` / `user.updated` → upsert keyed by unique `clerkId`, writing
  **only** email (verified only), first/last name, image URL, `clerkUpdatedAt`.
  `role`, `baseCurrency`, and future app data are never touched.
- **Idempotency/order**: replays produce the same row; events older than the
  stored `clerkUpdatedAt` are skipped; soft-deleted users are never resurrected.
- `user.deleted` → **soft delete**: `deletedAt` set, PII cleared, row and all
  related data retained. If the user was never synced, a tombstone row is
  written so a late `user.created` cannot recreate them.
- **Responses**: 200 processed/ignored · 400 bad signature (no retry) · 5xx on
  DB/unexpected failures so Clerk retries. Logs include `webhookEventId` (`svix-id`).
- **Fallback**: `requireAuth()` → local lookup → if missing, fetch from the
  Clerk Backend API once and upsert. Concurrent creates are safe: the unique
  index rejects the duplicate and the repository re-reads the winner.
- Event-level dedup (a `processed_webhook_events` table keyed by `svix-id`)
  is **not** added: upserts are already idempotent. Add it only if non-idempotent
  side effects (emails, billing) are attached to webhook events later.

## Data access, PostgreSQL and pgvector

- Prisma 7: `prisma.config.ts` (loads `.env.local` then `.env`), generator
  `prisma-client` → `generated/prisma` (git-ignored; created by `postinstall`).
  The runtime client uses `@prisma/adapter-pg` and is a lazy singleton
  (`lib/db/prisma.ts`). Only repositories import it.
- Transactions: use `getPrisma().$transaction(async (tx) => …)` inside a
  repository method and pass `tx` to helpers explicitly.
- `docker-compose.yml` uses `pgvector/pgvector:pg17`. `docker/postgres/init/01-extensions.sql`
  runs `CREATE EXTENSION IF NOT EXISTS vector` on first volume init only.
- `GET /api/health` reports `vectorExtension: true|false` from `pg_extension`.
- **Vector columns**: Prisma has no native `vector` type. Declare them as
  `embedding Unsupported("vector(1536)")?`, create the extension + HNSW index
  in a reviewed migration, and read/write them only via `$queryRaw` /
  `$executeRaw` inside a repository, e.g.
  ```ts
  await getPrisma().$queryRaw`
    SELECT id, 1 - (embedding <=> ${vectorLiteral}::vector) AS score
    FROM documents WHERE user_id = ${userId}::uuid
    ORDER BY embedding <=> ${vectorLiteral}::vector LIMIT ${limit}`
  ```
  Always scope vector searches by the owning user ID.

## Client data fetching

- `lib/api/api-client.ts`: typed `fetch` wrapper. Throws `ApiClientError` with
  `kind` (`http` | `network` | `parse` | `invalid_response` | `aborted`),
  `status`, `code`, `requestId`, `details`. Checks status explicitly.
- `lib/api/query-client.ts`: `staleTime` 30s, no refetch on focus. Retries up to 2×
  with backoff only for network errors, 429 and 5xx. Never for other 4xx or
  malformed responses. Mutations never retry.
- Hooks: `hooks/api/query-keys.ts` (hierarchical factory) + one file per
  resource (`use-current-user.ts`). Queries forward `signal`; mutations
  invalidate their feature namespace on success.
- UI: `components/shared/query-error-alert.tsx` for inline errors (shows request
  ID), `FieldError` for 422 details, `toast.add()` for success notices.

## Testing

`pnpm test` (Vitest, Node environment). DB, Clerk, and webhooks are mocked; no
credentials needed. `server-only` is aliased to a stub in `vitest.config.mts`.
