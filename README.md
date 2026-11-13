# gsc-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for the **Google Search Console API**, served over Streamable HTTP with bearer-token auth. It is built for a remote AI agent (such as a Grok bot) that reads data about your websites.

- Covers every read method of the Search Console API: sites, sitemaps, Search Analytics and URL Inspection.
- Read-only by design. It requests only the `webmasters.readonly` OAuth scope, so Google rejects writes even if the server attempted one.
- Paces requests to stay inside Google's published quotas. It caches results, retries transient errors with backoff, and pauses a property's Search Analytics for 15 minutes after a quota error.

## Tools

| Tool | Google method | What it returns |
|---|---|---|
| `list_sites` | sites.list | Every property the service account can read, with its permission level |
| `get_site` | sites.get | One property |
| `list_sitemaps` | sitemaps.list | Submitted sitemaps (or one index's children): status, errors, warnings, URL counts |
| `get_sitemap` | sitemaps.get | One sitemap |
| `search_analytics_query` | searchanalytics.query | Clicks, impressions, CTR and position, with all dimensions, filters, search types, aggregation types and data states. `fetchAll` pages automatically |
| `inspect_url` | urlInspection.index.inspect | Google's indexed view of one URL |
| `batch_inspect_urls` | urlInspection.index.inspect | Up to 25 URLs, with a compact summary of each. Stops after 90 seconds and marks the rest as skipped |
| `get_site_overview` | (composite) | Permission level, sitemap health, and totals for the last N days vs. the N days before. A failing part is reported in its own section |
| `get_quota_status` | (local) | Inspections left today per property, per-minute usage, cooldowns, reset time |

Left out on purpose: the write methods (`sites.add/delete`, `sitemaps.submit/delete`) and the Mobile-Friendly Test, which Google retired in December 2023.

## Quotas

Google's published limits ([source](https://developers.google.com/webmaster-tools/limits)) are listed below. By default the server enforces 80% of each (`QUOTA_SAFETY_FACTOR=0.8`):

| API | Google limit | Enforced at 0.8 |
|---|---|---|
| Search Analytics | 1,200 QPM per site and per user | 960/min |
| URL Inspection | 600 QPM and **2,000 QPD** per site | 480/min, 1,600/day |
| Sites, sitemaps | 20 QPS and 200 QPM per user | 16/s, 160/min |

- **Waiting:** if a per-minute window or every concurrency slot is full, the call waits up to `MAX_QUEUE_WAIT_MS` in total for a free slot. After that it fails with `LOCAL_RATE_LIMIT` and `retryAfterSeconds`.
- **Daily counters:** these reset at midnight Pacific Time, like Google's. They are saved in `/data` (`quota-state.json`), so a restart doesn't reset them.
- **Load quota:** Search Analytics also has a load quota with no published numbers. Grouping by query and/or page, and long date ranges, use the most of it. Google returns the same error for every exceeded quota, and the server's own pacing already keeps under the per-minute limits, so any Search Analytics quota error is treated as load quota: no retries, and that property's queries pause for 15 minutes, as Google recommends. If errors continue with no successful call in between, the pause steps up to 1 hour and then lasts until midnight Pacific, since Google says repeated errors mean the long-term (daily) quota is used up. A successful call or a new Pacific day starts again at 15 minutes. Quota errors on three properties within 10 minutes also pause Search Analytics for every property for 5 minutes, in case the load quota applies to the whole account. Pauses are saved in `/data` like the daily counters, so a restart doesn't end them early.
- **URL Inspection quota errors:** the server stays under the per-minute limit, so a quota error from Google usually means the property's 2,000 daily inspections are used up, possibly by other tools. Inspections for that property pause the same way: 15 minutes with no retries, then 1 hour, then until midnight Pacific.
- **Result size:** `fetchAll` stops at 5,000 rows unless `maxRows` asks for more (up to `GSC_MAX_ROWS_PER_CALL`), so results fit in the bot's context.
- **Caching:** results are cached to avoid repeating the same queries. Lifetimes:
  - final analytics data: 6 h;
  - fresh analytics data: 5 min;
  - sites and sitemaps: 15 min;
  - URL inspections: 1 h.

  Pass `bypassCache: true` to force a fresh fetch.

## Setup

### 1. Google Cloud and Search Console

1. In a Google Cloud project, enable the **Google Search Console API** (APIs & Services → Library).
2. Create a **service account** (IAM & Admin → Service Accounts). It needs no Cloud roles.
3. Open the service account, go to Keys, choose Add key → JSON, and download the file.
4. In [Search Console](https://search.google.com/search-console), open each property and go to **Settings → Users and permissions → Add user**. Enter the service account's email (`…@….iam.gserviceaccount.com`) and choose **Restricted**. That is enough for every tool, including URL inspection.

### 2. Configure

```bash
cp .env.example .env
openssl rand -hex 32            # paste the output into MCP_AUTH_TOKEN in .env
mkdir -p secrets
cp ~/Downloads/your-key.json secrets/gsc-sa.json
sudo chown 1000:1000 secrets/gsc-sa.json && chmod 400 secrets/gsc-sa.json   # the container runs as uid 1000
```

Optional settings are documented in [`.env.example`](.env.example):
- `GSC_ALLOWED_SITES` limits the bot to the properties you list.
- `ALLOWED_HOSTS` turns on Host header checks.
- `MCP_PATH` moves the MCP endpoint from `/mcp` to another path, e.g. `/gsc-mcp`.

Never commit the key or `.env`: both are in `.gitignore`.

### 3. Run on the VPS

```bash
docker compose up -d --build
curl http://127.0.0.1:3000/healthz      # {"status":"ok"}
docker compose logs -f                  # structured JSON logs
```

The port is bound to `127.0.0.1` only. Put a TLS reverse proxy in front of it. With Caddy:

```caddyfile
gsc-mcp.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1   # stream SSE responses immediately
    }
}
```

With nginx, set `proxy_buffering off;`, `proxy_read_timeout 120s;` and `proxy_set_header Host $host;` for the MCP location (the last one matters if you use `ALLOWED_HOSTS`). A 25-URL batch inspection can take a while; it stops itself after 90 seconds (under Cloudflare's 100-second limit for proxied requests) and marks the rest as skipped.

### Alternative: deploy with Dokku

On a server running [Dokku](https://dokku.com), the app builds from the `Dockerfile`. Replace `gsc-mcp.example.com` with your domain:

```bash
S=/var/lib/dokku/data/storage/gsc-mcp
dokku apps:create gsc-mcp
mkdir -p $S/data $S/secrets && chown 1000:1000 $S/data && chown root:1000 $S/secrets && chmod 750 $S/secrets
# copy the key to $S/secrets/gsc-sa.json, then: chown root:1000 $S/secrets/gsc-sa.json && chmod 640 $S/secrets/gsc-sa.json
dokku storage:mount gsc-mcp $S/data:/data
dokku storage:mount gsc-mcp $S/secrets:/run/secrets:ro
dokku config:set --no-restart gsc-mcp MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gsc-sa.json ALLOWED_HOSTS=gsc-mcp.example.com MCP_PATH=/mcp
dokku domains:set gsc-mcp gsc-mcp.example.com
dokku ports:set gsc-mcp http:80:3000
dokku nginx:set gsc-mcp proxy-read-timeout 120s
dokku nginx:set gsc-mcp proxy-buffering off
dokku resource:limit --memory 256m gsc-mcp
dokku builder:set gsc-mcp selected dockerfile
dokku git:sync --build gsc-mcp https://github.com/MichalBrylKaminski/gsc-mcp.git master
```

To update, push to GitHub and run the last command again. Read the token with `dokku config:get gsc-mcp MCP_AUTH_TOKEN`. If the server isn't public, terminate TLS in front of nginx, for example with Cloudflare.

### 4. Connect a client

Every client needs the same two things:

- MCP endpoint: `https://gsc-mcp.example.com/mcp`, or your `MCP_PATH` (Streamable HTTP, stateless, POST only).
- Auth header: `Authorization: Bearer <MCP_AUTH_TOKEN>`.

The examples below read the token from an environment variable, `GSC_MCP_TOKEN`, so it doesn't end up in a config file you might share. Set it in your shell profile:

```bash
export GSC_MCP_TOKEN='<MCP_AUTH_TOKEN>'
```

After connecting, ask something like "list my Search Console sites" to check that the tools work.

#### Grok (xAI API)

In xAI's API, add it as a remote MCP tool. Check [xAI's Remote MCP docs](https://docs.x.ai/) for the exact field names. With the Python SDK it looks roughly like this:

```python
from xai_sdk import Client
from xai_sdk.tools import mcp

client = Client()
chat = client.chat.create(
    model="<grok-model>",
    tools=[mcp(server_url="https://gsc-mcp.example.com/mcp", authorization="Bearer <MCP_AUTH_TOKEN>")],
)
chat.append(...)  # e.g. "List my sites and show last week's top 10 queries for each"
```

#### Claude Code

Add the server for all your projects (`--scope user`):

```bash
claude mcp add --transport http --scope user gsc https://gsc-mcp.example.com/mcp \
  --header "Authorization: Bearer $GSC_MCP_TOKEN"
claude mcp list          # gsc should show as connected
```

The shell expands `$GSC_MCP_TOKEN` when you run the command, so the token is saved in plain text in `~/.claude.json`.

To share the server with a project's team instead, commit a `.mcp.json` at the repo root. Claude Code expands `${GSC_MCP_TOKEN}` when it starts, so each person keeps the token in their own environment:

```json
{
  "mcpServers": {
    "gsc": {
      "type": "http",
      "url": "https://gsc-mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${GSC_MCP_TOKEN}" }
    }
  }
}
```

Inside a session, `/mcp` shows the server's status and its tools.

#### Claude Desktop

Claude Desktop's custom connectors (Settings → Connectors) support only OAuth, not a fixed bearer token. Instead, connect through the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge, which needs Node.js. Open Settings → Developer → Edit Config and add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gsc": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://gsc-mcp.example.com/mcp",
        "--header", "Authorization:${GSC_AUTH_HEADER}"
      ],
      "env": { "GSC_AUTH_HEADER": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

Keep `Authorization:${GSC_AUTH_HEADER}` without a space. `mcp-remote` substitutes the value from `env`, and this form avoids a known problem with spaces in arguments. Restart Claude Desktop afterwards.

#### Codex

Codex CLI connects to Streamable HTTP servers natively and reads the token from an environment variable:

```bash
codex mcp add gsc --url https://gsc-mcp.example.com/mcp --bearer-token-env-var GSC_MCP_TOKEN
codex mcp list
```

Or add the same thing to `~/.codex/config.toml`:

```toml
[mcp_servers.gsc]
url = "https://gsc-mcp.example.com/mcp"
bearer_token_env_var = "GSC_MCP_TOKEN"
```

`GSC_MCP_TOKEN` must be set in the environment Codex starts from. In the Codex TUI, `/mcp` lists the connected servers and their tools.

## Development

```bash
npm install
npm test                # unit + HTTP tests (no Google access needed)
npm run typecheck
GOOGLE_APPLICATION_CREDENTIALS=./secrets/gsc-sa.json MCP_AUTH_TOKEN=$(openssl rand -hex 32) DATA_DIR=./data npm run dev
npx @modelcontextprotocol/inspector   # connect to http://localhost:3000/mcp with the Authorization header
```

Layout:

```
src/
  config.ts           env validation
  http.ts             express app, bearer auth, MCP endpoint (MCP_PATH), /healthz
  errors.ts           Google error classification and tool error messages
  cache.ts            LRU + TTL response cache
  server.ts           MCP server and tool registration
  google/client.ts    Search Console client (read-only scope)
  google/service.ts   rate limiting, retries, circuit breaker, cache and allowlist around every call
  limits/quotas.ts    Google's published limits (update here if they change)
  limits/limiter.ts   sliding windows, PT-midnight daily counters, concurrency cap
  limits/retry.ts     backoff and circuit breaker
  tools/*.ts          one file per tool group
```

## Troubleshooting

| Error code | Meaning |
|---|---|
| `PERMISSION_DENIED` | The service account isn't a user on that property. The message names the email to add. |
| `NOT_FOUND` | Wrong `siteUrl`. URL-prefix properties need the exact URL with a trailing slash; domain properties are `sc-domain:example.com`. Call `list_sites`. |
| `AUTH_ERROR` | The key is invalid, deleted or disabled, or the Search Console API isn't enabled in the key's Google Cloud project. The message says which. |
| `LOCAL_RATE_LIMIT` | The server is pacing calls. Retry after `retryAfterSeconds`. |
| `LOAD_QUOTA_COOLDOWN` | Google reported a Search Analytics quota as exceeded (most likely the load quota). Wait 15 minutes, or use shorter ranges and fewer query/page dimensions. |
| `GOOGLE_QUOTA_EXCEEDED` | Google reported a quota as used up. URL Inspection pauses for 15 minutes, then 1 hour, then until `resetAt` (midnight Pacific) if it keeps happening. |
| `CANCELLED` | The client disconnected, so the server stopped the work. |
| `DAILY_QUOTA_EXHAUSTED` | The property's URL inspections for today are used up. They reset at `resetAt` (midnight Pacific). |

## License

[MIT](LICENSE)
