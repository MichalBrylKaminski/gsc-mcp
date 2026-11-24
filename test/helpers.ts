import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import { createApp } from '../src/http.js';
import type { GoogleIdentity, GoogleSignIn } from '../src/oauth/google.js';
import { GscOAuthProvider } from '../src/oauth/provider.js';
import { oauthRouter, resourceMetadataUrl } from '../src/oauth/routes.js';
import { OAuthStore } from '../src/oauth/store.js';
import { TokenRegistry, type TokenRegistryOptions } from '../src/auth.js';
import type { AuthToken } from '../src/config.js';
import type { GscApi } from '../src/google/client.js';
import { GscService, type GscServiceOptions } from '../src/google/service.js';
import { silentLogger, type Logger } from '../src/logger.js';

export function fakeApi(overrides: Partial<GscApi> = {}): GscApi {
  return {
    listSites: async () => [
      { siteUrl: 'https://www.example.com/', permissionLevel: 'siteRestrictedUser' },
      { siteUrl: 'sc-domain:example.org', permissionLevel: 'siteFullUser' },
    ],
    getSite: async (siteUrl) => ({ siteUrl, permissionLevel: 'siteFullUser' }),
    listSitemaps: async () => [],
    getSitemap: async (_siteUrl, feedpath) => ({ path: feedpath }),
    querySearchAnalytics: async () => ({ rows: [] }),
    inspectUrl: async () => ({ indexStatusResult: { verdict: 'PASS' } }),
    ...overrides,
  };
}

export function makeService(api: GscApi, opts: Partial<GscServiceOptions> = {}): GscService {
  return new GscService(api, {
    serviceAccountEmail: 'bot@project.iam.gserviceaccount.com',
    safetyFactor: 1,
    maxQueueWaitMs: 0,
    maxConcurrency: 4,
    cacheEnabled: true,
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
    logger: silentLogger,
    ...opts,
  });
}

/** Mimics a gaxios error from the googleapis client. */
export function googleError(status: number, reason?: string, message = 'error', headers: Record<string, string> = {}) {
  return Object.assign(new Error(message), {
    status,
    response: { status, headers: new Headers(headers), data: { error: { code: status, message, errors: reason ? [{ reason, message }] : [] } } },
  });
}

/** Accepted tokens for createApp; auto-expire is off unless opts turn it on. */
export function tokenRegistry(tokens: AuthToken[], opts: Partial<TokenRegistryOptions> = {}): TokenRegistry {
  return new TokenRegistry(tokens, { autoExpire: false, logger: silentLogger, ...opts });
}

/**
 * Google stand-in: authUrl records state and nonce; verify returns the queued
 * identity with the nonce of the most recent sign-in, so tests must finish one
 * sign-in before starting the next.
 */
export function fakeGoogle() {
  const issued: { state: string; nonce: string }[] = [];
  let next: Partial<GoogleIdentity> | Error = { email: 'owner@example.com', emailVerified: true };
  const google: GoogleSignIn = {
    authUrl(state, nonce) {
      issued.push({ state, nonce });
      return `https://google.test/auth?state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}`;
    },
    async verify() {
      if (next instanceof Error) throw next;
      return { email: 'owner@example.com', emailVerified: true, nonce: issued.at(-1)?.nonce, ...next };
    },
  };
  return { google, issued, setNext: (n: Partial<GoogleIdentity> | Error) => (next = n), lastState: () => issued.at(-1)!.state };
}

/** The fixed token accepted by startOAuthApp, named "test". */
export const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

/** An app on a real port with OAuth on, whose issuer is its own address. */
export async function startOAuthApp(opts: { allowedEmails?: string[]; logger?: Logger } = {}) {
  const g = fakeGoogle();
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const publicUrl = new URL(base);
  const store = new OAuthStore({ ttlDays: 90, logger: opts.logger ?? silentLogger });
  const provider = new GscOAuthProvider({ store, google: g.google, allowedEmails: opts.allowedEmails ?? ['owner@example.com'], ttlDays: 90, logger: opts.logger ?? silentLogger });
  const tokens = tokenRegistry([{ label: 'test', token: TOKEN }]);
  const app = createApp({
    tokens,
    mcpPath: '/gsc-mcp',
    oauth: {
      store,
      resourceMetadataUrl: resourceMetadataUrl(publicUrl, '/gsc-mcp'),
      router: oauthRouter({ provider, publicUrl, mcpPath: '/gsc-mcp', store, fixedClients: () => tokens.clients(), logger: opts.logger ?? silentLogger }),
    },
    deps: { service: makeService(fakeApi()), logger: opts.logger ?? silentLogger, maxRowsPerCall: 25_000 },
    logger: opts.logger ?? silentLogger,
  });
  server.on('request', app);
  return { base, g, store, provider, close: () => new Promise((r) => server.close(r)) };
}

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** Registers a client and walks it to the consent page; returns what the next steps need. */
export async function toConsentPage(base: string, g: ReturnType<typeof fakeGoogle>, clientName = 'Grok') {
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'], client_name: clientName, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as { client_id: string; client_secret?: string };
  expect(client.client_secret).toBeUndefined();
  const { verifier, challenge } = pkce();
  const authorize = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' })) {
    authorize.searchParams.set(k, v);
  }
  const toGoogle = await fetch(authorize, { redirect: 'manual' });
  expect(toGoogle.status).toBe(302);
  expect(toGoogle.headers.get('location')).toMatch(/^https:\/\/google\.test\/auth\?state=/);
  const callback = `${base}/oauth/google/callback?state=${encodeURIComponent(g.lastState())}&code=google-code`;
  const consent = await fetch(callback, { redirect: 'manual' });
  const html = await consent.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  return { clientId: client.client_id, verifier, consent, html, callback, consentId: field('consentId'), csrf: field('csrf') };
}

export const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  redirect: 'manual' as const,
});

