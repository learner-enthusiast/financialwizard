# External clients

One folder per external service (`lib/clients/<service>/`). Clients are the only
code allowed to talk to third-party APIs or SDKs.

Implemented today:

- `clerk/` — Clerk Backend API lookups used by the auth fallback.
- `trace.ts` — neatlogs init, spans, run tags.
- `callTool.ts` — cache, budget, retries, Step log.
- `llm.ts`, `serp.ts`, `firecrawl.ts`, `edgar.ts`, `pdf.ts`, `inFilings.ts`, `wikidata.ts`, `armoriq.ts` (pass-through until configured).
- `crustdata.ts` — blocked until `docs/vendor/crustdata.md` is pasted.

Orchestration: `lib/jobs/`, `inngest/`, `workflows/`. Smoke scripts: `scripts/smoke/`.

## Conventions

```text
lib/clients/<service>/
├── <service>.client.ts   # "server-only"; lazily creates the SDK/fetch client
└── types.ts              # provider-neutral input/output types used by services
```

1. Start every client module with `import "server-only"`.
2. Read credentials through `getServerEnv()` (`lib/env.ts`). Add new
   variables to its Zod schema as **optional**, and throw
   `ApiError("SERVICE_UNAVAILABLE")` when a required key is missing at call time.
3. Create SDK instances lazily (first call), not at import time, so builds and
   tests never need credentials.
4. Validate critical responses with Zod before returning them.
5. Return provider-neutral types (see `clerk/types.ts`), not raw SDK objects.
6. Translate failures: provider 404 → `null` where it makes sense; rate limits
   → `ApiError("RATE_LIMITED")`; everything else →
   `ApiError("UPSTREAM_ERROR", { cause, logContext: { upstream: "<service>" } })`.
   Never put provider error messages in `message`.
7. Accept an `AbortSignal` for long-running calls and set explicit timeouts.
8. Services call clients; route handlers and repositories never do.
9. In tests, mock the client module (`vi.mock("@/lib/clients/<service>/...")`).
