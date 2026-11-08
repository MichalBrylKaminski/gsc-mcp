# gsc-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for the **Google Search Console API**, served over Streamable HTTP with bearer-token auth. It is built for a remote AI agent (such as a Grok bot) that reads data about your websites.

- Covers every read method of the Search Console API: sites, sitemaps, Search Analytics and URL Inspection.
- Read-only by design. It requests only the `webmasters.readonly` OAuth scope, so Google rejects writes even if the server attempted one.
- Paces requests to stay inside Google's published quotas. It caches results, retries transient errors with backoff, and backs off for 15 minutes after a Search Analytics load-quota error.

## Tools

| Tool | Google method | What it returns |
|---|---|---|
| `list_sites` | sites.list | Every property the service account can read, with its permission level |
| `get_site` | sites.get | One property |
| `list_sitemaps` | sitemaps.list | Submitted sitemaps (or one index's children): status, errors, warnings, URL counts |
| `get_sitemap` | sitemaps.get | One sitemap |
| `search_analytics_query` | searchanalytics.query | Clicks, impressions, CTR and position, with all dimensions, filters, search types, aggregation types and data states. `fetchAll` pages automatically |
| `inspect_url` | urlInspection.index.inspect | Google's indexed view of one URL |
| `batch_inspect_urls` | urlInspection.index.inspect | Up to 25 URLs, with a compact summary of each |
| `get_site_overview` | (composite) | Permission level, sitemap health, and totals for the last N days vs. the N days before |
| `get_quota_status` | (local) | Inspections left today per property, per-minute usage, cooldowns, reset time |

Left out on purpose: the write methods (`sites.add/delete`, `sitemaps.submit/delete`) and the Mobile-Friendly Test, which Google retired in December 2023.

## Quotas

Google's published limits ([source](https://developers.google.com/webmaster-tools/limits)) are listed below. By default the server enforces 80% of each (`QUOTA_SAFETY_FACTOR=0.8`):

| API | Google limit | Enforced at 0.8 |
|---|---|---|
| Search Analytics | 1,200 QPM per site and per user | 960/min |
| URL Inspection | 600 QPM and **2,000 QPD** per site | 480/min, 1,600/day |
| Sites, sitemaps | 20 QPS and 200 QPM per user | 16/s, 160/min |

- **Waiting:** if a per-minute window is full, the call waits up to `MAX_QUEUE_WAIT_MS` for a free slot. After that it fails with `LOCAL_RATE_LIMIT` and `retryAfterSeconds`.
- **Daily counters:** these reset at midnight Pacific Time, like Google's. They are saved in `/data`, so a restart doesn't reset them.
- **Load quota:** Search Analytics also has a load quota with no published numbers. Grouping by query and/or page, and long date ranges, use the most of it. When Google reports it exceeded, the server stops querying that property for 15 minutes, as Google recommends.
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
4. In [Search Console](https://search.google.com/search-console), open each property and go to **Settings → Users and permissions → Add user**. Enter the service account's email (`…@….iam.gserviceaccount.com`). Restricted permission is enough for reading; use Full if a URL inspection returns a permission error.

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

With nginx, set `proxy_buffering off;` and `proxy_read_timeout 300s;` for the `/mcp` location. A 25-URL batch inspection can take a while.

### 4. Connect the Grok bot

- MCP endpoint: `https://gsc-mcp.example.com/mcp` (Streamable HTTP, stateless, POST only).
- Auth header: `Authorization: Bearer <MCP_AUTH_TOKEN>`.

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
  http.ts             express app, bearer auth, /mcp, /healthz
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
| `AUTH_ERROR` | The key is invalid, deleted or disabled, or the Search Console API isn't enabled in the key's project. |
| `LOCAL_RATE_LIMIT` | The server is pacing calls. Retry after `retryAfterSeconds`. |
| `LOAD_QUOTA_COOLDOWN` | Google's Search Analytics load quota was exceeded. Wait, or use shorter ranges and fewer query/page dimensions. |
| `DAILY_QUOTA_EXHAUSTED` | The property's URL inspections for today are used up. They reset at `resetAt` (midnight Pacific). |
