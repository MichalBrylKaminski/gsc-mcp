import { describe, expect, it } from 'vitest';
import { hostnameOnly, loadConfig, tokenFingerprint } from '../src/config.js';

const base = { MCP_AUTH_TOKEN: 'x'.repeat(32), GOOGLE_APPLICATION_CREDENTIALS: 'key.json' };

describe('MCP_PATH', () => {
  it('defaults to /mcp and accepts a custom path', () => {
    expect(loadConfig(base).MCP_PATH).toBe('/mcp');
    expect(loadConfig({ ...base, MCP_PATH: '/gsc-mcp' }).MCP_PATH).toBe('/gsc-mcp');
  });

  it('rejects malformed paths', () => {
    for (const bad of ['gsc-mcp', '/gsc-mcp/', '/', '/healthz', 'https://x/y']) {
      expect(() => loadConfig({ ...base, MCP_PATH: bad }), bad).toThrow(/MCP_PATH/);
    }
  });
});

describe('ALLOWED_HOSTS', () => {
  it('normalizes entries the way the SDK parses Host headers', () => {
    expect(hostnameOnly('LOCALHOST:443')).toBe('localhost');
    expect(hostnameOnly('bücher.de')).toBe('xn--bcher-kva.de');
    expect(hostnameOnly('::1')).toBe('[::1]');
    expect(hostnameOnly('[::1]:3000')).toBe('[::1]');
    expect(hostnameOnly('127.0.0.1')).toBe('127.0.0.1');
  });

  it('rejects URLs and paths with a clear message', () => {
    expect(hostnameOnly('https://gsc.example.com')).toBeUndefined();
    expect(hostnameOnly('gsc.example.com/mcp')).toBeUndefined();
    expect(() => loadConfig({ ...base, ALLOWED_HOSTS: 'ok.example.com, https://gsc.example.com' })).toThrow(/not a hostname/);
    expect(loadConfig({ ...base, ALLOWED_HOSTS: 'Gsc.Example.com:443' }).ALLOWED_HOSTS).toEqual(['gsc.example.com']);
  });
});

describe('auth tokens', () => {
  const a = 'a'.repeat(32);
  const b = 'b'.repeat(64);
  const { GOOGLE_APPLICATION_CREDENTIALS } = base;

  it('labels MCP_AUTH_TOKEN by a short hash, never the token itself', () => {
    const [t] = loadConfig({ GOOGLE_APPLICATION_CREDENTIALS, MCP_AUTH_TOKEN: a }).authTokens;
    expect(t).toEqual({ label: tokenFingerprint(a), token: a });
    expect(t!.label).toMatch(/^sha256:[0-9a-f]{8}$/);
    expect(a).not.toContain(t!.label.slice(7));
  });

  it('combines MCP_AUTH_TOKEN with named and bare MCP_AUTH_TOKENS entries', () => {
    const c = loadConfig({ GOOGLE_APPLICATION_CREDENTIALS, MCP_AUTH_TOKEN: a, MCP_AUTH_TOKENS: ` grok:${b} , ${'c'.repeat(40)}` });
    expect(c.authTokens).toEqual([
      { label: tokenFingerprint(a), token: a },
      { label: 'grok', token: b },
      { label: tokenFingerprint('c'.repeat(40)), token: 'c'.repeat(40) },
    ]);
  });

  it('works with MCP_AUTH_TOKENS alone', () => {
    expect(loadConfig({ GOOGLE_APPLICATION_CREDENTIALS, MCP_AUTH_TOKENS: `grok:${a},claude-code:${b}` }).authTokens.map((t) => t.label)).toEqual(['grok', 'claude-code']);
  });

  it('rejects missing, short, duplicate and same-name tokens', () => {
    expect(() => loadConfig({ GOOGLE_APPLICATION_CREDENTIALS })).toThrow(/MCP_AUTH_TOKEN: set MCP_AUTH_TOKEN or MCP_AUTH_TOKENS/);
    expect(() => loadConfig({ GOOGLE_APPLICATION_CREDENTIALS, MCP_AUTH_TOKEN: 'short' })).toThrow(/MCP_AUTH_TOKEN: every token must be at least 32/);
    expect(() => loadConfig({ GOOGLE_APPLICATION_CREDENTIALS, MCP_AUTH_TOKEN: a, MCP_AUTH_TOKENS: `grok:short` })).toThrow(/MCP_AUTH_TOKENS: every token/);
    expect(() => loadConfig({ GOOGLE_APPLICATION_CREDENTIALS, MCP_AUTH_TOKEN: a, MCP_AUTH_TOKENS: `grok:${a}` })).toThrow(/listed twice/);
    expect(() => loadConfig({ GOOGLE_APPLICATION_CREDENTIALS, MCP_AUTH_TOKENS: `grok:${a},grok:${b}` })).toThrow(/"grok" is used twice/);
  });
});

