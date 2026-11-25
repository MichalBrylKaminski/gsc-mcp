import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger } from '../src/logger.js';
import { GscOAuthProvider, redirectTarget } from '../src/oauth/provider.js';
import { OAuthStore } from '../src/oauth/store.js';
import { fakeGoogle } from './helpers.js';

function spyLogger() {
  const calls: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = { debug() {}, info: (msg, fields) => calls.push({ level: 'info', msg, fields }), warn: (msg, fields) => calls.push({ level: 'warn', msg, fields }), error: (msg, fields) => calls.push({ level: 'error', msg, fields }) };
  return { logger, calls };
}

function fakeRes() {
  const r = { url: '', status: 0 };
  const res = { redirect: (status: number, url: string) => Object.assign(r, { status, url }) } as unknown as Response;
  return { res, r };
}

const CLIENT: OAuthClientInformationFull = { client_id: 'grok', client_name: 'Grok', redirect_uris: ['https://grok.example/cb'], token_endpoint_auth_method: 'none' };
const PARAMS: AuthorizationParams = { codeChallenge: 'challenge-abc', redirectUri: 'https://grok.example/cb', state: 'client-state' };

function setup(allowedEmails = ['owner@example.com']) {
  const g = fakeGoogle();
  const { logger, calls } = spyLogger();
  const store = new OAuthStore({ ttlDays: 90, logger });
  store.registerClient(CLIENT);
  const provider = new GscOAuthProvider({ store, google: g.google, allowedEmails, ttlDays: 90, logger });
  return { g, store, provider, calls };
}

