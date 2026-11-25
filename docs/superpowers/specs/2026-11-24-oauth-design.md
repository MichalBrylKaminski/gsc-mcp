# OAuth sign-in for MCP clients

Date: 2026-11-24
Status: design approved in conversation, awaiting spec review
Builds on: branch `auth-multi-token` (fixed tokens with optional expiry, `TokenRegistry`, per-request audit log)

## Goal

A client (Grok Bot for weekly checks, Claude Code while writing articles) gets its credentials on its first connection and renews them by itself, with no tokens copied by hand. A leaked credential must never be usable to obtain new credentials.

## Decisions

| Topic | Decision |
|---|---|
| Approach | Standard MCP authorization (OAuth 2.1) **alongside** the existing fixed tokens (`MCP_AUTH_TOKEN`/`MCP_AUTH_TOKENS`), which keep working unchanged. |
| Who approves a new client | The owner signs in with Google; only verified emails on `MCP_OAUTH_ALLOWED_EMAILS` are accepted, followed by a consent click. |
| Sign-in lifetime | Fixed from approval: expires at 00:00 UTC on (approval day + `MCP_AUTH_TOKEN_TTL_DAYS`), the same calculation as `issueToken`. Refreshing never extends it. |
| Managing access | A "Connected clients" web page behind the same Google sign-in, with Revoke and Revoke all. |

Why this answers the leak question: issuing anything requires a Google sign-in by an allowed account (protected by the owner's Google 2FA) plus a consent click. Nothing stored by a client or on the server can be traded for a new sign-in. A leaked access token lives at most 1 hour; a leaked refresh token is single-use, and its reuse revokes the whole grant (after a 60-second grace period for the client's own retries).

## Architecture

All pieces live in the existing app, which owns the whole `saturn.brylex-it.dev` domain (no nginx changes needed).

- **SDK OAuth router** (`mcpAuthRouter` from `@modelcontextprotocol/sdk/server/auth/router.js`), mounted at the app root:
  - `/.well-known/oauth-protected-resource/gsc-mcp` (resource metadata; path follows `MCP_PATH`)
  - `/.well-known/oauth-authorization-server`
  - `/register` (dynamic client registration), `/authorize`, `/token`, `/revoke`
  - The SDK handles PKCE checks, `redirect_uri` validation, client authentication and rate limiting.
- **Provider** (`src/oauth/`): implements `OAuthServerProvider` and `OAuthRegisteredClientsStore`; holds clients, grants, codes and tokens; runs the Google step.
- **Google sign-in**: Google OAuth with scopes `openid email`, redirect URI `<MCP_PUBLIC_URL>/oauth/google/callback`. The ID token is verified with `google-auth-library` (`OAuth2Client.verifyIdToken`, already a dependency); `email_verified` must be true and the email must be on the allowlist. No Google access or refresh tokens are kept.
- **Pages**: consent page and `/clients` page, server-rendered HTML with inline CSS, no front-end framework.
- **Bearer check** (`bearerAuth` in `src/http.ts`): tries the fixed tokens (`TokenRegistry`) first, then OAuth access tokens. Both produce a `ClientInfo` used by the audit log, `req.auth` and `tokenNotice`.

## First-connection flow

1. The client POSTs to `/gsc-mcp` without a token and receives 401 with `WWW-Authenticate: Bearer resource_metadata="<metadata URL>"`.
2. The client reads the metadata and registers at `/register`. Registration alone grants nothing.
3. The client opens the browser at `/authorize` (with PKCE). The server stores the request (5 min, in memory) and redirects to Google with its own `state` and nonce. At most 20 requests per client and 1,000 in all are kept; past either cap the oldest is dropped, so a flood of `/authorize` calls can't refuse the owner's.
4. Google returns to `/oauth/google/callback`. The server verifies the ID token, the nonce and the allowlist. A nonce mismatch sends `error=access_denied` to the client's `redirect_uri`.
5. **Consent page**: "Allow **<client name>** to read your Search Console data? Codes will be sent to **<redirect host>**. Access ends on **<date>**." Approve / Deny.
   - Needed even after Google sign-in: anyone can register a client with their own `redirect_uri` and send the owner an `/authorize` link; if the owner is already signed in to Google, Google may not prompt, and the code would go to the attacker. The page shows which client asks and where the code goes, and needs a click.
   - The Approve form carries a single-use CSRF token bound to the pending request.
6. On Approve, the server redirects to the client's `redirect_uri` with a single-use code (5 min, in memory). The client exchanges it at `/token` with the same `redirect_uri` (which may be left out only when the client registered just that one URI), and only then is the grant created, so an approval whose code is never exchanged leaves nothing behind.

