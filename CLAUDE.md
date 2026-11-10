# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-only MCP server that gives a remote AI agent (the user's Grok bot) access to Google Search Console. It uses Streamable HTTP in stateless mode with bearer-token auth, and authenticates to Google with a service account limited to the `webmasters.readonly` scope. The main job of the codebase is staying inside Google's quotas; see the Quotas section of README.md.

## Commands

```bash
npm test                                  # vitest run (all tests; no Google access needed)
npx vitest run test/service.test.ts       # one file
npx vitest run -t "load quota"            # tests whose name matches
npm run typecheck                         # tsc --noEmit (includes test/)
npm run build                             # tsc -p tsconfig.build.json -> dist/ (src only)
npm run dev                               # tsx watch; needs MCP_AUTH_TOKEN (>=32 chars), GOOGLE_APPLICATION_CREDENTIALS, DATA_DIR
docker compose up -d --build              # local container; key in ./secrets/gsc-sa.json, port bound to 127.0.0.1
```

There is no linter. TypeScript runs in strict mode with `noUncheckedIndexedAccess` and ESM (`NodeNext`), so relative imports use `.js` extensions.

## Architecture

Every Google call goes through `GscService.call()` in `src/google/service.ts`. Tools never call the Google client directly. The pipeline, outermost first:

1. **Cache** (`cache.ts`): LRU+TTL keyed by a stable hash of the method and params, with in-flight dedupe. The service spells out Google's defaults so equivalent requests share an entry. A caller that joins another caller's in-flight call retries with its own call if that call was cancelled or hit *its own* deadline.
2. **Pause check** (`checkBreaker`/`openPause`): runs at the start, again after taking a concurrency slot, and again just before sending.
3. **`withRetry`** (`limits/retry.ts`): exponential backoff with jitter, honouring Retry-After. Quota errors on the `searchAnalytics` and `urlInspection` buckets are deliberately **not** retried.
4. **`Semaphore`** (concurrency cap): hands a freed slot straight to the next waiter.
5. **`RateLimiter.acquire`** (`limits/limiter.ts`): sliding windows plus PT-midnight daily counters. The concurrency wait and the rate-limit wait share one queue deadline per attempt.
6. **`spec.run({signal})`**: the Google request. The signal combines the client's disconnect signal with the caller's deadline. Quota state is recorded **while the semaphore slot is still held**, so queued calls see a new pause before they run.

Quota model (non-obvious; read before changing anything in this area):
- **The same error for every quota.** Google returns one "quota exceeded" error for all quotas, so `classifyGoogleError` (`errors.ts`) can't reliably tell a load-quota error from a rate-limit one. The local limiter already keeps traffic under the per-minute limits. So for `searchAnalytics` and `urlInspection`, any quota error pauses that property instead of retrying.
- **Pause steps.** Pauses last 15 min, then 1 h, then until PT midnight, in `QUOTA_PAUSE_STEPS_MS` (`limits/quotas.ts`). The step goes up only when no request sent after the latest pause has succeeded. It resets on a new PT day.
- **Account-wide pause.** First-step pauses on 3 properties within 10 min also trip a 5-minute pause on Search Analytics for every property.
- **Explicit daily errors.** A daily-quota error from URL Inspection fills that property's day counter to Google's raw 2,000. One from Search Analytics pauses it until PT midnight.
- **Persisted state.** Daily counters (`quota-state.json`) and pauses with their steps (`pause-state.json`) are saved in `DATA_DIR`. `JsonFile` writes them atomically (temp file, fsync, rename). On startup, saved pauses that are malformed or out of range are dropped.
- **Where to change limits.** Google's published numbers live only in `GOOGLE_LIMITS` (`limits/quotas.ts`). `QUOTA_SAFETY_FACTOR` (default 0.8) scales them.

Other cross-cutting rules:
- **Site addresses.** `normalizeSiteUrl` canonicalizes user input and rejects invalid properties before any quota is spent; IDN hosts become punycode. Values that come back *from Google* go through `normalizeKnownSiteUrl`, which never throws.
- **Allowlist.** `GSC_ALLOWED_SITES` is enforced in `GscService.site()`, and `list_sites` filters by it.
- **Errors.** Errors reach the client as `GscToolError` (`code` plus actionable message plus details such as `retryAfterSeconds`/`resetAt`). Tool handlers are wrapped with `handle()` (`tools/common.ts`), which also passes the client's abort `signal` through.
- **HTTP layer.** `http.ts` creates a new `McpServer` and transport for each POST. GET and DELETE return 405. The endpoint path comes from `MCP_PATH` (default `/mcp`), and `/healthz` needs no auth. `ALLOWED_HOSTS` entries are normalized the same way the SDK parses the Host header.
- **Batch time limit.** `batch_inspect_urls` stops after `BATCH_DEADLINE_MS` (90 s), because Cloudflare drops proxied requests after 100 s.

## Tests

`test/helpers.ts` provides:
- `fakeApi()`, an in-memory `GscApi`;
- `makeService()`, with safetyFactor 1, `maxQueueWaitMs` 0 and millisecond retries;
- `googleError(status, reason, message, headers)`, which mimics a gaxios error.

Time-dependent tests use `vi.useFakeTimers({ toFake: ['Date'] })` and `vi.setSystemTime`.

## Deployment

The server is live at `https://saturn.brylex-it.dev/gsc-mcp`, as Dokku app `gsc-mcp` on the Mikrus VPS `igor150`. Reach the VPS through the Mikrus MCP tools (`srv: igor150`). To redeploy, push to GitHub, then run `dokku git:sync --build gsc-mcp https://github.com/MichalBrylKaminski/gsc-mcp.git master` on the server, in the background, because the build outlasts the exec timeout. Server-side paths, mounts and config are recorded in `/root/MCP_documentation.md` on the VPS; update it after changes. The GitHub repo is public, so keys and `.env` must stay out of it.
