import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/http.js';
import { silentLogger } from '../src/logger.js';
import { OAuthStore } from '../src/oauth/store.js';
import { fakeApi, makeService, tokenRegistry } from './helpers.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

describe('bearer check with OAuth', () => {
  let server: Server;
  let base: string;
  let store: OAuthStore;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  beforeAll(async () => {
    store = new OAuthStore({ file: join(mkdtempSync(join(tmpdir(), 'gsc-mcp-oauth-')), 'oauth-state.json'), ttlDays: 90, logger: silentLogger });
    store.registerClient({ client_id: 'grok', redirect_uris: ['https://grok.example/cb'] } as never);
    const app = createApp({
      tokens: tokenRegistry([{ label: 'test', token: TOKEN }]),
      mcpPath: '/gsc-mcp',
      oauth: { store, resourceMetadataUrl: 'https://mcp.example/.well-known/oauth-protected-resource/gsc-mcp' },
      deps: { service: makeService(fakeApi()), logger: silentLogger, maxRowsPerCall: 25_000 },
      logger: silentLogger,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  afterEach(() => vi.useRealTimers());

  const newAccessToken = () => {
    const grant = store.createGrant({ clientId: 'grok', clientName: 'Grok', email: 'owner@example.com', redirectHost: 'grok.example' });
    return store.issueTokens(grant.id).access_token;
  };

  async function listSites(token: string) {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/gsc-mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const res = await client.callTool({ name: 'list_sites', arguments: {} });
    await client.close();
    return res;
  }

  it('accepts an OAuth access token', async () => {
    const res = await listSites(newAccessToken());
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ count: 2 });
    expect(res.structuredContent).not.toHaveProperty('tokenNotice');
  });

  it('still accepts fixed tokens', async () => {
    expect((await listSites(TOKEN)).isError).toBeFalsy();
  });

  it('points clients to the metadata on 401', async () => {
    const meta = 'resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/gsc-mcp"';
    const none = await fetch(`${base}/gsc-mcp`, { method: 'POST', headers, body });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe(`Bearer ${meta}`);
    const wrong = await fetch(`${base}/gsc-mcp`, { method: 'POST', headers: { ...headers, authorization: 'Bearer nope' }, body });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe(`Bearer error="invalid_token", ${meta}`);
  });

  it('rejects a revoked grant immediately', async () => {
    const token = newAccessToken();
    expect((await listSites(token)).isError).toBeFalsy();
    store.revokeAll();
    const res = await fetch(`${base}/gsc-mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}` }, body });
    expect(res.status).toBe(401);
  });

  it('adds a sign-in notice in the last 14 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-02-12T14:30:00Z'));
    const grant = store.createGrant({ clientId: 'grok', clientName: 'Grok', email: 'owner@example.com', redirectHost: 'grok.example' }); // ends 2027-05-13
    vi.setSystemTime(new Date('2027-05-03T10:00:00Z')); // 9 days 14 hours left, shown as 10
    const late = store.issueTokens(grant.id).access_token;
    const res = await listSites(late);
    expect(res.structuredContent).toMatchObject({ tokenNotice: expect.stringMatching(/sign in with Google again/) });
    expect((res.structuredContent as { tokenNotice: string }).tokenNotice).toMatch(/^This client's sign-in \(oauth:Grok#[0-9a-f]{6}\) expires in 10 days/);
  });
});