Deny or a disallowed email: redirect to the client's `redirect_uri` with `error=access_denied`; log a warning with the email.

## Grants and tokens

**Grant** (one per approval): `id`, `clientId`, `clientName`, `email`, `redirectHost`, `createdAt`, `expiresAt`, `lastUsedAt`.

- Always expires, regardless of `MCP_AUTH_AUTO_EXPIRE` (which keeps applying to fixed tokens only).
- In its last `EXPIRY_WARNING_DAYS` (14) days, tool results carry a `tokenNotice` asking the owner to sign in again; the "expires soon" log warning follows the existing once-per-UTC-day rule.

**Access token**: 32 random bytes, valid 1 hour, never past the grant's expiry.

**Refresh token**: 32 random bytes, single-use. Each refresh returns a new access token and a new refresh token; the old refresh token stops working, while earlier access tokens keep working until their own expiry (at most 10 live per grant), so a refresh never cuts off a request already holding one. A refresh token that was already used revokes the whole grant and logs an error, with one exception: the refresh token exchanged last, presented again by the same client within 60 seconds of that exchange, gets another pair each time, and logs a warning. This covers a lost response and parallel requests that all refresh with the same token (the MCP SDK client doesn't serialize refreshes). The refresh tokens from those pairs live side by side (at most 10) until one of them is exchanged, which retires the rest: so if a thief took one, whichever of the thief and the real client refreshes second presents a used token, and the grant is revoked. New tokens are written to disk before the client receives them (a failed write is logged; the tokens then work until a restart). A refresh on an expired grant returns `invalid_grant`.

**Revocation**: `/revoke` (from clients) and the `/clients` page both delete the grant's tokens at once; the next request gets 401.

**Lookup**: tokens are looked up by their SHA-256 hash (a map keyed by the hash of a 256-bit random value, so lookup timing reveals nothing useful).

## Storage

`DATA_DIR/oauth-state.json`, written with the existing atomic `JsonFile`:

- registered clients, grants, and token hashes only (never a token itself), plus the hashes of the grant's last 100 used refresh tokens, for reuse detection;
- written on every change to clients, grants or tokens; before tokens are handed out the provider waits for the write, so a crash can't forget a refresh token the client already holds (a failed write is logged, not thrown: the tokens work until a restart);
- entries that fail validation on load are dropped with a warning; client secrets are never stored, because every registered client is made public (`token_endpoint_auth_method: none`, PKCE required), and only the client fields the server uses are kept; `lastUsedAt` is updated in memory and flushed at most once a minute and at shutdown;
- registration clean-up: a client with no grant is deleted 24 hours after registering; at most 100 registered clients: when full, the oldest client without a grant is forgotten (registration grants nothing, so this is safe), except one registered in the last 15 minutes, which may be mid-sign-in; a registration is refused only when every client has a grant or is that recent;
- expired grants are deleted on startup and once a day (the store runs this itself), and are hidden from the Connected clients page as soon as they expire;
- a file that isn't valid JSON or isn't in the expected format is renamed to `oauth-state.json.corrupt-<timestamp>`, an error is logged, and the server starts with no grants (every client signs in again); a file that exists but can't be read at all (e.g. permissions) stops the server from starting, because starting empty would overwrite it.

Authorization requests, codes, Google `state`/nonce and `/clients` sessions are in memory only; a restart during a sign-in means retrying it.

## Log labels

The client name comes from registration and is chosen by the client: it is cut to 64 printable characters. Logs and `ClientInfo.name` use `oauth:<name>#<first 6 chars of grant id>`, so two clients called "Grok" can be told apart. Tokens never appear in logs.

## Connected clients page

- `GET /clients`: if there is no session, redirects through Google sign-in (same allowlist), then sets a session cookie (`__Host-gsc_mcp_session`): random id, kept in server memory, 12 hours, `HttpOnly; Secure; SameSite=Lax; Path=/`.
- The sign-in for this page keeps nothing on the server: `GET /clients` puts its Google `state` and nonce in a 5-minute `__Host-gsc_mcp_signin` cookie (`HttpOnly; Secure; SameSite=Lax`), and the callback accepts the state only from the browser holding that cookie. Anonymous `GET /clients` requests therefore can't push out the owner's sign-in or fill the queue client sign-ins use.
- Callbacks that would call Google (a valid pending `state`, or a matching sign-in cookie) are limited to 30 per 10 minutes per client address; junk callbacks are rejected before Google and do not count. Past the limit a client sign-in gets `error=temporarily_unavailable` at its `redirect_uri`; the clients page gets a 429 page. The sign-in cookie also carries its issue time, so the 5 minutes are checked on the server.
- Lists each grant: client name, redirect host, approved on, expires on, last used. Lists fixed tokens read-only: name and expiry (or "never").
- `POST /clients/revoke` (one grant) and `POST /clients/revoke-all`, each with the session's CSRF token. `POST /clients/sign-out` ends the session and shows a "Signed out" page (redirecting to `/clients` would start a new sign-in).

## Configuration

OAuth is on only when all four are set; a partial set is a startup error; none set means today's behaviour exactly (no OAuth routes mounted).

| Variable | Meaning |
|---|---|
| `MCP_PUBLIC_URL` | Public base URL and issuer, e.g. `https://saturn.brylex-it.dev`. https required (except localhost, per the SDK); no path, query or fragment. |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth client ID. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret (Dokku config only). |
| `MCP_OAUTH_ALLOWED_EMAILS` | Comma-separated emails allowed to sign in, compared case-insensitively. |

Other changes:

- With OAuth on, `MCP_AUTH_TOKEN`/`MCP_AUTH_TOKENS` become optional.
- `TRUST_PROXY` (default unset): number of proxies in front of the app, passed to Express `trust proxy`, so the SDK's rate limits see real client IPs. `2` on the VPS (Cloudflare and nginx), which also needs Dokku's nginx to append to `X-Forwarded-For` (`x-forwarded-for-value '$proxy_add_x_forwarded_for'`) instead of replacing it. If `ALLOWED_HOSTS` is set, it must include the host of `MCP_PUBLIC_URL` (checked at startup). With OAuth on and `TRUST_PROXY` unset, log a warning at startup.
- `MCP_AUTH_TOKEN_TTL_DAYS` now also sets the OAuth grant lifetime.

## Google setup (once)

- In project `gsc-mcp-514313`, create an OAuth client of type "Web application" with redirect URI `https://saturn.brylex-it.dev/oauth/google/callback`.
- The consent screen can stay in Testing mode with the owner's email as a test user; no Google verification is needed. Testing mode's 7-day limit applies to Google refresh tokens, which this server never keeps.

## Errors

| Situation | Result |
|---|---|
| Disallowed email, or the owner cancels at Google or denies consent | `error=access_denied` to the client's `redirect_uri`; warning logged |
| Expired or revoked access token | 401, `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"` |
| Grant expired | refresh returns `invalid_grant`; the client starts a new sign-in |
| Refresh token reused | grant revoked, `invalid_grant`, error logged (a repeat of the last refresh within 60 s gets another pair instead) |
| Pending sign-in lost (timeout or restart) | error page asking to start the connection again |
| Google's code exchange fails (Google down, or a made-up code) | client sign-in: `error=temporarily_unavailable` to the client's `redirect_uri`; clients page: a 502 page |
| Too many callbacks from one address | client sign-in: `error=temporarily_unavailable` to the client's `redirect_uri`; clients page: a 429 page |
| `oauth-state.json` not valid JSON or wrong format | renamed aside, error logged, start empty |
| `oauth-state.json` exists but can't be read | the server refuses to start |

## Testing

Google is replaced by an injected fake ID-token verifier.

- **Store**: expiry dates (00:00 UTC boundary, TTL), access tokens capped at grant expiry, refresh rotation, reuse revoking the grant, the 60-second grace period (parallel refreshes all get working pairs; a thief holding a sibling is caught), client pruning and cap, expired-grant clean-up, corrupt-file handling, and that only hashes reach the file.
- **HTTP end to end**: register → authorize → Google callback → consent → `/token` → MCP tool call → refresh → reuse → 401. Rejections: missing or wrong CSRF token, disallowed email, unverified email, mismatched `redirect_uri`, wrong PKCE verifier. Fixed tokens still accepted alongside OAuth.
- **`/clients`**: sign-in redirect, listing, revoke, revoke all, CSRF rejection, session expiry.
- **Config**: all-or-nothing rule for the four variables, fixed tokens optional with OAuth on, `MCP_PUBLIC_URL` validation.
- **Manual**: Claude Code signing in against a local run (localhost issuer).

## Rollout

1. Commit `auth-multi-token` (the base), then branch `oauth` from it.
2. Create the Google OAuth client; set the Dokku config (`MCP_PUBLIC_URL`, the Google client ID and secret, `MCP_OAUTH_ALLOWED_EMAILS`, `TRUST_PROXY=2`); deploy.
3. Connect Claude Code through OAuth, then Grok Bot.
4. Keep Grok Bot's fixed token until a weekly run succeeds on OAuth, then remove it.
5. Update README, CLAUDE.md, `.env.example`, and `/root/MCP_documentation.md` on the VPS.

## Out of scope

Per-client limits to some properties, more than one user, a CLI for managing grants, keeping Google tokens, sliding sign-in lifetimes.
