import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('refresh rotates both tokens', () => {
    const { store, client, grant } = setup();
    const t1 = store.issueTokens(grant.id);
    const t2 = store.refresh(client.client_id, t1.refresh_token);
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect(t2.access_token).not.toBe(t1.access_token);
    expect(store.verifyAccess(t1.access_token)).toBeUndefined();
    expect(store.verifyAccess(t2.access_token)).toBeDefined();
  });

  it('reusing a refresh token revokes the grant', () => {
    const { logger, calls } = spyLogger();
    const { store, client, grant } = setup({ logger });
    const t1 = store.issueTokens(grant.id);
    const t2 = store.refresh(client.client_id, t1.refresh_token);
    expect(() => store.refresh(client.client_id, t1.refresh_token)).toThrow(InvalidGrantError);
    expect(store.grants()).toEqual([]);
    expect(store.verifyAccess(t2.access_token)).toBeUndefined();
    expect(() => store.refresh(client.client_id, t2.refresh_token)).toThrow(InvalidGrantError);
    expect(calls).toContainEqual(expect.objectContaining({ level: 'error', msg: 'refresh token reused' }));
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
    expect(store.revokeGrant('nope')).toBe(false);
    expect(store.revokeGrant(grant.id)).toBe(true);
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

  it('refuses registrations beyond 100 clients', () => {
    const store = new OAuthStore({ file, ttlDays: 90, logger: silentLogger });
    for (let i = 0; i < 100; i++) store.registerClient({ client_id: `c${i}`, redirect_uris: ['https://x/cb'] } as never);
    expect(() => store.registerClient({ client_id: 'c100', redirect_uris: ['https://x/cb'] } as never)).toThrow(InvalidClientMetadataError);
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

  it('works without a file', () => {
    const store = new OAuthStore({ ttlDays: 90, logger: silentLogger });
    store.registerClient({ client_id: 'c', redirect_uris: ['https://x/cb'] } as never);
    const g = store.createGrant({ clientId: 'c', clientName: 'x', email: 'o@x.dev', redirectHost: 'x' });
    expect(store.verifyAccess(store.issueTokens(g.id).access_token)).toBeDefined();
  });
});
