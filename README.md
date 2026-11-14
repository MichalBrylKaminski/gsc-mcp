# gsc-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for the **Google Search Console API**. It runs as a small HTTP service, so AI agents and MCP clients anywhere can read Search Console data for your websites: performance (clicks, impressions, CTR, position), indexing status, sitemaps and properties.

- **Covers every read method of the Search Console API:** sites, sitemaps, Search Analytics and URL Inspection, plus a site overview and a period comparison.
- **Read-only by design.** It requests only the `webmasters.readonly` OAuth scope, so Google rejects writes even if the server attempted one.
- **Remote-ready.** It uses Streamable HTTP (stateless), bearer-token auth, an optional Host allowlist and an optional property allowlist.
- **Stays inside Google's quotas.** It caches results, paces requests below Google's published limits, retries transient errors with backoff, and pauses a property after a quota error instead of hammering Google.

## Contents

- [Tools](#tools)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Installation](#installation)
  - [1. Set up Google Cloud and Search Console](#1-set-up-google-cloud-and-search-console)
  - [2. Get the code and configure it](#2-get-the-code-and-configure-it)
  - [3. Run the server](#3-run-the-server)
  - [4. Put it behind HTTPS](#4-put-it-behind-https)
  - [5. Check that it works](#5-check-that-it-works)
- [Connect a client](#connect-a-client)
- [Configuration reference](#configuration-reference)
- [Quotas and caching](#quotas-and-caching)
- [Security](#security)
- [Updating](#updating)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Tools

| Tool | Google method | What it returns |
|---|---|---|
| `list_sites` | sites.list | Every property the service account can read, with its permission level |
| `get_site` | sites.get | One property |
| `list_sitemaps` | sitemaps.list | Submitted sitemaps (or one index's children): status, errors, warnings, URL counts |
| `get_sitemap` | sitemaps.get | One sitemap |
| `search_analytics_query` | searchanalytics.query | Clicks, impressions, CTR and position, with all dimensions, filters (including regex), search types, aggregation types and data states. `fetchAll` pages automatically |
| `compare_periods` | searchanalytics.query | Totals for two date ranges with the change, and optionally rows matched by query, page, country, device or search appearance, sorted by the biggest movers, gains or losses. The baseline defaults to the same number of days just before the current period |
| `inspect_url` | urlInspection.index.inspect | Google's indexed view of one URL |
| `batch_inspect_urls` | urlInspection.index.inspect | Up to 25 URLs, with a compact summary of each. Stops after 90 seconds and marks the rest as skipped |
| `get_site_overview` | (composite) | Permission level, sitemap health, and totals for the last N days vs. the N days before. A failing part is reported in its own section |
| `get_quota_status` | (local) | Inspections left today per property, per-minute usage, pauses, reset time |

Left out on purpose: the write methods (`sites.add/delete`, `sitemaps.submit/delete`) and the Mobile-Friendly Test, which Google retired in December 2023.

## Requirements

- **A Google Cloud project** where you can enable APIs and create a service account key.
- **Owner or full access to the Search Console properties** you want to read, so you can add the service account as a user.
- **Docker with Compose v2** (recommended), or **Node.js 24 or newer** to run it directly.
- **For remote clients:** a domain name and a TLS reverse proxy (Caddy, nginx, Traefik or Cloudflare). Hosted AI services can only reach the server over HTTPS.

## Quick start

For readers who already have a service account key with Search Console access:

```bash
git clone https://github.com/MichalBrylKaminski/gsc-mcp.git && cd gsc-mcp
cp .env.example .env
sed -i "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=$(openssl rand -hex 32)/" .env
mkdir -p secrets && cp /path/to/your-key.json secrets/gsc-sa.json
sudo chown 1000:1000 secrets/gsc-sa.json && chmod 400 secrets/gsc-sa.json
docker compose up -d --build
curl http://127.0.0.1:3000/healthz        # {"status":"ok"}
```

The server now listens on `http://127.0.0.1:3000/mcp`. [Put it behind HTTPS](#4-put-it-behind-https) before connecting a remote client.

## Installation

### 1. Set up Google Cloud and Search Console

The server signs in to Google as a **service account**: a robot Google account with its own email address. You give that email read access in Search Console, the same way you would add a colleague.

**In the Google Cloud console:**

1. Create or pick a project.
2. Enable the **Google Search Console API**: APIs & Services → Library → search for "Google Search Console API" → Enable.
3. Create a service account: IAM & Admin → Service Accounts → Create service account. It needs no Cloud roles; skip the permissions step.
4. Open the service account → Keys → Add key → Create new key → JSON. A `.json` key file downloads. Keep it private: anyone with it can read your Search Console data.

The same steps with the `gcloud` CLI (replace `my-project`):

```bash
gcloud services enable searchconsole.googleapis.com --project=my-project
gcloud iam service-accounts create gsc-mcp --display-name="gsc-mcp" --project=my-project
gcloud iam service-accounts keys create gsc-sa.json \
  --iam-account=gsc-mcp@my-project.iam.gserviceaccount.com
```

**In [Search Console](https://search.google.com/search-console):**

5. Open each property the server should read → Settings → Users and permissions → Add user.
6. Enter the service account's email (`…@….iam.gserviceaccount.com`, shown in the key file as `client_email`) and choose **Restricted**. Restricted is enough for every tool, including URL inspection.

Search Console has two kinds of property, and the server uses Google's exact names for them:

| Property type | Example `siteUrl` | Covers |
|---|---|---|
| Domain | `sc-domain:example.com` | All subdomains and both http and https |
| URL prefix | `https://www.example.com/` | Only URLs under that exact prefix. The trailing slash is required |

The server tidies input (lowercases the host, adds a missing trailing slash, converts international domain names) and rejects malformed values before spending any quota. `list_sites` shows the exact values to use.

### 2. Get the code and configure it

```bash
git clone https://github.com/MichalBrylKaminski/gsc-mcp.git
cd gsc-mcp
cp .env.example .env
```

Generate the bearer token clients will send, and paste it into `MCP_AUTH_TOKEN` in `.env`:

```bash
openssl rand -hex 32
```

Put the key file where Docker Compose expects it. The container runs as uid 1000, so that user must be able to read it:

```bash
mkdir -p secrets
cp ~/Downloads/your-key.json secrets/gsc-sa.json
sudo chown 1000:1000 secrets/gsc-sa.json && chmod 400 secrets/gsc-sa.json
```

A minimal `.env` for Docker Compose:

```dotenv
MCP_AUTH_TOKEN=3f1c...your 64 hex characters...9ab2
# Recommended once you have a domain:
ALLOWED_HOSTS=gsc-mcp.example.com
# Optional: limit the server to some properties
# GSC_ALLOWED_SITES=https://www.example.com/,sc-domain:example.org
```

Every other setting has a working default. See the [configuration reference](#configuration-reference). `.env` and `secrets/` are in `.gitignore`; never commit them.

### 3. Run the server

#### Option A: Docker Compose (recommended)

```bash
docker compose up -d --build
docker compose ps                        # STATUS should become "healthy"
docker compose logs -f                   # structured JSON logs
```

The Compose file:
- publishes the port on `127.0.0.1` only, so nothing outside the machine can reach it until you add a reverse proxy;
- mounts the key as a Docker secret at `/run/secrets/gsc-sa.json`;
- keeps quota counters and pauses in the `gsc-data` volume, so a restart doesn't reset them;
- runs the container read-only, with all capabilities dropped and `no-new-privileges`.

Use `HOST_PORT=3001` in `.env` if port 3000 is taken on the host.

#### Option B: Node.js directly

Requires Node.js 24 or newer.

```bash
npm ci
npm run build
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"     # or set it in your environment
export GOOGLE_APPLICATION_CREDENTIALS="$PWD/secrets/gsc-sa.json"
export DATA_DIR="$PWD/data"                         # must be writable
export HOST=127.0.0.1                               # default 0.0.0.0 listens on every interface
npm start
```

The server doesn't read `.env` by itself; set the variables in your shell or service manager. To keep it running, a systemd unit such as `/etc/systemd/system/gsc-mcp.service` works:

```ini
[Unit]
Description=gsc-mcp
After=network-online.target

[Service]
User=gsc-mcp
WorkingDirectory=/opt/gsc-mcp
EnvironmentFile=/opt/gsc-mcp/.env
Environment=GOOGLE_APPLICATION_CREDENTIALS=/opt/gsc-mcp/secrets/gsc-sa.json
Environment=DATA_DIR=/var/lib/gsc-mcp
Environment=HOST=127.0.0.1
StateDirectory=gsc-mcp
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now gsc-mcp
journalctl -u gsc-mcp -f
```

#### Option C: Dokku

On a server running [Dokku](https://dokku.com), the app builds from the `Dockerfile`. Replace `gsc-mcp.example.com` with your domain:

```bash
S=/var/lib/dokku/data/storage/gsc-mcp
dokku apps:create gsc-mcp
mkdir -p $S/data $S/secrets && chown 1000:1000 $S/data && chown root:1000 $S/secrets && chmod 750 $S/secrets
# copy the key to $S/secrets/gsc-sa.json, then:
chown root:1000 $S/secrets/gsc-sa.json && chmod 640 $S/secrets/gsc-sa.json
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

Read the token later with `dokku config:get gsc-mcp MCP_AUTH_TOKEN`. Add TLS with the [letsencrypt plugin](https://github.com/dokku/dokku-letsencrypt) or terminate it in front of Dokku, for example with Cloudflare.

### 4. Put it behind HTTPS

The server speaks plain HTTP and should sit behind a TLS reverse proxy. Responses can be streamed as server-sent events, so the proxy must not buffer them, and a 25-URL batch inspection can take up to 90 seconds.

**Caddy** (gets a certificate automatically):

```caddyfile
gsc-mcp.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1   # stream SSE responses immediately
    }
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name gsc-mcp.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location /mcp {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;              # needed for ALLOWED_HOSTS
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 120s;
    }
    location = /healthz {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

**Serving under a sub-path.** To publish the endpoint at `https://example.com/gsc-mcp` instead of `/mcp`, set `MCP_PATH=/gsc-mcp` and proxy that path without rewriting it. Health checks stay at `/healthz`.

**Cloudflare.** Proxied requests are cut off after 100 seconds. The server stops batch inspections at 90 seconds for this reason, so no extra setting is needed.

### 5. Check that it works

The health check needs no token:

```bash
curl https://gsc-mcp.example.com/healthz
# {"status":"ok"}
```

List the tools with an MCP request. The server is stateless, so a single POST works without a session:

```bash
export GSC_MCP_TOKEN='<MCP_AUTH_TOKEN>'
curl -s https://gsc-mcp.example.com/mcp \
  -H "Authorization: Bearer $GSC_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Then call a tool to check the Google side. A permission or API problem shows up here, with a message saying what to fix:

```bash
curl -s https://gsc-mcp.example.com/mcp \
  -H "Authorization: Bearer $GSC_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_sites","arguments":{}}}'
```

The reply is a server-sent event (`event: message` followed by a `data: {...}` line). An empty list of sites means the service account hasn't been added to any property yet.

For an interactive check, run the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) with `npx @modelcontextprotocol/inspector`, choose "Streamable HTTP", enter the URL and add the `Authorization: Bearer …` header.

## Connect a client

Every client needs the same two things:

- **MCP endpoint:** `https://gsc-mcp.example.com/mcp`, or your `MCP_PATH`. The transport is Streamable HTTP, stateless, POST only.
- **Auth header:** `Authorization: Bearer <MCP_AUTH_TOKEN>`.

The examples below read the token from an environment variable, `GSC_MCP_TOKEN`, so it doesn't end up in a config file you might share. Set it in your shell profile:

```bash
export GSC_MCP_TOKEN='<MCP_AUTH_TOKEN>'
```

After connecting, ask something like "list my Search Console sites" to check that the tools work.

### Grok (xAI API)

In xAI's API, add it as a remote MCP tool. Check [xAI's Remote MCP docs](https://docs.x.ai/) for the exact field names. With the Python SDK it looks roughly like this:

```python
import os
from xai_sdk import Client
from xai_sdk.chat import user
from xai_sdk.tools import mcp

client = Client()
chat = client.chat.create(
    model="<grok-model>",
    tools=[mcp(
        server_url="https://gsc-mcp.example.com/mcp",
        authorization=f"Bearer {os.environ['GSC_MCP_TOKEN']}",
    )],
)
chat.append(user("List my sites and show last week's top 10 queries for each"))
print(chat.sample().content)
```

### Claude Code

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

### Claude Desktop

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

### Codex

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

### Your own code

Any MCP client library that supports Streamable HTTP works. With the TypeScript SDK:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('https://gsc-mcp.example.com/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.GSC_MCP_TOKEN}` } },
});
const client = new Client({ name: 'my-app', version: '1.0.0' });
await client.connect(transport);

const result = await client.callTool({
  name: 'compare_periods',
  arguments: { siteUrl: 'sc-domain:example.com', currentStart: '2026-10-01', currentEnd: '2026-10-28', dimensions: ['query'] },
});
console.log(result.structuredContent);
```

## Configuration reference

All settings are environment variables. With Docker Compose they go in `.env`.

| Variable | Default | Description |
|---|---|---|
| `MCP_AUTH_TOKEN` | **required** | Bearer token clients must send. At least 32 characters; generate with `openssl rand -hex 32` |
| `GOOGLE_APPLICATION_CREDENTIALS` | **required** | Path to the service account JSON key. Docker Compose sets it to the mounted secret |
| `DATA_DIR` | `./data` (`/data` in Docker) | Writable directory for quota counters and pauses |
| `HOST` | `0.0.0.0` | Interface to listen on |
| `PORT` | `3000` | Port to listen on inside the container or process |
| `HOST_PORT` | `3000` | Docker Compose only: the port published on the host's `127.0.0.1` |
| `MCP_PATH` | `/mcp` | Path of the MCP endpoint, e.g. `/gsc-mcp`. No trailing slash; cannot be `/healthz` |
| `ALLOWED_HOSTS` | (off) | Comma-separated hostnames accepted in the `Host` header, e.g. `gsc-mcp.example.com`. Bare hostnames only: no `https://`, path or port |
| `GSC_ALLOWED_SITES` | (all) | Comma-separated properties clients may read, e.g. `https://www.example.com/,sc-domain:example.org`. `list_sites` shows only these |
| `QUOTA_SAFETY_FACTOR` | `0.8` | Fraction of Google's published limits to use (greater than 0, up to 1) |
| `MAX_QUEUE_WAIT_MS` | `15000` | How long a call may wait for a free rate-limit or concurrency slot before failing with `LOCAL_RATE_LIMIT` |
| `MAX_CONCURRENCY` | `4` | Maximum parallel Google API calls (1–32) |
| `GSC_MAX_ROWS_PER_CALL` | `25000` | Maximum rows one Search Analytics call may return (up to 50,000). `fetchAll` returns 5,000 unless `maxRows` asks for more |
| `CACHE_ENABLED` | `true` | Set to `false` to turn off the response cache |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

The server checks every value at startup and exits with a list of the problems if any is invalid.

## Quotas and caching

Google's published limits ([source](https://developers.google.com/webmaster-tools/limits)) are listed below. By default the server enforces 80% of each (`QUOTA_SAFETY_FACTOR=0.8`):

| API | Google limit | Enforced at 0.8 |
|---|---|---|
| Search Analytics | 1,200 QPM per site and per user | 960/min |
| URL Inspection | 600 QPM and **2,000 QPD** per site | 480/min, 1,600/day |
| Sites, sitemaps | 20 QPS and 200 QPM per user | 16/s, 160/min |

- **Waiting:** if a per-minute window or every concurrency slot is full, the call waits up to `MAX_QUEUE_WAIT_MS` in total for a free slot. After that it fails with `LOCAL_RATE_LIMIT` and `retryAfterSeconds`.
- **Daily counters:** these reset at midnight Pacific Time, like Google's. They are saved in `DATA_DIR` (`quota-state.json`), so a restart doesn't reset them.
- **Load quota:** Search Analytics also has a load quota with no published numbers. Grouping by query and/or page, and long date ranges, use the most of it. Google returns the same error for every exceeded quota, and the server's own pacing already keeps under the per-minute limits, so any Search Analytics quota error is treated as load quota: no retries, and that property's queries pause for 15 minutes, as Google recommends. If errors continue with no successful call in between, the pause steps up to 1 hour and then lasts until midnight Pacific, since Google says repeated errors mean the long-term (daily) quota is used up. A successful call or a new Pacific day starts again at 15 minutes. Quota errors on three properties within 10 minutes also pause Search Analytics for every property for 5 minutes, in case the load quota applies to the whole account. Pauses are saved in `DATA_DIR` (`pause-state.json`), so a restart doesn't end them early.
- **URL Inspection quota errors:** the server stays under the per-minute limit, so a quota error from Google usually means the property's 2,000 daily inspections are used up, possibly by other tools. Inspections for that property pause the same way: 15 minutes with no retries, then 1 hour, then until midnight Pacific.
- **Shared quota:** Google counts quota per property and per Google account, not per server. Other tools using the same service account or the same properties draw from the same budget.
- **Result size:** `fetchAll` stops at 5,000 rows unless `maxRows` asks for more (up to `GSC_MAX_ROWS_PER_CALL`), so results fit in an AI model's context.
- **Caching:** results are cached in memory to avoid repeating the same queries. Lifetimes:
  - final analytics data: 6 h;
  - fresh analytics data: 5 min;
  - sites and sitemaps: 15 min;
  - URL inspections: 1 h.

  Pass `bypassCache: true` to force a fresh fetch. `get_quota_status` shows what is left and any active pauses.

## Security

- **Read-only access to Google.** The server requests only the `webmasters.readonly` scope. Even a compromised server can't change your Search Console settings.
- **Bearer token.** Every MCP request needs the token, compared in constant time. Treat it like a password; to rotate it, change `MCP_AUTH_TOKEN`, restart, and update your clients.
- **Host check.** Set `ALLOWED_HOSTS` to your domain to reject requests addressed to other hostnames (DNS-rebinding protection).
- **Property allowlist.** Set `GSC_ALLOWED_SITES` to limit what clients can read, even if the service account has access to more properties.
- **Key handling.** Keep the key out of the repository (`secrets/` is ignored), readable only by the server's user. If it leaks, delete it in the Cloud console (Service account → Keys) and create a new one.
- **Container hardening.** The Compose file binds to `127.0.0.1`, runs as a non-root user with a read-only filesystem, drops all capabilities and sets `no-new-privileges`.
- **No secrets in logs.** Logs are structured JSON and never include the token or key.

## Updating

```bash
git pull
docker compose up -d --build      # Docker Compose
# or: npm ci && npm run build && sudo systemctl restart gsc-mcp
# or (Dokku): dokku git:sync --build gsc-mcp https://github.com/MichalBrylKaminski/gsc-mcp.git master
```

Quota counters and pauses survive the update, because they live in `DATA_DIR`.

## Development

```bash
npm install
npm test                 # unit and HTTP tests; no Google access needed
npm run typecheck        # tsc --noEmit, including tests
npm run build            # compile src/ to dist/
GOOGLE_APPLICATION_CREDENTIALS=./secrets/gsc-sa.json MCP_AUTH_TOKEN=$(openssl rand -hex 32) DATA_DIR=./data npm run dev
npx @modelcontextprotocol/inspector   # connect to http://localhost:3000/mcp with the Authorization header
```

Layout:

```
src/
  index.ts            startup and shutdown
  config.ts           env validation
  http.ts             express app, bearer auth, MCP endpoint (MCP_PATH), /healthz
  errors.ts           Google error classification and tool error messages
  cache.ts            LRU + TTL response cache
  server.ts           MCP server and tool registration
  google/client.ts    Search Console client (read-only scope)
  google/service.ts   rate limiting, retries, pauses, cache and allowlist around every call
  limits/quotas.ts    Google's published limits (update here if they change)
  limits/limiter.ts   sliding windows, PT-midnight daily counters, concurrency cap
  limits/retry.ts     backoff with jitter
  tools/*.ts          one file per tool group
test/                 vitest tests with an in-memory fake of the Google API
```

Every Google call goes through `GscService.call()` in `src/google/service.ts`; tools never call the Google client directly. Contributions are welcome. Please run `npm test` and `npm run typecheck` before opening a pull request.

## Troubleshooting

Start with the logs: `docker compose logs -f` (or `journalctl -u gsc-mcp -f`). Set `LOG_LEVEL=debug` for more detail.

### The server doesn't start

| Message | Cause and fix |
|---|---|
| `Invalid configuration:` followed by a list | A setting is missing or invalid. Each line names the variable and the problem |
| `MCP_AUTH_TOKEN must be at least 32 characters` | Generate one with `openssl rand -hex 32` |
| `Cannot read service account key at …: EACCES` | The server's user can't read the key. In Docker the container runs as uid 1000: `sudo chown 1000:1000 secrets/gsc-sa.json` |
| `Cannot read service account key at …: ENOENT` | Wrong path. With Docker Compose the key must be at `./secrets/gsc-sa.json` next to `docker-compose.yml` |
| `… is not a service account key` | The file is a different kind of credential, such as an OAuth client secret. Download a JSON key from the service account's Keys tab |
| `DATA_DIR "…" is not writable` | Mount a writable volume there, owned by uid 1000 in Docker |
| `cannot listen` with `EADDRINUSE` | The port is taken. Set `HOST_PORT` (Compose) or `PORT` |
| `docker compose` errors that `secrets/gsc-sa.json` is missing | Copy the key to `./secrets/gsc-sa.json` first |
| Creating a key fails with "Service account key creation is disabled" | Your organization enforces the `iam.disableServiceAccountKeyCreation` policy. Ask an organization admin for an exception for this project, or use a project outside the organization |

### Clients can't connect

| Symptom | Cause and fix |
|---|---|
| `401 Unauthorized` | The `Authorization: Bearer …` header is missing or the token is wrong. Check for stray spaces or quotes in the environment variable |
| `403` `Invalid Host header` / `Invalid Host` | `ALLOWED_HOSTS` doesn't include the hostname the client used, or the proxy doesn't pass the original `Host` header (nginx: `proxy_set_header Host $host;`) |
| `404 Not found` | Wrong path. The endpoint is `MCP_PATH` (default `/mcp`); check that your proxy doesn't strip or rewrite it |
| `405 Method not allowed` | The client sent GET or DELETE. This server is stateless and accepts only POST. Clients that require a long-lived SSE stream (the older HTTP+SSE transport) aren't supported |
| `406 Not Acceptable` | The request lacks `Accept: application/json, text/event-stream`. MCP clients send it automatically; add it to manual `curl` tests |
| `415 Unsupported Media Type` | Send `Content-Type: application/json` |
| Responses hang, arrive all at once, or the client times out | The proxy is buffering server-sent events. Caddy: `flush_interval -1`; nginx: `proxy_buffering off;` |
| `502`/`504` on batch inspections | The proxy timeout is shorter than the call. Set it to at least 120 seconds (nginx `proxy_read_timeout 120s;`) |
| Claude Desktop rejects the URL as a connector | Connectors require OAuth. Use the `mcp-remote` setup in [Claude Desktop](#claude-desktop) |
| `/healthz` works locally but not through the domain | Check DNS, the firewall, and that the proxy points at the port the server listens on (`HOST_PORT` with Compose) |

### Tool errors

Tool errors come back as JSON with a `code` and a message that says what to do. Codes that involve waiting include `retryAfterSeconds` and, for daily limits, `resetAt`.

| Error code | Meaning and fix |
|---|---|
| `PERMISSION_DENIED` | The service account isn't a user on that property. Add the email named in the message in Search Console → Settings → Users and permissions |
| `NOT_FOUND` | Wrong `siteUrl`. URL-prefix properties need the exact URL with a trailing slash; domain properties are `sc-domain:example.com`. Call `list_sites` |
| `SITE_NOT_ALLOWED` | The property isn't in `GSC_ALLOWED_SITES` |
| `AUTH_ERROR` | The key is invalid, deleted or disabled, or the Search Console API isn't enabled in the key's Google Cloud project. The message says which. After enabling the API, wait a few minutes |
| `INVALID_ARGUMENT` | The request can't work as given, e.g. a start date after the end date, or `aggregationType: "byProperty"` with page grouping. The message lists the problems; no quota was spent |
| `LOCAL_RATE_LIMIT` | The server is pacing calls to stay under Google's limits. Retry after `retryAfterSeconds` |
| `LOAD_QUOTA_COOLDOWN` | Google reported a Search Analytics quota as exceeded (most likely the load quota). Wait, and use shorter date ranges and fewer query/page dimensions |
| `GOOGLE_RATE_LIMIT` | Google rate-limited a call even after retries. Retry after `retryAfterSeconds` |
| `GOOGLE_QUOTA_EXCEEDED` | Google reported a quota as used up. The property pauses for 15 minutes, then 1 hour, then until `resetAt` (midnight Pacific) if it keeps happening |
| `DAILY_QUOTA_EXHAUSTED` | The property's URL inspections for today are used up. They reset at `resetAt` (midnight Pacific) |
| `UPSTREAM_ERROR` | Google's API is unavailable or the network failed. Try again shortly |
| `CANCELLED` | The client disconnected, so the server stopped the work |
| `INTERNAL` | An unexpected server error. The details are in the server log; please open an issue |

### The data looks wrong

| Symptom | Explanation |
|---|---|
| `list_sites` returns an empty list | The service account hasn't been added to any property, or `GSC_ALLOWED_SITES` filters them all out. Results are cached for 15 minutes, so pass `bypassCache: true` right after adding the user |
| The last 2–3 days are missing | Final data lags 2–3 days. Pass `dataState: "all"` for fresher, incomplete data |
| Numbers differ from the Search Console website | The website shows fresh data by default; the server defaults to `final`. Query rows add up to less than the property total, because Google leaves anonymized queries out of grouped results. Page rows are counted per page, so their sum can differ from the property total too |
| A URL-prefix property shows nothing | Check the exact prefix: `http` vs `https`, `www` vs bare domain, and the trailing slash. A domain property (`sc-domain:`) covers all of them |
| Dates seem off by a day | Search Console dates are Pacific Time. Daily quotas reset at midnight Pacific too |
| A quota pause blocks you after the cause is fixed | Pauses expire on their own; `get_quota_status` shows when. To clear them early, stop the server and delete `pause-state.json` in `DATA_DIR`. Google may still refuse requests until its own quota recovers |

## License

[MIT](LICENSE)
