import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidClientMetadataError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger } from '../src/logger.js';
import { OAuthStore } from '../src/oauth/store.js';

const NOW = '2026-11-24T15:00:00Z';
let dir: string;
let file: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  dir = mkdtempSync(join(tmpdir(), 'gsc-mcp-oauth-'));
  file = join(dir, 'oauth-state.json');
});
afterEach(() => vi.useRealTimers());

function spyLogger() {
  const calls: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => calls.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => calls.push({ level: 'error', msg, fields }),
  };
  return { logger, calls };
}

function setup(opts: { logger?: Logger; file?: string } = {}) {
  const store = new OAuthStore({ file: opts.file ?? file, ttlDays: 90, logger: opts.logger ?? silentLogger });
  const client = store.registerClient({ client_id: 'client-1', redirect_uris: ['https://grok.example/cb'], client_name: 'Grok' } as never);
  const grant = store.createGrant({ clientId: client.client_id, clientName: 'Grok', email: 'owner@example.com', redirectHost: 'grok.example' });
  return { store, client, grant };
}

describe('OAuthStore grants', () => {
  it('grant expires at 00:00 UTC on approval day + TTL', () => {
    const { grant } = setup();
    expect(grant.expiresAt).toBe('2027-02-22T00:00:00.000Z');
    expect(grant.createdAt).toBe('2026-11-24T15:00:00.000Z');
  });

  it('access token works for an hour, capped at grant expiry', () => {
    const { store, grant } = setup();
    const t = store.issueTokens(grant.id);
    expect(t).toMatchObject({ token_type: 'bearer', expires_in: 3600 });
    expect(store.verifyAccess(t.access_token)).toMatchObject({ signIn: true, expiresAt: '2027-02-22T00:00:00.000Z', daysLeft: 90 });
    vi.setSystemTime(new Date(Date.parse(NOW) + 3_600_000));
    expect(store.verifyAccess(t.access_token)).toBeUndefined();

    vi.setSystemTime(new Date('2027-02-21T23:30:00Z'));
    expect(store.issueTokens(grant.id).expires_in).toBe(1800);
  });

  it('refresh rotates the refresh token; earlier access tokens last until their own expiry', () => {
    const { store, client, grant } = setup();
    const t1 = store.issueTokens(grant.id);
    vi.setSystemTime(new Date(Date.parse(NOW) + 1_800_000));
    const t2 = store.refresh(client.client_id, t1.refresh_token);
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect(t2.access_token).not.toBe(t1.access_token);
    expect(store.verifyAccess(t1.access_token)).toBeDefined();
    expect(store.verifyAccess(t2.access_token)).toBeDefined();
    vi.setSystemTime(new Date(Date.parse(NOW) + 3_600_000));
    expect(store.verifyAccess(t1.access_token)).toBeUndefined();
    expect(store.verifyAccess(t2.access_token)).toBeDefined();
  });

  it('reusing a refresh token revokes the grant', () => {
    const { logger, calls } = spyLogger();
    const { store, client, grant } = setup({ logger });
    const t1 = store.issueTokens(grant.id);
    const t2 = store.refresh(client.client_id, t1.refresh_token);
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    expect(() => store.refresh(client.client_id, t1.refresh_token)).toThrow(InvalidGrantError);
    expect(store.grants()).toEqual([]);
    expect(store.verifyAccess(t1.access_token)).toBeUndefined();
    expect(store.verifyAccess(t2.access_token)).toBeUndefined();
    expect(() => store.refresh(client.client_id, t2.refresh_token)).toThrow(InvalidGrantError);
    expect(calls).toContainEqual(expect.objectContaining({ level: 'error', msg: 'refresh token reused' }));
  });

  it('parallel refreshes with one token within 60 s all get working pairs', () => {
    const { logger, calls } = spyLogger();
    const { store, client, grant } = setup({ logger });
    const t1 = store.issueTokens(grant.id);
    const pairs = [store.refresh(client.client_id, t1.refresh_token)];
    vi.setSystemTime(new Date(Date.parse(NOW) + 59_000));
    pairs.push(store.refresh(client.client_id, t1.refresh_token), store.refresh(client.client_id, t1.refresh_token));
    expect(store.grants()).toHaveLength(1);
    for (const p of pairs) expect(store.verifyAccess(p.access_token)).toBeDefined();
    expect(calls).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'refresh token presented again within the grace period; issued another pair' }));
    expect(calls.filter((c) => c.level === 'error')).toEqual([]);
    // Whichever pair the client kept can be refreshed.
    for (const kept of pairs) {
      const again = setup({ file: join(dir, `kept-${pairs.indexOf(kept)}.json`) });
      const u1 = again.store.issueTokens(again.grant.id);
      const us = [0, 1, 2].map(() => again.store.refresh(again.client.client_id, u1.refresh_token));
      expect(again.store.refresh(again.client.client_id, us[pairs.indexOf(kept)]!.refresh_token).access_token).toBeTruthy();
      expect(again.store.grants()).toHaveLength(1);
    }
  });

  it('no grace after 60 s', () => {
    const { store, client, grant } = setup();
    const t1 = store.issueTokens(grant.id);
    store.refresh(client.client_id, t1.refresh_token);
    vi.setSystemTime(new Date(Date.parse(NOW) + 30_000));
    store.refresh(client.client_id, t1.refresh_token);
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    expect(() => store.refresh(client.client_id, t1.refresh_token)).toThrow(InvalidGrantError);
    expect(store.grants()).toEqual([]);
  });

  it('a thief who takes a grace pair is caught by whichever of the two refreshes second', () => {
    for (const thiefFirst of [false, true]) {
      const { logger, calls } = spyLogger();
      const { store, client, grant } = setup({ logger, file: join(dir, `thief-${thiefFirst}.json`) });
      const t1 = store.issueTokens(grant.id); // copied by a thief
      const real = store.refresh(client.client_id, t1.refresh_token);
      const stolen = store.refresh(client.client_id, t1.refresh_token); // thief, within 60 s
      vi.setSystemTime(new Date(Date.parse(NOW) + 3_000_000));
      const [first, second] = thiefFirst ? [stolen, real] : [real, stolen];
      store.refresh(client.client_id, first.refresh_token);
      expect(() => store.refresh(client.client_id, second.refresh_token)).toThrow(InvalidGrantError);
      expect(store.grants()).toEqual([]);
      expect(store.verifyAccess(stolen.access_token)).toBeUndefined();
      expect(calls).toContainEqual(expect.objectContaining({ level: 'error', msg: 'refresh token reused' }));
      vi.setSystemTime(new Date(NOW));
    }
  });

  it('keeps at most 10 live tokens per grant', () => {
    const { store, client, grant } = setup();
    const t1 = store.issueTokens(grant.id);
    const pairs = Array.from({ length: 12 }, () => store.refresh(client.client_id, t1.refresh_token));
    // 13 access tokens were issued (t1 and 12 pairs): the oldest 3 are gone.
    for (const t of [t1, pairs[0]!, pairs[1]!]) expect(store.verifyAccess(t.access_token)).toBeUndefined();
    for (const t of [pairs[2]!, pairs[11]!]) expect(store.verifyAccess(t.access_token)).toBeDefined();
    expect(store.refresh(client.client_id, pairs[2]!.refresh_token).access_token).toBeTruthy();
  });

  it('a repeat after the grant ended is not reported as theft', () => {
    const { logger, calls } = spyLogger();
    vi.setSystemTime(new Date('2027-02-21T23:59:50Z'));
    const { store, client } = setup({ logger });
    const grant = store.createGrant({ clientId: client.client_id, clientName: 'Grok', email: 'o@x.dev', redirectHost: 'x', expiresOn: '2027-02-22' });
    const t1 = store.issueTokens(grant.id);
    store.refresh(client.client_id, t1.refresh_token);
    vi.setSystemTime(new Date('2027-02-22T00:00:05Z'));
    expect(() => store.refresh(client.client_id, t1.refresh_token)).toThrow(/sign-in has ended/);
    expect(calls.filter((c) => c.level === 'error')).toEqual([]);
  });

  it('no grace for an older refresh token or another client', () => {
    const { store, client, grant } = setup();
    const t1 = store.issueTokens(grant.id);
    const t2 = store.refresh(client.client_id, t1.refresh_token);
    store.refresh(client.client_id, t2.refresh_token);
    expect(() => store.refresh(client.client_id, t1.refresh_token)).toThrow(InvalidGrantError);
    expect(store.grants()).toEqual([]);

    const again = setup({ file: join(dir, 'other.json') });
    const u1 = again.store.issueTokens(again.grant.id);
    again.store.refresh(again.client.client_id, u1.refresh_token);
    expect(() => again.store.refresh('someone-else', u1.refresh_token)).toThrow(InvalidGrantError);
    expect(again.store.grants()).toEqual([]);
  });

  it('lists only live grants', () => {
    const { store } = setup();
    vi.setSystemTime(new Date('2027-02-22T00:00:00Z'));
    expect(store.grants()).toEqual([]);
  });

  it('refresh by another client or after grant expiry fails', () => {
    const { store, client, grant } = setup();
    const t = store.issueTokens(grant.id);
    expect(() => store.refresh('someone-else', t.refresh_token)).toThrow(InvalidGrantError);
    vi.setSystemTime(new Date('2027-02-22T00:00:00Z'));
    expect(() => store.refresh(client.client_id, t.refresh_token)).toThrow(InvalidGrantError);
    expect(() => store.refresh(client.client_id, 'never-issued')).toThrow(InvalidGrantError);
  });

  it('labels and sanitizes the client name', () => {
    const store = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    store.registerClient({ client_id: 'c', redirect_uris: ['https://x/cb'] } as never);
    const grant = store.createGrant({ clientId: 'c', clientName: 'Gr\u0000ok\n' + 'x'.repeat(100), email: 'o@x.dev', redirectHost: 'x' });
    expect(grant.clientName).toBe('Grok' + 'x'.repeat(60));
    const info = store.verifyAccess(store.issueTokens(grant.id).access_token);
    expect(info?.name).toMatch(/^oauth:Grokx{60}#[0-9a-f]{6}$/);
    expect(info?.name.endsWith(`#${grant.id.slice(0, 6)}`)).toBe(true);
    const blank = store.createGrant({ clientId: 'c', clientName: ' \u0007 ', email: 'o@x.dev', redirectHost: 'x' });
    expect(blank.clientName).toBe('client');
  });

  it('revokeToken revokes the whole grant, by access or refresh token', () => {
    const { store, grant } = setup();
    const t = store.issueTokens(grant.id);
    store.revokeToken(t.access_token);
    expect(store.grants()).toEqual([]);
    expect(() => store.revokeToken('unknown')).not.toThrow();

    const g2 = store.createGrant({ clientId: 'client-1', clientName: 'Grok', email: 'o@x.dev', redirectHost: 'x' });
    const t2 = store.issueTokens(g2.id);
    store.revokeToken(t2.refresh_token);
    expect(store.verifyAccess(t2.access_token)).toBeUndefined();
  });

  it('revokeGrant and revokeAll', () => {
    const { store, grant } = setup();
    store.createGrant({ clientId: 'client-1', clientName: 'Grok', email: 'o@x.dev', redirectHost: 'x' });
    expect(store.revokeGrant('nope')).toBeUndefined();
    expect(store.revokeGrant(grant.id)).toMatchObject({ id: grant.id, clientName: 'Grok' });
    expect(store.grants()).toHaveLength(1);
    expect(store.revokeAll()).toBe(1);
    expect(store.grants()).toEqual([]);
  });

  it('records last use', () => {
    const { store, grant } = setup();
    const t = store.issueTokens(grant.id);
    expect(store.grants()[0]!.lastUsedAt).toBeUndefined();
    vi.setSystemTime(new Date('2026-11-24T15:10:00Z'));
    store.verifyAccess(t.access_token);
    expect(store.grants()[0]!.lastUsedAt).toBe('2026-11-24T15:10:00.000Z');
  });

  it('warns once per UTC day near expiry', () => {
    const { logger, calls } = spyLogger();
    const { store, grant } = setup({ logger });
    vi.setSystemTime(new Date('2027-02-12T08:00:00Z'));
    const t = store.issueTokens(grant.id);
    store.verifyAccess(t.access_token);
    store.verifyAccess(t.access_token);
    const warnings = () => calls.filter((c) => c.msg === 'sign-in expires soon');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]!.fields).toMatchObject({ expiresAt: '2027-02-22T00:00:00.000Z', daysLeft: 10 });
    vi.setSystemTime(new Date('2027-02-13T08:00:00Z'));
    store.verifyAccess(store.issueTokens(grant.id).access_token);
    expect(warnings()).toHaveLength(2);
  });
});

