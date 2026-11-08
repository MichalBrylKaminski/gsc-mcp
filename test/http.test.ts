import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/http.js';
import { silentLogger } from '../src/logger.js';
import { fakeApi, makeService } from './helpers.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp({ authToken: TOKEN, deps: { service: makeService(fakeApi()), logger: silentLogger, maxRowsPerCall: 25_000 }, logger: silentLogger });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

describe('HTTP transport', () => {
  it('serves /healthz without auth', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('rejects missing and wrong tokens', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers, body })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, authorization: 'Bearer nope' }, body })).status).toBe(401);
  });

  it('lists exactly the read-only tools', async () => {
    const client = await connect(TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'batch_inspect_urls',
      'get_quota_status',
      'get_site',
      'get_site_overview',
      'get_sitemap',
      'inspect_url',
      'list_sitemaps',
      'list_sites',
      'search_analytics_query',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    await client.close();
  });

  it('calls a tool end to end', async () => {
    const client = await connect(TOKEN);
    const res = await client.callTool({ name: 'list_sites', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ count: 2, sites: [{ siteUrl: 'https://www.example.com/' }, { siteUrl: 'sc-domain:example.org' }] });
    const bad = await client.callTool({ name: 'get_site', arguments: { siteUrl: 'not a site' } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse((bad.content as { text: string }[])[0]!.text)).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
    await client.close();
  });
});
