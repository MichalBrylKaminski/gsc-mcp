import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { form, startOAuthApp, TOKEN } from './helpers.js';

describe('Connected clients page', () => {
  let app: Awaited<ReturnType<typeof startOAuthApp>>;
  beforeAll(async () => {
    app = await startOAuthApp();
  });
  afterAll(() => app.close());
  afterEach(() => {
    vi.useRealTimers();
    app.g.setNext({ email: 'owner@example.com', emailVerified: true });
  });

  /** Signs in through the fake Google; returns the session cookie and the page's csrf. */
  async function signIn() {
    const start = await fetch(`${app.base}/clients`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toMatch(/^https:\/\/google\.test\/auth\?state=/);
    const back = await fetch(`${app.base}/oauth/google/callback?state=${encodeURIComponent(app.g.lastState())}&code=c`, { redirect: 'manual' });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/clients');
    const setCookie = back.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^gsc_mcp_session=[\w-]{40,}; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);
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
    expect((await fetch(`${app.base}/clients`, { headers: { cookie: 'gsc_mcp_session=forged' }, redirect: 'manual' })).status).toBe(302);
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
    await fetch(`${app.base}/clients`, { redirect: 'manual' });
    app.g.setNext({ email: 'intruder@example.com' });
    const back = await fetch(`${app.base}/oauth/google/callback?state=${encodeURIComponent(app.g.lastState())}&code=c`, { redirect: 'manual' });
    expect(back.status).toBe(403);
    expect(back.headers.get('set-cookie')).toBeNull();
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
    expect(out.status).toBe(303);
    expect(out.headers.get('set-cookie')).toMatch(/^gsc_mcp_session=; Path=\/; Max-Age=0/);
    expect((await fetch(`${app.base}/clients`, { headers: { cookie }, redirect: 'manual' })).status).toBe(302);
  });

  it('escapes names', async () => {
    grantFor('<b>x</b>');
    const { html } = await signIn();
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('serves the page with no-store and no framing', async () => {
    const { cookie } = await signIn();
    const res = await fetch(`${app.base}/clients`, { headers: { cookie } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
