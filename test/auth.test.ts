import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueToken, TokenRegistry } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http.js';
import { silentLogger, type Logger } from '../src/logger.js';
import { tokenNotice } from '../src/tools/common.js';
import { fakeApi, makeService } from './helpers.js';

const GROK = 'grok-token-0123456789abcdef0123456789abcdef';
const CLAUDE = 'claude-token-0123456789abcdef0123456789abcd';

function recorder() {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const record = (level: string) => (msg: string, fields?: Record<string, unknown>) => void lines.push({ level, msg, fields });
  const logger: Logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
  return { lines, logger };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const registry = (tokens: { label: string; token: string; expiresOn?: string }[], opts: { autoExpire?: boolean; logger?: Logger } = {}) =>
  new TokenRegistry(tokens, { autoExpire: opts.autoExpire ?? true, logger: opts.logger ?? silentLogger });

describe('issueToken', () => {
  it('creates a random 64-hex token dated TTL days from today (UTC)', () => {
    const a = issueToken('grok', 90);
    const b = issueToken('grok', 90);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.expiresOn).toBe('2027-02-15');
    expect(a.entry).toBe(`grok:${a.token}:2027-02-15`);
    expect(issueToken('x', 30, Date.parse('2026-11-17T23:59:59Z')).expiresOn).toBe('2026-12-17');
  });

  it('round-trips through the config parser', () => {
    const t = issueToken('grok', 90);
    expect(loadConfig({ GOOGLE_APPLICATION_CREDENTIALS: 'k', MCP_AUTH_AUTO_EXPIRE: 'true', MCP_AUTH_TOKENS: t.entry }).authTokens).toEqual([
      { label: 'grok', token: t.token, expiresOn: '2027-02-15' },
    ]);
  });
});

describe('TokenRegistry without auto-expire', () => {
  it('never expires a token and says that dates are ignored', () => {
    const { lines, logger } = recorder();
    const r = registry([{ label: 'grok', token: GROK, expiresOn: '2026-01-01' }], { autoExpire: false, logger });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    expect(r.check(GROK)).toEqual({ kind: 'ok', client: { name: 'grok' } });
    expect(lines).toEqual([expect.objectContaining({ level: 'warn', msg: expect.stringMatching(/dates are ignored/), fields: { clients: ['grok'] } })]);
  });
});

describe('TokenRegistry with auto-expire', () => {
  it('ends a token at 00:00 UTC on its date, and at no other time', () => {
    const r = registry([{ label: 'grok', token: GROK, expiresOn: '2027-02-15' }]);
    expect(r.check(GROK)).toEqual({ kind: 'ok', client: { name: 'grok', expiresAt: '2027-02-15T00:00:00.000Z', daysLeft: 90 } });
    vi.setSystemTime(new Date('2027-02-14T23:59:59Z'));
    expect(r.check(GROK)).toMatchObject({ kind: 'ok', client: { daysLeft: 1 } });
    vi.setSystemTime(new Date('2027-02-15T00:00:00Z'));
    expect(r.check(GROK)).toEqual({ kind: 'expired', name: 'grok' });
    expect(r.check('wrong-token-0123456789abcdef0123456789abcdef')).toEqual({ kind: 'unknown' });
  });

  it('honours dates beyond the TTL as written', () => {
    expect(registry([{ label: 'grok', token: GROK, expiresOn: '2028-06-01' }]).clients()).toEqual([
      { name: 'grok', expiresAt: '2028-06-01T00:00:00.000Z', daysLeft: 562 },
    ]);
  });

  it('warns at startup and once a day per token in the last 14 days, and errors for expired ones', () => {
    const { lines, logger } = recorder();
    const r = registry(
      [
        { label: 'grok', token: GROK, expiresOn: '2026-11-27' },
        { label: 'old', token: CLAUDE, expiresOn: '2026-11-01' },
      ],
      { logger },
    );
    r.check(GROK);
    r.check(GROK);
    vi.setSystemTime(new Date('2026-11-18T09:00:00Z'));
    r.check(GROK);
    expect(lines.map((l) => [l.level, l.msg, l.fields])).toEqual([
      ['warn', 'token expires soon', { client: 'grok', expiresAt: '2026-11-27T00:00:00.000Z', daysLeft: 10 }], // startup covers the first day
      ['error', 'token expired', { client: 'old', expiresAt: '2026-11-01T00:00:00.000Z' }],
      ['warn', 'token expires soon', { client: 'grok', expiresAt: '2026-11-27T00:00:00.000Z', daysLeft: 9 }],
    ]);
  });
});

describe('tokenNotice', () => {
  it('speaks up only in the last 14 days', () => {
    expect(tokenNotice(undefined)).toBeUndefined();
    expect(tokenNotice({ name: 'grok' })).toBeUndefined();
    expect(tokenNotice({ name: 'grok', expiresAt: 'x', daysLeft: 15 })).toBeUndefined();
    expect(tokenNotice({ name: 'grok', expiresAt: '2026-11-23T00:00:00.000Z', daysLeft: 6 })).toMatch(/\(grok\) expires in 6 days, at 2026-11-23/);
    expect(tokenNotice({ name: 'grok', expiresAt: 'x', daysLeft: 1 })).toMatch(/within a day/);
  });
});

describe('expiry over HTTP', () => {
  it('rejects an expired token with a clear message and tells a client near expiry in every result', async () => {
    const { lines, logger } = recorder();
    const tokens = registry([
      { label: 'grok', token: GROK, expiresOn: '2026-11-23' },
      { label: 'old', token: CLAUDE, expiresOn: '2026-11-17' },
    ]);
    const app = createApp({ tokens, deps: { service: makeService(fakeApi()), logger: silentLogger, maxRowsPerCall: 25_000 }, logger });
    const s = app.listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;
    try {
      const expired = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${CLAUDE}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(expired.status).toBe(401);
      expect(expired.headers.get('www-authenticate')).toBe('Bearer error="invalid_token", error_description="The token has expired"');
      expect(await expired.json()).toMatchObject({ error: { message: expect.stringMatching(/expired/) } });
      expect(lines).toContainEqual(expect.objectContaining({ msg: 'unauthorized request', fields: { reason: 'expired token', client: 'old' } }));

      const client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${GROK}` } } }));
      const sites = await client.callTool({ name: 'list_sites', arguments: {} });
      expect(sites.structuredContent).toMatchObject({ count: 2, tokenNotice: expect.stringMatching(/\(grok\) expires in 6 days/) });
      const quota = await client.callTool({ name: 'get_quota_status', arguments: { siteUrls: ['sc-domain:example.org'] } });
      expect(quota.structuredContent).toMatchObject({ client: { name: 'grok', expiresAt: '2026-11-23T00:00:00.000Z', daysLeft: 6 } });
      await client.close();
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});
