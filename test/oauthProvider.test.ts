import { InvalidGrantError, InvalidTokenError, TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logger.js';
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
    expect((await toConsent(p)).ret).toMatchObject({ kind: 'error', status: 400 });
    p.g.setNext(new Error('invalid_grant'));
    expect((await toConsent(p)).ret).toMatchObject({ kind: 'error', status: 400 });
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
    expect((await toConsent(p)).ret).toMatchObject({ kind: 'error', status: 400 });
  });

  it('logs a cancel at Google', async () => {
    const p = setup();
    const { res } = fakeRes();
    await p.provider.authorize(CLIENT, PARAMS, res);
    await p.provider.handleGoogleReturn({ state: p.g.lastState(), error: 'access_denied' });
    expect(p.calls).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'sign-in cancelled', fields: { reason: 'access_denied' } }));
  });

  it('caps sign-ins in progress', async () => {
    const p = setup();
    const { res } = fakeRes();
    for (let i = 0; i < 1000; i++) await p.provider.authorize(CLIENT, PARAMS, res);
    await expect(p.provider.authorize(CLIENT, PARAMS, res)).rejects.toThrow(TooManyRequestsError);
    vi.setSystemTime(new Date(Date.now() + 300_001));
    await expect(p.provider.authorize(CLIENT, PARAMS, res)).resolves.toBeUndefined();
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

  it('signs in for the clients page', async () => {
    const p = setup();
    expect(p.provider.startSessionSignIn()).toMatch(/^https:\/\/google\.test\//);
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), code: 'c' })).toEqual({ kind: 'session', email: 'owner@example.com' });

    p.g.setNext({ email: 'intruder@example.com' });
    p.provider.startSessionSignIn();
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), code: 'c' })).toMatchObject({ kind: 'error', status: 403 });
    p.provider.startSessionSignIn();
    expect(await p.provider.handleGoogleReturn({ state: p.g.lastState(), error: 'access_denied' })).toMatchObject({ kind: 'error', status: 403 });
  });
});