async function toConsent(p: ReturnType<typeof setup>) {
  const { res, r } = fakeRes();
  await p.provider.authorize(CLIENT, PARAMS, res);
  expect(r.status).toBe(302);
  const ret = await p.provider.handleGoogleReturn({ state: p.g.lastState(), code: 'google-code' });
  return { ret, googleUrl: r.url };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-24T15:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('redirectTarget', () => {
  it('shows where codes go', () => {
    expect(redirectTarget('https://grok.example/cb')).toBe('grok.example');
    expect(redirectTarget('http://localhost:33418/callback')).toBe('http://localhost:33418');
    expect(redirectTarget('com.example.app:/cb')).toBe('com.example.app:');
  });
});

describe('GscOAuthProvider', () => {
  it('authorize redirects to Google and keeps the request', async () => {
    const p = setup();
    const { googleUrl } = await toConsent(p);
    expect(googleUrl).toMatch(/^https:\/\/google\.test\/auth\?state=/);
    expect(p.g.issued[0]!.state).toMatch(/.{32,}/);
    expect(p.g.issued[0]!.nonce).toMatch(/.{32,}/);
  });

  it('happy path: Google, consent, code, tokens', async () => {
    const p = setup();
    const { ret } = await toConsent(p);
    expect(ret).toMatchObject({ kind: 'consent', clientName: 'Grok', redirectHost: 'grok.example', expiresOn: '2027-02-22' });
    if (ret.kind !== 'consent') throw new Error('expected consent');
    const done = p.provider.decideConsent(ret.consentId, ret.csrf, true);
    expect(done.kind).toBe('redirect');
    const url = new URL((done as { url: string }).url);
    expect(url.origin + url.pathname).toBe('https://grok.example/cb');
    expect(url.searchParams.get('state')).toBe('client-state');
    const code = url.searchParams.get('code')!;
    expect(code).toMatch(/.{32,}/);
    expect(await p.provider.challengeForAuthorizationCode(CLIENT, code)).toBe('challenge-abc');
    const tokens = await p.provider.exchangeAuthorizationCode(CLIENT, code, undefined, 'https://grok.example/cb');
    expect(tokens).toMatchObject({ token_type: 'bearer', expires_in: 3600 });
    expect(p.store.grants()).toMatchObject([{ clientId: 'grok', clientName: 'Grok', email: 'owner@example.com', redirectHost: 'grok.example' }]);
    await expect(p.provider.exchangeAuthorizationCode(CLIENT, code)).rejects.toThrow(InvalidGrantError);

    const info = await p.provider.verifyAccessToken(tokens.access_token);
    expect(info).toMatchObject({ scopes: [], expiresAt: Date.parse('2027-02-22T00:00:00Z') / 1000 });
    expect(info.clientId).toMatch(/^oauth:Grok#/);
    await expect(p.provider.verifyAccessToken('nope')).rejects.toThrow(InvalidTokenError);

    const again = await p.provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!);
    expect(again.access_token).not.toBe(tokens.access_token);
    await p.provider.revokeToken!(CLIENT, { token: again.access_token });
    expect(p.store.grants()).toEqual([]);
  });

  it('ignores email case', async () => {
    const p = setup(['owner@example.com']);
    p.g.setNext({ email: 'Owner@Example.com' });
    expect((await toConsent(p)).ret.kind).toBe('consent');
  });

  it('refuses a disallowed or unverified email', async () => {
    for (const next of [{ email: 'someone@else.com' }, { emailVerified: false }]) {
      const p = setup();
      p.g.setNext(next);
      const { ret } = await toConsent(p);
      expect(ret.kind).toBe('redirect');
      const url = new URL((ret as { url: string }).url);
      expect(url.searchParams.get('error')).toBe('access_denied');
      expect(url.searchParams.get('state')).toBe('client-state');
      expect(p.calls).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'sign-in refused', fields: expect.objectContaining({ email: next.email ?? 'owner@example.com' }) }));
      expect(p.store.grants()).toEqual([]);
    }
  });

  it('passes a Google error or a Deny back to the client', async () => {
    const p = setup();
    const { res } = fakeRes();
    await p.provider.authorize(CLIENT, PARAMS, res);
    const ret = await p.provider.handleGoogleReturn({ state: p.g.lastState(), error: 'access_denied' });
    expect(new URL((ret as { url: string }).url).searchParams.get('error')).toBe('access_denied');

    const { ret: consent } = await toConsent(p);
    if (consent.kind !== 'consent') throw new Error('expected consent');
    const denied = p.provider.decideConsent(consent.consentId, consent.csrf, false);
    expect(new URL((denied as { url: string }).url).searchParams.get('error')).toBe('access_denied');
    expect(p.store.grants()).toEqual([]);
  });

  it('rejects an unknown, expired or reused state', async () => {
    const p = setup();
    expect(await p.provider.handleGoogleReturn({ state: 'made-up', code: 'c' })).toMatchObject({ kind: 'error', status: 400 });
    expect(await p.provider.handleGoogleReturn({ code: 'c' })).toMatchObject({ kind: 'error', status: 400 });

    const { res } = fakeRes();
    await p.provider.authorize(CLIENT, PARAMS, res);
    const state = p.g.lastState();
    vi.setSystemTime(new Date(Date.now() + 300_001));
    expect(await p.provider.handleGoogleReturn({ state, code: 'c' })).toMatchObject({ kind: 'error', status: 400 });

    vi.setSystemTime(new Date('2026-11-24T15:00:00Z'));
    await toConsent(p);
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), code: 'c' })).toMatchObject({ kind: 'error', status: 400 });
    expect(p.store.grants()).toEqual([]);
  });

  it('rejects a wrong nonce or a failed Google exchange', async () => {
    const p = setup();
    p.g.setNext({ nonce: 'other' });
    const bad = new URL(((await toConsent(p)).ret as { url: string }).url);
    expect(bad.origin + bad.pathname).toBe('https://grok.example/cb');
    expect(bad.searchParams.get('error')).toBe('access_denied');
    expect(bad.searchParams.get('state')).toBe('client-state');
    expect(bad.searchParams.has('code')).toBe(false);
    expect(p.calls).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'Google sign-in failed', fields: { error: 'nonce mismatch' } }));
    p.g.setNext(new Error('invalid_grant'));
    const { ret } = await toConsent(p);
    expect(ret.kind).toBe('redirect');
    const url = new URL((ret as { url: string }).url);
    expect(url.searchParams.get('error')).toBe('temporarily_unavailable');
    expect(url.searchParams.get('state')).toBe('client-state');
  });

  it('rejects a wrong csrf but keeps the consent usable', async () => {
    const p = setup();
    const { ret } = await toConsent(p);
    if (ret.kind !== 'consent') throw new Error('expected consent');
    expect(p.provider.decideConsent(ret.consentId, 'wrong', true)).toMatchObject({ kind: 'error', status: 400 });
    expect(p.provider.decideConsent('unknown', ret.csrf, true)).toMatchObject({ kind: 'error', status: 400 });
    expect(p.provider.decideConsent(ret.consentId, ret.csrf, true).kind).toBe('redirect');
    expect(p.provider.decideConsent(ret.consentId, ret.csrf, true)).toMatchObject({ kind: 'error', status: 400 });
  });

  it('expires a consent after 5 minutes', async () => {
    const p = setup();
    const { ret } = await toConsent(p);
    if (ret.kind !== 'consent') throw new Error('expected consent');
    vi.setSystemTime(new Date(Date.now() + 300_001));
    expect(p.provider.decideConsent(ret.consentId, ret.csrf, true)).toMatchObject({ kind: 'error', status: 400 });
  });

  it('binds a code to its client, redirect URI and lifetime', async () => {
    const p = setup();
    const other: OAuthClientInformationFull = { ...CLIENT, client_id: 'other' };
    const code = async () => {
      const { ret } = await toConsent(p);
      if (ret.kind !== 'consent') throw new Error('expected consent');
      return new URL((p.provider.decideConsent(ret.consentId, ret.csrf, true) as { url: string }).url).searchParams.get('code')!;
    };
    await expect(p.provider.challengeForAuthorizationCode(other, await code())).rejects.toThrow(InvalidGrantError);
    await expect(p.provider.exchangeAuthorizationCode(other, await code())).rejects.toThrow(InvalidGrantError);
    await expect(p.provider.exchangeAuthorizationCode(CLIENT, await code(), undefined, 'https://evil.example/cb')).rejects.toThrow(InvalidGrantError);
    const late = await code();
    vi.setSystemTime(new Date(Date.now() + 300_001));
    await expect(p.provider.exchangeAuthorizationCode(CLIENT, late)).rejects.toThrow(InvalidGrantError);
  });

  it('rejects an ID token without a nonce', async () => {
    const p = setup();
    p.g.setNext({ nonce: undefined });
    const { ret } = await toConsent(p);
    expect(ret.kind).toBe('redirect');
    expect(new URL((ret as { url: string }).url).searchParams.get('error')).toBe('access_denied');
  });

  it('logs a cancel at Google', async () => {
    const p = setup();
    const { res } = fakeRes();
    await p.provider.authorize(CLIENT, PARAMS, res);
    await p.provider.handleGoogleReturn({ state: p.g.lastState(), error: 'access_denied' });
    expect(p.calls).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'sign-in cancelled', fields: { reason: 'access_denied' } }));
  });

  it('keeps at most 20 sign-ins per client, dropping the oldest', async () => {
    const p = setup();
    const { res } = fakeRes();
    await p.provider.authorize(CLIENT, PARAMS, res);
    const first = p.g.lastState();
    await p.provider.authorize(CLIENT, PARAMS, res);
    const second = p.g.lastState();
    for (let i = 0; i < 19; i++) await p.provider.authorize(CLIENT, PARAMS, res);
    expect(await p.provider.handleGoogleReturn({ state: first, code: 'google-code' })).toMatchObject({ kind: 'error', status: 400 });
    expect((await p.provider.handleGoogleReturn({ state: second, code: second })).kind).toBe('consent');
  });

  it("a flood from other clients can't block the owner's sign-in", async () => {
    const p = setup();
    const { res } = fakeRes();
    for (let i = 0; i < 60; i++) {
      const spam = { ...CLIENT, client_id: `spam-${i}` };
      for (let j = 0; j < 20; j++) await p.provider.authorize(spam, PARAMS, res);
    }
    await p.provider.authorize(CLIENT, PARAMS, res);
    const owner = p.g.lastState();
    for (let i = 0; i < 900; i++) await p.provider.authorize({ ...CLIENT, client_id: `late-${i % 50}` }, PARAMS, res);
    expect((await p.provider.handleGoogleReturn({ state: owner, code: owner })).kind).toBe('consent');
  });

  it('caps sign-ins in progress at 1000, dropping the oldest', async () => {
    const p = setup();
    const { res } = fakeRes();
    await p.provider.authorize(CLIENT, PARAMS, res);
    const first = p.g.lastState();
    for (let i = 0; i < 1000; i++) await p.provider.authorize({ ...CLIENT, client_id: `c-${i % 100}` }, PARAMS, res);
    expect(await p.provider.handleGoogleReturn({ state: first, code: first })).toMatchObject({ kind: 'error', status: 400 });
  });

  it('requires redirect_uri at /token unless the code went to the only registered URI', async () => {
    const MULTI: OAuthClientInformationFull = { ...CLIENT, client_id: 'multi', redirect_uris: ['https://grok.example/cb', 'https://grok.example/cb2'] };
    const p = setup();
    p.store.registerClient(MULTI);
    const codeFor = async (client: OAuthClientInformationFull) => {
      const { res } = fakeRes();
      await p.provider.authorize(client, PARAMS, res);
      const state = p.g.lastState();
      const ret = await p.provider.handleGoogleReturn({ state, code: state });
      if (ret.kind !== 'consent') throw new Error('expected consent');
      return new URL((p.provider.decideConsent(ret.consentId, ret.csrf, true) as { url: string }).url).searchParams.get('code')!;
    };
    await expect(p.provider.exchangeAuthorizationCode(MULTI, await codeFor(MULTI))).rejects.toThrow(InvalidGrantError);
    await expect(p.provider.exchangeAuthorizationCode(MULTI, await codeFor(MULTI), undefined, 'https://grok.example/cb2')).rejects.toThrow(InvalidGrantError);
    await expect(p.provider.exchangeAuthorizationCode(MULTI, await codeFor(MULTI), undefined, 'https://grok.example/cb')).resolves.toMatchObject({ token_type: 'bearer' });
    await expect(p.provider.exchangeAuthorizationCode(CLIENT, await codeFor(CLIENT))).resolves.toMatchObject({ token_type: 'bearer' });
  });

  it('saves new tokens to disk before handing them out', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gsc-mcp-provider-')), 'oauth-state.json');
    const g = fakeGoogle();
    const store = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    store.registerClient(CLIENT);
    const provider = new GscOAuthProvider({ store, google: g.google, allowedEmails: ['owner@example.com'], ttlDays: 90, logger: silentLogger });
    const { res } = fakeRes();
    await provider.authorize(CLIENT, PARAMS, res);
    const ret = await provider.handleGoogleReturn({ state: g.lastState(), code: g.lastState() });
    if (ret.kind !== 'consent') throw new Error('expected consent');
    const code = new URL((provider.decideConsent(ret.consentId, ret.csrf, true) as { url: string }).url).searchParams.get('code')!;
    const t1 = await provider.exchangeAuthorizationCode(CLIENT, code);
    expect(new OAuthStore({ file, ttlDays: 90, logger: silentLogger }).verifyAccess(t1.access_token)).toBeDefined();
    const t2 = await provider.exchangeRefreshToken(CLIENT, t1.refresh_token!);
    expect(new OAuthStore({ file, ttlDays: 90, logger: silentLogger }).refresh(CLIENT.client_id, t2.refresh_token!).access_token).toBeTruthy();
  });

  it('creates the grant only when the code is exchanged', async () => {
    const p = setup();
    const { ret } = await toConsent(p);
    if (ret.kind !== 'consent') throw new Error('expected consent');
    const code = new URL((p.provider.decideConsent(ret.consentId, ret.csrf, true) as { url: string }).url).searchParams.get('code')!;
    expect(p.store.grants()).toEqual([]);
    await p.provider.exchangeAuthorizationCode(CLIENT, code);
    expect(p.store.grants()).toHaveLength(1);
  });

  it('gives the grant the end date shown on the consent page, across midnight', async () => {
    vi.setSystemTime(new Date('2026-11-24T23:58:00Z'));
    const p = setup();
    const { ret } = await toConsent(p);
    if (ret.kind !== 'consent') throw new Error('expected consent');
    expect(ret.expiresOn).toBe('2027-02-22');
    const code = new URL((p.provider.decideConsent(ret.consentId, ret.csrf, true) as { url: string }).url).searchParams.get('code')!;
    vi.setSystemTime(new Date('2026-11-25T00:01:00Z'));
    await p.provider.exchangeAuthorizationCode(CLIENT, code);
    expect(p.store.grants()[0]!.expiresAt).toBe('2027-02-22T00:00:00.000Z');
  });

  it('refuses to approve for a client that is gone', async () => {
    const p = setup();
    const { ret } = await toConsent(p);
    if (ret.kind !== 'consent') throw new Error('expected consent');
    const spy = vi.spyOn(p.store, 'getClient').mockReturnValue(undefined);
    expect(p.provider.decideConsent(ret.consentId, ret.csrf, true)).toMatchObject({ kind: 'error', status: 400 });
    spy.mockRestore();
    expect(p.store.grants()).toEqual([]);
  });

  it('ignores revocation by another client', async () => {
    const p = setup();
    const { ret } = await toConsent(p);
    if (ret.kind !== 'consent') throw new Error('expected consent');
    const code = new URL((p.provider.decideConsent(ret.consentId, ret.csrf, true) as { url: string }).url).searchParams.get('code')!;
    const t = await p.provider.exchangeAuthorizationCode(CLIENT, code);
    await p.provider.revokeToken!({ ...CLIENT, client_id: 'other' }, { token: t.access_token });
    expect(p.store.grants()).toHaveLength(1);
  });

  it('never logs secrets', async () => {
    const p = setup();
    const secrets: string[] = [];
    const { ret } = await toConsent(p);
    if (ret.kind !== 'consent') throw new Error('expected consent');
    secrets.push(p.g.issued[0]!.state, p.g.issued[0]!.nonce, ret.consentId, ret.csrf);
    const code = new URL((p.provider.decideConsent(ret.consentId, ret.csrf, true) as { url: string }).url).searchParams.get('code')!;
    const t = await p.provider.exchangeAuthorizationCode(CLIENT, code);
    secrets.push(code, t.access_token, t.refresh_token!);
    p.g.setNext(new Error('Invalid token signature: eyJhbGciOiJSUzI1NiJ9.secret-id-token'));
    await toConsent(p);
    secrets.push('eyJhbGciOiJSUzI1NiJ9.secret-id-token');
    const logged = JSON.stringify(p.calls);
    expect(p.calls.length).toBeGreaterThan(2);
    for (const secret of secrets) expect(logged).not.toContain(secret);
    expect(logged).toContain('Invalid token signature');
  });

  it('signs in for the clients page, bound to the caller\'s binding', async () => {
    const p = setup();
    const s = p.provider.startSessionSignIn();
    expect(s.url).toMatch(/^https:\/\/google\.test\//);
    expect(s.binding).toBe(`${p.g.lastState()}.${p.g.issued.at(-1)!.nonce}.${Date.now()}`);
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), code: 'c' })).toMatchObject({ kind: 'error', status: 400 });
    expect(await p.provider.handleGoogleReturn({ state: 'other', code: 'c' }, s.binding)).toMatchObject({ kind: 'error', status: 400 });
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), code: 'c' }, s.binding)).toEqual({ kind: 'session', email: 'owner@example.com' });

    p.g.setNext({ email: 'intruder@example.com' });
    const s2 = p.provider.startSessionSignIn();
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), code: 'c' }, s2.binding)).toMatchObject({ kind: 'error', status: 403 });
    const s3 = p.provider.startSessionSignIn();
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), error: 'access_denied' }, s3.binding)).toMatchObject({ kind: 'error', status: 403 });
    p.g.setNext(new Error('Google is down'));
    const s4 = p.provider.startSessionSignIn();
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), code: 'c' }, s4.binding)).toMatchObject({ kind: 'error', status: 502 });
  });

  it('expires a clients-page sign-in after 5 minutes on the server', async () => {
    const p = setup();
    const s = p.provider.startSessionSignIn();
    vi.setSystemTime(new Date(Date.now() + 300_001));
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), code: 'c' }, s.binding)).toMatchObject({ kind: 'error', status: 400 });
    const forged = s.binding.replace(/\.\d+$/, '.notatime');
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), code: 'c' }, forged)).toMatchObject({ kind: 'error', status: 400 });
  });

  it('asks the limiter only before calling Google', async () => {
    const p = setup();
    let asked = 0;
    const deny = () => (asked++, false);
    expect(await p.provider.handleGoogleReturn({ state: 'bogus', code: 'c' }, undefined, deny)).toMatchObject({ status: 400 });
    expect(asked).toBe(0);
    const s = p.provider.startSessionSignIn();
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), code: 'c' }, s.binding, deny)).toMatchObject({ kind: 'error', status: 429 });
    expect(asked).toBe(1);
  });
});
