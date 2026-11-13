import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
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
      'compare_periods',
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

describe('HTTP edge cases', () => {
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  it('answers GET and DELETE with 405', async () => {
    expect((await fetch(`${base}/mcp`, { headers: auth })).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: 'DELETE', headers: auth })).status).toBe(405);
  });

  it('returns JSON-RPC errors for bad JSON and oversized bodies', async () => {
    const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: '{not json' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } });
    const big = await fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ x: 'a'.repeat(2 * 1024 * 1024) }) });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: { code: -32600 } });
  });

  it('serves the MCP endpoint at a custom path', async () => {
    const app = createApp({ authToken: TOKEN, mcpPath: '/gsc-mcp', deps: { service: makeService(fakeApi()), logger: silentLogger, maxRowsPerCall: 25_000 }, logger: silentLogger });
    const s = app.listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    try {
      expect((await fetch(`${url}/gsc-mcp`, { method: 'POST', headers: auth, body })).status).toBe(200);
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers: auth, body })).status).toBe(404);
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  it('rejects unknown Host headers when ALLOWED_HOSTS is set', async () => {
    const app = createApp({
      authToken: TOKEN,
      allowedHosts: loadConfig({ MCP_AUTH_TOKEN: TOKEN, GOOGLE_APPLICATION_CREDENTIALS: 'x', ALLOWED_HOSTS: 'LOCALHOST:443, 127.0.0.1' }).ALLOWED_HOSTS,
      deps: { service: makeService(fakeApi()), logger: silentLogger, maxRowsPerCall: 25_000 },
      logger: silentLogger,
    });
    const s = app.listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const port = (s.address() as AddressInfo).port;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: auth, body });
      expect(ok.status).toBe(200);
      const viaName = await fetch(`http://localhost:${port}/mcp`, { method: 'POST', headers: auth, body });
      expect(viaName.status).toBe(200); // "LOCALHOST:443" was normalised to "localhost"
      // fetch can't override Host, so use node:http for the DNS-rebinding case.
      const rebindStatus = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { ...auth, host: 'evil.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(body);
      });
      expect(rebindStatus).toBe(403);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});
