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
import { fakeApi, form, makeService, pkce, startOAuthApp, toConsentPage, TOKEN, tokenRegistry } from './helpers.js';

const OLD_TOKEN = 'old-token-0123456789abcdef0123456789abcdef';

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
      tokens: tokenRegistry(
        [
          { label: 'test', token: TOKEN },
          { label: 'old', token: OLD_TOKEN, expiresOn: '2020-01-01' },
        ],
        { autoExpire: true },
      ),
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

  it('keeps an expired fixed token expired, with the metadata pointer', async () => {
    const res = await fetch(`${base}/gsc-mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${OLD_TOKEN}` }, body });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token", error_description="The token has expired", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/gsc-mcp"',
    );
  });

  it('rejects an access token after its hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T15:00:00Z'));
    const token = newAccessToken();
    vi.setSystemTime(new Date(Date.parse('2026-11-24T15:00:00Z') + 3_600_001));
    const res = await fetch(`${base}/gsc-mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}` }, body });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer error="invalid_token", resource_metadata=/);
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

describe('OAuth flow', () => {
  let app: Awaited<ReturnType<typeof startOAuthApp>>;
  beforeAll(async () => {
    app = await startOAuthApp();
  });
  afterAll(() => app.close());

  it('serves discovery', async () => {
    const resource = await (await fetch(`${app.base}/.well-known/oauth-protected-resource/gsc-mcp`)).json();
    expect(resource).toMatchObject({ resource: `${app.base}/gsc-mcp`, authorization_servers: [`${app.base}/`] });
    const as = await (await fetch(`${app.base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: `${app.base}/`,
      authorization_endpoint: `${app.base}/authorize`,
      token_endpoint: `${app.base}/token`,
      registration_endpoint: `${app.base}/register`,
      revocation_endpoint: `${app.base}/revoke`,
      code_challenge_methods_supported: ['S256'],
    });
    const challenge = await fetch(`${app.base}/gsc-mcp`, { method: 'POST' });
    expect(challenge.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${app.base}/.well-known/oauth-protected-resource/gsc-mcp"`);
  });

  it('full flow: register, Google, consent, token, MCP call, refresh, reuse', async () => {
    const c = await toConsentPage(app.base, app.g);
    expect(c.consent.status).toBe(200);
    expect(c.consent.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(c.consent.headers.get('cache-control')).toBe('no-store');
    expect(c.html).toContain('Grok');
    expect(c.html).toContain('127.0.0.1:9');
    expect(c.html).toMatch(/Access ends on <strong>\d{4}-\d{2}-\d{2}<\/strong>/);

    const approved = await fetch(`${app.base}/oauth/consent`, form({ consentId: c.consentId!, csrf: c.csrf!, decision: 'approve' }));
    expect(approved.status).toBe(302);
    const back = new URL(approved.headers.get('location')!);
    expect(back.origin + back.pathname).toBe('http://127.0.0.1:9/cb');
    expect(back.searchParams.get('state')).toBe('xyz');

    const token = await fetch(`${app.base}/token`, form({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: c.verifier, client_id: c.clientId, redirect_uri: 'http://127.0.0.1:9/cb' }));
    expect(token.status).toBe(200);
    const t1 = (await token.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
    expect(t1).toMatchObject({ token_type: 'bearer', expires_in: 3600 });

    const mcp = new Client({ name: 'test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${app.base}/gsc-mcp`), { requestInit: { headers: { Authorization: `Bearer ${t1.access_token}` } } }));
    expect((await mcp.callTool({ name: 'list_sites', arguments: {} })).isError).toBeFalsy();
    await mcp.close();

    const refreshed = await fetch(`${app.base}/token`, form({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: c.clientId }));
    expect(refreshed.status).toBe(200);
    const t2 = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(t2.refresh_token).not.toBe(t1.refresh_token);

    const reused = await fetch(`${app.base}/token`, form({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: c.clientId }));
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });
    const after = await fetch(`${app.base}/gsc-mcp`, { method: 'POST', headers: { authorization: `Bearer ${t2.access_token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(after.status).toBe(401);
  });

  it('escapes the client name', async () => {
    const c = await toConsentPage(app.base, app.g, '<script>alert(1)</script>');
    expect(c.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(c.html).not.toContain('<script>alert');
  });

  it('rejects a replayed callback', async () => {
    const c = await toConsentPage(app.base, app.g);
    const again = await fetch(c.callback);
    expect(again.status).toBe(400);
    expect(again.headers.get('content-type')).toMatch(/text\/html/);
    expect(await again.text()).toMatch(/expired or was already used/);
  });

  it('rejects a bogus, missing, duplicated or expired state without creating a grant', async () => {
    const before = app.store.grants().length;
    for (const query of ['state=bogus&code=c', 'code=c', '', 'state=a&state=b&code=c']) {
      const res = await fetch(`${app.base}/oauth/google/callback?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    vi.useFakeTimers({ toFake: ['Date'] });
    const authorize = new URL(`${app.base}/authorize`);
    const reg = (await (await fetch(`${app.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none' }) })).json()) as { client_id: string };
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' })) authorize.searchParams.set(k, v);
    await fetch(authorize, { redirect: 'manual' });
    vi.setSystemTime(new Date(Date.now() + 300_001));
    const late = await fetch(`${app.base}/oauth/google/callback?state=${encodeURIComponent(app.g.lastState())}&code=c`);
    expect(late.status).toBe(400);
    expect(await late.text()).toMatch(/expired or was already used/);
    vi.useRealTimers();
    expect(app.store.grants()).toHaveLength(before);
  });

  it('answers a failing Google callback with an error page', async () => {
    const spy = vi.spyOn(app.provider, 'handleGoogleReturn').mockRejectedValueOnce(new Error('Invalid token signature: eyJsecret'));
    const res = await fetch(`${app.base}/oauth/google/callback?state=s&code=c`);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).not.toContain('eyJsecret');
  });

  it('answers oversized or malformed consent forms with a page', async () => {
    const big = await fetch(`${app.base}/oauth/consent`, form({ consentId: 'x'.repeat(5000), csrf: 'y', decision: 'approve' }));
    expect(big.status).toBe(413);
    expect(big.headers.get('content-type')).toMatch(/text\/html/);
    const json = await fetch(`${app.base}/oauth/consent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"decision":"approve"}' });
    expect(json.status).toBe(400);
    expect(json.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('rejects a consent POST without the right csrf', async () => {
    const c = await toConsentPage(app.base, app.g);
    expect((await fetch(`${app.base}/oauth/consent`, form({ consentId: c.consentId!, csrf: 'wrong', decision: 'approve' }))).status).toBe(400);
    expect((await fetch(`${app.base}/oauth/consent`, form({ consentId: c.consentId!, decision: 'approve' }))).status).toBe(400);
    expect((await fetch(`${app.base}/oauth/consent`, form({ consentId: c.consentId!, csrf: c.csrf!, decision: 'maybe' }))).status).toBe(400);
  });

  it('denies when asked', async () => {
    const c = await toConsentPage(app.base, app.g);
    const denied = await fetch(`${app.base}/oauth/consent`, form({ consentId: c.consentId!, csrf: c.csrf!, decision: 'deny' }));
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('rejects a wrong PKCE verifier', async () => {
    const c = await toConsentPage(app.base, app.g);
    const approved = await fetch(`${app.base}/oauth/consent`, form({ consentId: c.consentId!, csrf: c.csrf!, decision: 'approve' }));
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const bad = await fetch(`${app.base}/token`, form({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: c.clientId, redirect_uri: 'http://127.0.0.1:9/cb' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a code exchange with a different redirect_uri', async () => {
    const c = await toConsentPage(app.base, app.g);
    const approved = await fetch(`${app.base}/oauth/consent`, form({ consentId: c.consentId!, csrf: c.csrf!, decision: 'approve' }));
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const bad = await fetch(`${app.base}/token`, form({ grant_type: 'authorization_code', code, code_verifier: c.verifier, client_id: c.clientId, redirect_uri: 'http://127.0.0.1:9/other' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('lets a client revoke its token', async () => {
    const c = await toConsentPage(app.base, app.g);
    const approved = await fetch(`${app.base}/oauth/consent`, form({ consentId: c.consentId!, csrf: c.csrf!, decision: 'approve' }));
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const t = (await (await fetch(`${app.base}/token`, form({ grant_type: 'authorization_code', code, code_verifier: c.verifier, client_id: c.clientId }))).json()) as { access_token: string };
    const revoked = await fetch(`${app.base}/revoke`, form({ token: t.access_token, client_id: c.clientId }));
    expect(revoked.status).toBe(200);
    const after = await fetch(`${app.base}/gsc-mcp`, { method: 'POST', headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(after.status).toBe(401);
  });
});

describe('OAuth mounting', () => {
  it('serves no OAuth routes when OAuth is off', async () => {
    const app = createApp({ tokens: tokenRegistry([{ label: 'test', token: TOKEN }]), deps: { service: makeService(fakeApi()), logger: silentLogger, maxRowsPerCall: 25_000 }, logger: silentLogger });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/authorize', '/clients', '/oauth/google/callback']) {
        expect((await fetch(`${base}${path}`)).status, path).toBe(404);
      }
      for (const path of ['/register', '/token', '/revoke', '/oauth/consent']) {
        expect((await fetch(`${base}${path}`, { method: 'POST' })).status, path).toBe(404);
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('applies ALLOWED_HOSTS to the OAuth routes', async () => {
    const app = await startOAuthApp({ allowedHosts: ['gsc.example'] });
    try {
      expect((await fetch(`${app.base}/.well-known/oauth-authorization-server`)).status).toBe(403);
      expect((await fetch(`${app.base}/clients`, { redirect: 'manual' })).status).toBe(403);
      expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('passes TRUST_PROXY to Express', async () => {
    const app = await startOAuthApp({ trustProxy: 2 });
    try {
      expect(app.app.get('trust proxy')).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('limits Google callbacks per address', async () => {
    const app = await startOAuthApp({ trustProxy: 1 });
    try {
      const hit = (ip: string) => fetch(`${app.base}/oauth/google/callback?state=bogus&code=c`, { headers: { 'x-forwarded-for': ip } });
      for (let i = 0; i < 30; i++) expect((await hit('203.0.113.7')).status).toBe(400);
      expect((await hit('203.0.113.7')).status).toBe(429);
      expect((await hit('198.51.100.1')).status).toBe(400);
    } finally {
      await app.close();
    }
  });
});
