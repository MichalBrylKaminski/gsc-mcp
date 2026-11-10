import { describe, expect, it } from 'vitest';
import { hostnameOnly, loadConfig } from '../src/config.js';

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