describe('OAuthStore clients', () => {
  it('prune drops unused clients after 24 h and expired grants', () => {
    const { store } = setup();
    store.registerClient({ client_id: 'unused', redirect_uris: ['https://x/cb'] } as never);
    vi.setSystemTime(new Date(Date.parse(NOW) + 86_400_001));
    store.prune();
    expect(store.getClient('unused')).toBeUndefined();
    expect(store.getClient('client-1')).toBeDefined(); // it has a grant

    vi.setSystemTime(new Date('2027-02-22T00:00:00Z'));
    store.prune();
    expect(store.grants()).toEqual([]);
    expect(store.getClient('client-1')).toBeUndefined();
  });

  it('makes room at 100 clients by forgetting the oldest one without a grant', () => {
    const store = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    for (let i = 0; i < 100; i++) {
      vi.setSystemTime(new Date(Date.parse(NOW) + i * 1000));
      store.registerClient({ client_id: `c${i}`, redirect_uris: ['https://x/cb'] } as never);
    }
    store.createGrant({ clientId: 'c0', clientName: 'kept', email: 'o@x.dev', redirectHost: 'x' });
    vi.setSystemTime(new Date(Date.parse(NOW) + 1_000_000));
    store.registerClient({ client_id: 'c100', redirect_uris: ['https://x/cb'] } as never);
    expect(store.getClient('c0')).toBeDefined(); // has a grant
    expect(store.getClient('c1')).toBeUndefined(); // oldest without one
    expect(store.getClient('c100')).toBeDefined();
  });

  it('never drops a client registered in the last 15 minutes, which may be mid-sign-in', () => {
    const store = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    for (let i = 0; i < 100; i++) store.registerClient({ client_id: `c${i}`, redirect_uris: ['https://x/cb'] } as never);
    vi.setSystemTime(new Date(Date.parse(NOW) + 899_000));
    expect(() => store.registerClient({ client_id: 'c100', redirect_uris: ['https://x/cb'] } as never)).toThrow(/last few minutes/);
    expect(store.getClient('c0')).toBeDefined();
  });

  it('refuses a registration only when every client has a grant', () => {
    const store = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    for (let i = 0; i < 100; i++) {
      store.registerClient({ client_id: `c${i}`, redirect_uris: ['https://x/cb'] } as never);
      store.createGrant({ clientId: `c${i}`, clientName: 'x', email: 'o@x.dev', redirectHost: 'x' });
    }
    expect(() => store.registerClient({ client_id: 'c100', redirect_uris: ['https://x/cb'] } as never)).toThrow(InvalidClientMetadataError);
  });

  it('keeps only the latest 100 used refresh tokens per grant', () => {
    const { store, client, grant } = setup();
    let t = store.issueTokens(grant.id);
    const first = t.refresh_token;
    for (let i = 0; i < 101; i++) t = store.refresh(client.client_id, t.refresh_token);
    expect(() => store.refresh(client.client_id, first)).toThrow(InvalidGrantError); // too old to be recognised as reuse...
    expect(store.grants()).toHaveLength(1); // ...so the grant stays
  });

  it('frees a slot by pruning once the limit is reached', () => {
    const store = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    for (let i = 0; i < 100; i++) store.registerClient({ client_id: `c${i}`, redirect_uris: ['https://x/cb'] } as never);
    vi.setSystemTime(new Date(Date.parse(NOW) + 86_400_001));
    expect(store.registerClient({ client_id: 'late', redirect_uris: ['https://x/cb'] } as never).client_id).toBe('late');
    expect(store.getClient('c0')).toBeUndefined();
  });

  it('makes every client public and never stores a secret', async () => {
    const store = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    const c = store.registerClient({
      client_id: 'conf',
      client_secret: 'super-secret-value',
      client_secret_expires_at: 0,
      redirect_uris: ['https://x/cb'],
      client_name: 'Grok',
      jwks: { keys: ['x'.repeat(10_000)] },
      logo_uri: 'https://x/logo.png',
    } as never);
    expect(c).not.toHaveProperty('client_secret');
    expect(c).not.toHaveProperty('jwks');
    expect(c).toMatchObject({ client_id: 'conf', token_endpoint_auth_method: 'none', client_name: 'Grok', redirect_uris: ['https://x/cb'] });
    expect(store.getClient('conf')).toEqual(c);
    await store.flush();
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('super-secret-value');
    expect(text).not.toContain('logo.png');
  });

  it('rejects unusable redirect URIs at registration', () => {
    const store = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    expect(() => store.registerClient({ client_id: 'a', redirect_uris: [] } as never)).toThrow(InvalidClientMetadataError);
    expect(() => store.registerClient({ client_id: 'b', redirect_uris: Array(11).fill('https://x/cb') } as never)).toThrow(InvalidClientMetadataError);
    expect(() => store.registerClient({ client_id: 'c', redirect_uris: [`https://x/${'a'.repeat(3000)}`] } as never)).toThrow(InvalidClientMetadataError);
  });

  it('assigns a client id when none is given', () => {
    const store = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    const c = store.registerClient({ redirect_uris: ['https://x/cb'] } as never);
    expect(c.client_id).toMatch(/.{16,}/);
    expect(store.getClient(c.client_id)).toEqual(c);
  });
});