describe('token expiry settings', () => {
  const { GOOGLE_APPLICATION_CREDENTIALS } = base;
  const a = 'a'.repeat(32);

  it('is off by default with a 90-day TTL', () => {
    expect(loadConfig(base)).toMatchObject({ MCP_AUTH_AUTO_EXPIRE: false, MCP_AUTH_TOKEN_TTL_DAYS: 90 });
    expect(loadConfig({ GOOGLE_APPLICATION_CREDENTIALS, MCP_AUTH_TOKEN: `${a}:2027-01-31`, MCP_AUTH_AUTO_EXPIRE: 'true', MCP_AUTH_TOKEN_TTL_DAYS: '30' })).toMatchObject({
      MCP_AUTH_AUTO_EXPIRE: true,
      MCP_AUTH_TOKEN_TTL_DAYS: 30,
    });
  });

  it('requires a date on every token when auto-expire is on', () => {
    expect(() => loadConfig({ GOOGLE_APPLICATION_CREDENTIALS, MCP_AUTH_AUTO_EXPIRE: 'true', MCP_AUTH_TOKENS: `grok:${a}:2027-01-31,claude:${'b'.repeat(32)}` })).toThrow(
      /MCP_AUTH_AUTO_EXPIRE: .*missing for claude/,
    );
  });

  it('keeps the TTL between 30 and 365 days', () => {
    expect(() => loadConfig({ ...base, MCP_AUTH_TOKEN_TTL_DAYS: '29' })).toThrow(/at least 30/);
    expect(() => loadConfig({ ...base, MCP_AUTH_TOKEN_TTL_DAYS: '366' })).toThrow(/at most 365/);
    expect(loadConfig({ ...base, MCP_AUTH_TOKEN_TTL_DAYS: '365' }).MCP_AUTH_TOKEN_TTL_DAYS).toBe(365);
  });

  it('reads an optional date at the end of each token', () => {
    const c = loadConfig({ GOOGLE_APPLICATION_CREDENTIALS, MCP_AUTH_TOKEN: `${a}:2027-01-31`, MCP_AUTH_TOKENS: `grok:${'b'.repeat(32)}:2027-02-15,claude:${'c'.repeat(32)}` });
    expect(c.authTokens).toEqual([
      { label: tokenFingerprint(a), token: a, expiresOn: '2027-01-31' },
      { label: 'grok', token: 'b'.repeat(32), expiresOn: '2027-02-15' },
      { label: 'claude', token: 'c'.repeat(32) },
    ]);
    expect(() => loadConfig({ GOOGLE_APPLICATION_CREDENTIALS, MCP_AUTH_TOKENS: `grok:${a}:2027-02-30` })).toThrow(/not a real date/);
  });
});

describe('OAuth settings', () => {
  const oauthEnv = {
    MCP_PUBLIC_URL: 'https://saturn.brylex-it.dev/',
    GOOGLE_OAUTH_CLIENT_ID: 'id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
    MCP_OAUTH_ALLOWED_EMAILS: ' Owner@Example.com ,b@x.dev',
  };

  it('is off when none of the four are set', () => {
    expect(loadConfig(base).oauth).toBeUndefined();
  });

  it('turns on with all four', () => {
    const { oauth } = loadConfig({ ...base, ...oauthEnv });
    expect(oauth?.publicUrl.href).toBe('https://saturn.brylex-it.dev/');
    expect(oauth?.googleClientId).toBe('id');
    expect(oauth?.googleClientSecret).toBe('secret');
    expect(oauth?.allowedEmails).toEqual(['owner@example.com', 'b@x.dev']);
  });

  it('rejects a partial set', () => {
    expect(() => loadConfig({ ...base, MCP_PUBLIC_URL: oauthEnv.MCP_PUBLIC_URL })).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
    expect(() => loadConfig({ ...base, ...oauthEnv, MCP_OAUTH_ALLOWED_EMAILS: ' , ' })).toThrow(/MCP_OAUTH_ALLOWED_EMAILS/);
  });

  it('rejects a public URL with a path, query or http on a public host', () => {
    for (const bad of ['https://x.dev/gsc', 'https://x.dev/?a=1', 'https://x.dev/#a', 'http://x.dev', 'not a url']) {
      expect(() => loadConfig({ ...base, ...oauthEnv, MCP_PUBLIC_URL: bad }), bad).toThrow(/MCP_PUBLIC_URL/);
    }
    expect(loadConfig({ ...base, ...oauthEnv, MCP_PUBLIC_URL: 'http://localhost:3000' }).oauth?.publicUrl.href).toBe('http://localhost:3000/');
    expect(loadConfig({ ...base, ...oauthEnv, MCP_PUBLIC_URL: 'http://127.0.0.1:3000' }).oauth?.publicUrl.href).toBe('http://127.0.0.1:3000/');
  });

  it('makes fixed tokens optional with OAuth on', () => {
    const { MCP_AUTH_TOKEN: _t, ...noToken } = base;
    expect(loadConfig({ ...noToken, ...oauthEnv }).authTokens).toEqual([]);
    expect(() => loadConfig(noToken)).toThrow(/set MCP_AUTH_TOKEN or MCP_AUTH_TOKENS/);
  });

  it('parses TRUST_PROXY', () => {
    expect(loadConfig(base).TRUST_PROXY).toBeUndefined();
    expect(loadConfig({ ...base, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'x' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: '11' })).toThrow(/TRUST_PROXY/);
  });
});
