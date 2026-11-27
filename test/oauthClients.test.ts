import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logger.js';
import { form, pkce, startOAuthApp, TOKEN } from './helpers.js';

describe('Connected clients page', () => {
  let app: Awaited<ReturnType<typeof startOAuthApp>>;
  const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    debug() {},
    info: (msg, fields) => logs.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => logs.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => logs.push({ level: 'error', msg, fields }),
  };
  beforeAll(async () => {
    app = await startOAuthApp({ logger });
  });
  afterAll(() => app.close());
  afterEach(() => {
    vi.useRealTimers();
    app.g.setNext({ email: 'owner@example.com', emailVerified: true });
  });

  /** GET /clients without a session: returns the sign-in cookie it sets and the Google state. */
  async function startSignIn() {
    const start = await fetch(`${app.base}/clients`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toMatch(/^https:\/\/google\.test\/auth\?state=/);
    const set = start.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/^__Host-gsc_mcp_signin=[\w-]{40,}\.[\w-]{40,}\.\d+; Path=\/; Max-Age=300; HttpOnly; Secure; SameSite=Lax$/);
    return { signin: set[0]!.split(';')[0]!, state: app.g.lastState() };
  }
  const callback = (state: string, cookie?: string) =>
    fetch(`${app.base}/oauth/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(state)}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

  /** Signs in through the fake Google; returns the session cookie and the page's csrf. */
  async function signIn() {
    const { signin, state } = await startSignIn();
    const back = await callback(state, signin);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/clients');
    const set = back.headers.getSetCookie();
    expect(set).toContainEqual(expect.stringMatching(/^__Host-gsc_mcp_signin=; Path=\/; Max-Age=0/));
    const setCookie = set.find((c) => c.startsWith('__Host-gsc_mcp_session='))!;
    expect(setCookie).toMatch(/^__Host-gsc_mcp_session=[\w-]{40,}; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);
    const cookie = setCookie.split(';')[0]!;
    const list = await fetch(`${app.base}/clients`, { headers: { cookie }, redirect: 'manual' });
    expect(list.status).toBe(200);
    const html = await list.text();
    return { cookie, html, csrf: /name="csrf" value="([^"]+)"/.exec(html)![1]! };
  }

  const grantFor = (name: string) => {
    const { client_id: clientId } = app.store.registerClient({ redirect_uris: ['https://x.example/cb'] } as never);
    const grant = app.store.createGrant({ clientId, clientName: name, email: 'owner@example.com', redirectHost: 'x.example' });
    return { grant, token: app.store.issueTokens(grant.id).access_token };
  };
  const mcpStatus = async (token: string) =>
    (await fetch(`${app.base}/gsc-mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status;

  it('redirects to Google without a session, or with an unknown one', async () => {
    expect((await fetch(`${app.base}/clients`, { redirect: 'manual' })).status).toBe(302);
    expect((await fetch(`${app.base}/clients`, { headers: { cookie: '__Host-gsc_mcp_session=forged' }, redirect: 'manual' })).status).toBe(302);
  });

  it('signs in and lists grants and fixed tokens', async () => {
    grantFor('Grok');
    const { html } = await signIn();
    expect(html).toContain('Grok');
    expect(html).toContain('x.example');
    expect(html).toContain('owner@example.com');
    expect(html).toMatch(/<td>test<\/td><td>never<\/td>/);
  });

  it('refuses a disallowed account', async () => {
    const { signin, state } = await startSignIn();
    app.g.setNext({ email: 'intruder@example.com' });
    const back = await callback(state, signin);
    expect(back.status).toBe(403);
    expect(back.headers.getSetCookie().some((c) => c.startsWith('__Host-gsc_mcp_session='))).toBe(false);
  });

  it('leaves the sign-in cookie alone on another sign-in\'s callback', async () => {
    const { signin } = await startSignIn();
    const other = await fetch(`${app.base}/oauth/google/callback?state=bogus&code=c`, { headers: { cookie: signin } });
    expect(other.headers.getSetCookie()).toEqual([]);
  });

  it('binds the sign-in to the browser that started it', async () => {
    const { signin, state } = await startSignIn();
    expect((await callback(state)).status).toBe(400); // no cookie
    const other = await startSignIn();
    expect((await callback(state, other.signin)).status).toBe(400); // another browser's cookie
    expect((await callback(state, signin)).status).toBe(302);
  });

  it('revokes one grant', async () => {
    const a = grantFor('Alpha');
    const b = grantFor('Beta');
    const { cookie, csrf } = await signIn();
    const res = await fetch(`${app.base}/clients/revoke`, { ...form({ csrf, grantId: a.grant.id }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/clients');
    expect(await mcpStatus(a.token)).toBe(401);
    expect(await mcpStatus(b.token)).toBe(200);
  });

  it('revokes all grants and keeps fixed tokens', async () => {
    const a = grantFor('Alpha');
    const { cookie, csrf } = await signIn();
    const res = await fetch(`${app.base}/clients/revoke-all`, { ...form({ csrf }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
    expect(res.status).toBe(303);
    expect(await mcpStatus(a.token)).toBe(401);
    expect(app.store.grants()).toEqual([]);
    expect(await mcpStatus(TOKEN)).toBe(200);
  });

  it('rejects a POST with a missing or wrong csrf, or no session', async () => {
    const a = grantFor('Alpha');
    const { cookie, csrf } = await signIn();
    const post = (fields: Record<string, string>, c?: string) =>
      fetch(`${app.base}/clients/revoke`, { ...form(fields), headers: { 'content-type': 'application/x-www-form-urlencoded', ...(c ? { cookie: c } : {}) } });
    expect((await post({ grantId: a.grant.id }, cookie)).status).toBe(403);
    expect((await post({ grantId: a.grant.id, csrf: 'wrong' }, cookie)).status).toBe(403);
    expect((await post({ grantId: a.grant.id, csrf })).status).toBe(403);
    expect(await mcpStatus(a.token)).toBe(200);
  });

  it('ends a session after 12 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { cookie } = await signIn();
    vi.setSystemTime(new Date(Date.now() + 43_200_001));
    expect((await fetch(`${app.base}/clients`, { headers: { cookie }, redirect: 'manual' })).status).toBe(302);
  });

  it('signs out', async () => {
    const { cookie, csrf } = await signIn();
    const out = await fetch(`${app.base}/clients/sign-out`, { ...form({ csrf }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
    expect(out.status).toBe(200); // a page, not a redirect into a new sign-in
    expect(await out.text()).toContain('Signed out');
    expect(out.headers.get('set-cookie')).toMatch(/^__Host-gsc_mcp_session=; Path=\/; Max-Age=0/);
    expect((await fetch(`${app.base}/clients`, { headers: { cookie }, redirect: 'manual' })).status).toBe(302);
  });

  it('escapes names and redirect hosts', async () => {
    const reg = (await (
      await fetch(`${app.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://x.example/cb'], client_name: '<script>alert(1)</script>' }) })
    ).json()) as { client_id: string; client_name: string };
    app.store.createGrant({ clientId: reg.client_id, clientName: reg.client_name, email: 'owner@example.com', redirectHost: '"><img src=x>' });
    const { html } = await signIn();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&quot;&gt;&lt;img src=x&gt;');
    expect(html).not.toContain('<img src=x>');
  });

  it('ignores an unknown or empty grant id', async () => {
    const a = grantFor('Alpha');
    const { cookie, csrf } = await signIn();
    for (const grantId of ['nope', '']) {
      const res = await fetch(`${app.base}/clients/revoke`, { ...form({ csrf, grantId }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
      expect(res.status).toBe(303);
    }
    expect(await mcpStatus(a.token)).toBe(200);
  });

  it('does not let a bearer token stand in for a session', async () => {
    const a = grantFor('Alpha');
    for (const token of [TOKEN, a.token]) {
      const res = await fetch(`${app.base}/clients`, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toMatch(/^https:\/\/google\.test\//);
    }
  });

  it('requires the csrf for revoke-all and sign-out too', async () => {
    const a = grantFor('Alpha');
    const { cookie } = await signIn();
    for (const path of ['/clients/revoke-all', '/clients/sign-out']) {
      const res = await fetch(`${app.base}${path}`, { ...form({}), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
      expect(res.status, path).toBe(403);
    }
    expect(await mcpStatus(a.token)).toBe(200);
    expect((await fetch(`${app.base}/clients`, { headers: { cookie }, redirect: 'manual' })).status).toBe(200);
  });

  it('logs who revoked, without session secrets', async () => {
    const a = grantFor('Alpha');
    const { cookie, csrf } = await signIn();
    await fetch(`${app.base}/clients/revoke`, { ...form({ csrf, grantId: a.grant.id }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'grant revoked', fields: { client: `oauth:Alpha#${a.grant.id.slice(0, 6)}`, by: 'owner@example.com' } }));
    const text = JSON.stringify(logs);
    expect(text).not.toContain(cookie.split('=')[1]!);
    expect(text).not.toContain(csrf);
  });

  it('ends the previous session on a new sign-in', async () => {
    const first = await signIn();
    const { signin, state } = await startSignIn();
    const back = await callback(state, `${first.cookie}; ${signin}`);
    expect(back.status).toBe(302);
    expect((await fetch(`${app.base}/clients`, { headers: { cookie: first.cookie }, redirect: 'manual' })).status).toBe(302);
  });

  it('never lets clients-page sign-ins block client sign-ins or the owner', async () => {
    const owner = await startSignIn();
    for (let i = 0; i < 1100; i++) await fetch(`${app.base}/clients`, { redirect: 'manual' });
    const reg = (await (
      await fetch(`${app.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none' }) })
    ).json()) as { client_id: string };
    const authorize = new URL(`${app.base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' })) authorize.searchParams.set(k, v);
    const res = await fetch(authorize, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/google\.test\//);
    // The owner's sign-in, started before the flood, still works: nothing about it is kept on the server.
    expect((await callback(owner.state, owner.signin)).headers.get('location')).toBe('/clients');
  });

  it('serves the page with no-store and no framing', async () => {
    const { cookie } = await signIn();
    const res = await fetch(`${app.base}/clients`, { headers: { cookie } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