describe('OAuthStore persistence', () => {
  it('stores hashes only', async () => {
    const { store, grant } = setup();
    const t = store.issueTokens(grant.id);
    await store.flush();
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(t.access_token);
    expect(text).not.toContain(t.refresh_token);
    expect(text).toContain(grant.id);
  });

  it('survives a restart', async () => {
    const { store, client, grant } = setup();
    const t = store.issueTokens(grant.id);
    await store.flush();
    const again = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    expect(again.verifyAccess(t.access_token)).toBeDefined();
    expect(again.refresh(client.client_id, t.refresh_token).access_token).toBeTruthy();
    expect(again.getClient(client.client_id)).toBeDefined();
  });

  it('keeps reuse detection across a restart', async () => {
    const { store, client, grant } = setup();
    const t1 = store.issueTokens(grant.id);
    store.refresh(client.client_id, t1.refresh_token);
    await store.flush();
    const again = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    expect(() => again.refresh(client.client_id, t1.refresh_token)).toThrow(InvalidGrantError);
    expect(again.grants()).toEqual([]);
  });

  it('saves the last use when flushed', async () => {
    const { store, grant } = setup();
    const t = store.issueTokens(grant.id);
    await store.flush();
    vi.setSystemTime(new Date('2026-11-24T15:10:00Z'));
    store.verifyAccess(t.access_token);
    await store.flush();
    const again = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    expect(again.grants()[0]!.lastUsedAt).toBe('2026-11-24T15:10:00.000Z');
  });

  it('sets a corrupt file aside', () => {
    writeFileSync(file, '{oops');
    const { logger, calls } = spyLogger();
    const store = new OAuthStore({ file, ttlDays: 90, logger });
    expect(store.grants()).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.startsWith('oauth-state.json.corrupt-'))).toHaveLength(1);
    expect(calls).toContainEqual(expect.objectContaining({ level: 'error' }));
  });

  it('sets aside JSON in an unexpected format', () => {
    writeFileSync(file, '{"version":2}');
    const { logger, calls } = spyLogger();
    new OAuthStore({ file, ttlDays: 90, logger });
    expect(readdirSync(dir).filter((f) => f.startsWith('oauth-state.json.corrupt-'))).toHaveLength(1);
    expect(calls).toContainEqual(expect.objectContaining({ level: 'error', msg: 'OAuth state is corrupt; set aside, starting fresh' }));
  });

  it('refuses to start when the file exists but cannot be read', () => {
    mkdirSync(file); // reading a directory fails with EISDIR, like a permissions error would
    expect(() => new OAuthStore({ file, ttlDays: 90, logger: silentLogger })).toThrow(/OAuth state .* exists but can't be read/);
    expect(readdirSync(dir)).toEqual(['oauth-state.json']);
  });

  it('prunes on its own once a day', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2027-02-20T12:00:00Z'));
    const { store } = setup();
    store.createGrant({ clientId: 'client-1', clientName: 'Short', email: 'o@x.dev', redirectHost: 'x', expiresOn: '2027-02-21' });
    vi.advanceTimersByTime(86_400_000);
    expect(store.grants().map((g) => g.clientName)).toEqual(['Grok']);
    expect((store as unknown as { grantsById: Map<string, unknown> }).grantsById.size).toBe(1);
    store.close();
  });

  it('drops malformed entries and keeps good ones', async () => {
    const { store, grant } = setup();
    const t = store.issueTokens(grant.id);
    await store.flush();
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.clients.push(null, { client_id: 'no-time', redirect_uris: [] });
    state.grants.push(null, { ...state.grants[0], id: 'no-expiry', expiresAt: undefined }, { ...state.grants[0], id: 'bad-time', createdAt: 'yesterday' });
    writeFileSync(file, JSON.stringify(state));
    const { logger, calls } = spyLogger();
    const again = new OAuthStore({ file, ttlDays: 90, logger });
    expect(again.grants().map((g) => g.id)).toEqual([grant.id]);
    expect(again.verifyAccess(t.access_token)).toBeDefined();
    expect(again.getClient('no-time')).toBeUndefined();
    expect(calls).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'dropped malformed OAuth state entries', fields: expect.objectContaining({ dropped: 5 }) }));
  });

  it('works without a file', () => {
    const store = new OAuthStore({ ttlDays: 90, logger: silentLogger });
    store.registerClient({ client_id: 'c', redirect_uris: ['https://x/cb'] } as never);
    const g = store.createGrant({ clientId: 'c', clientName: 'x', email: 'o@x.dev', redirectHost: 'x' });
    expect(store.verifyAccess(store.issueTokens(g.id).access_token)).toBeDefined();
  });
});
