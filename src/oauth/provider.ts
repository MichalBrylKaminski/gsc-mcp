import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';
import { expiryDayFor } from '../auth.js';
import type { Logger } from '../logger.js';
import type { GoogleSignIn } from './google.js';
import { cleanClientName, type OAuthStore } from './store.js';

/** How long a started sign-in, a consent page and an authorization code stay usable. */
export const PENDING_TTL_MS = 300_000;
/** Cap on in-flight sign-ins, so /authorize spam can't grow memory without bound. */
const MAX_PENDING = 1000;

export type GoogleReturn =
  | { kind: 'consent'; consentId: string; csrf: string; clientName: string; redirectHost: string; expiresOn: string }
  | { kind: 'session'; email: string }
  | { kind: 'redirect'; url: string }
  | { kind: 'error'; status: 400 | 403; message: string };

type Pending =
  | { kind: 'authorize'; clientId: string; params: AuthorizationParams; nonce: string; expiresAt: number }
  | { kind: 'session'; nonce: string; expiresAt: number };

interface Consent {
  csrf: string;
  clientId: string;
  clientName: string;
  params: AuthorizationParams;
  email: string;
  expiresAt: number;
}

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  grantId: string;
  expiresAt: number;
}

export interface GscOAuthProviderOptions {
  store: OAuthStore;
  google: GoogleSignIn;
  /** Lowercased emails that may approve clients and open the clients page. */
  allowedEmails: string[];
  ttlDays: number;
  logger: Logger;
}

const STALE = 'This sign-in link has expired or was already used. Start the connection again from your client.';
const random = () => randomBytes(32).toString('base64url');

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Adds OAuth response parameters to a client's redirect URI. */
function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.href;
}

/**
 * The OAuth authorization server behind the SDK's mcpAuthRouter. A client's
 * /authorize request sends the owner through Google sign-in (allowlisted email)
 * and a consent page; only then is a grant created and a code issued.
 */
export class GscOAuthProvider implements OAuthServerProvider {
  /** Keyed by the `state` we sent to Google. */
  private readonly pending = new Map<string, Pending>();
  private readonly consents = new Map<string, Consent>();
  private readonly codes = new Map<string, Code>();
  private readonly allowed: Set<string>;

  constructor(private readonly o: GscOAuthProviderOptions) {
    this.allowed = new Set(o.allowedEmails.map((e) => e.toLowerCase()));
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.o.store.getClient(id),
      registerClient: (info) => this.o.store.registerClient(info),
    };
  }

  /** Drops expired entries; refuses new ones past the cap. */
  private sweep<T extends { expiresAt: number }>(map: Map<string, T>): void {
    const now = Date.now();
    for (const [k, v] of map) if (now >= v.expiresAt) map.delete(k);
    if (map.size >= MAX_PENDING) throw new Error('too many sign-ins in progress');
  }

  /** Takes a single-use entry: it is deleted whether or not it is still valid. */
  private take<T extends { expiresAt: number }>(map: Map<string, T>, key: string | undefined): T | undefined {
    if (key === undefined) return undefined;
    const v = map.get(key);
    map.delete(key);
    return v && Date.now() < v.expiresAt ? v : undefined;
  }

  private startGoogle(p: { kind: 'authorize'; clientId: string; params: AuthorizationParams } | { kind: 'session' }): string {
    this.sweep(this.pending);
    const state = random();
    const nonce = random();
    this.pending.set(state, { ...p, nonce, expiresAt: Date.now() + PENDING_TTL_MS } as Pending);
    return this.o.google.authUrl(state, nonce);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.redirect(302, this.startGoogle({ kind: 'authorize', clientId: client.client_id, params }));
  }

  /** Google sign-in for the Connected clients page. */
  startSessionSignIn(): string {
    return this.startGoogle({ kind: 'session' });
  }

  /** Handles Google's redirect back to /oauth/google/callback. */
  async handleGoogleReturn(q: { state?: string; code?: string; error?: string }): Promise<GoogleReturn> {
    const p = this.take(this.pending, q.state);
    if (!p) return { kind: 'error', status: 400, message: STALE };
    const denied = (reason: string, email?: string): GoogleReturn => {
      if (email !== undefined) this.o.logger.warn('sign-in refused', { email, reason });
      if (p.kind === 'session') return { kind: 'error', status: 403, message: 'Sign-in was refused or cancelled.' };
      return { kind: 'redirect', url: redirectWith(p.params.redirectUri, { error: 'access_denied', error_description: 'The server owner did not approve this client.', state: p.params.state }) };
    };
    if (q.error || !q.code) return denied(q.error ?? 'no code from Google');

    let identity;
    try {
      identity = await this.o.google.verify(q.code);
    } catch (err) {
      this.o.logger.warn('Google sign-in failed', { error: (err as Error).message });
      return { kind: 'error', status: 400, message: 'Google sign-in failed. Start the connection again from your client.' };
    }
    if (identity.nonce === undefined || !sameSecret(identity.nonce, p.nonce)) {
      this.o.logger.warn('Google sign-in failed', { error: 'nonce mismatch' });
      return { kind: 'error', status: 400, message: 'Google sign-in failed. Start the connection again from your client.' };
    }
    const email = identity.email.trim().toLowerCase();
    if (!identity.emailVerified) return denied('email not verified', identity.email);
    if (!this.allowed.has(email)) return denied('email not allowed', identity.email);

    if (p.kind === 'session') return { kind: 'session', email };

    const client = this.o.store.getClient(p.clientId);
    if (!client) return { kind: 'error', status: 400, message: 'This client is no longer registered. Start the connection again from your client.' };
    this.sweep(this.consents);
    const consentId = random();
    const consent: Consent = { csrf: random(), clientId: client.client_id, clientName: cleanClientName(client.client_name), params: p.params, email, expiresAt: Date.now() + PENDING_TTL_MS };
    this.consents.set(consentId, consent);
    return {
      kind: 'consent',
      consentId,
      csrf: consent.csrf,
      clientName: consent.clientName,
      redirectHost: new URL(p.params.redirectUri).host,
      expiresOn: expiryDayFor(this.o.ttlDays),
    };
  }

  /** The owner's click on the consent page. A wrong csrf leaves the consent usable. */
  decideConsent(consentId: string, csrf: string, approve: boolean): { kind: 'redirect'; url: string } | { kind: 'error'; status: 400; message: string } {
    const c = this.consents.get(consentId);
    if (!c || Date.now() >= c.expiresAt) {
      this.consents.delete(consentId);
      return { kind: 'error', status: 400, message: STALE };
    }
    if (!sameSecret(csrf, c.csrf)) return { kind: 'error', status: 400, message: 'This form is out of date. Start the connection again from your client.' };
    this.consents.delete(consentId);
    const { redirectUri, state, codeChallenge } = c.params;
    if (!approve) {
      this.o.logger.info('client denied', { client: c.clientName });
      return { kind: 'redirect', url: redirectWith(redirectUri, { error: 'access_denied', error_description: 'The server owner denied this client.', state }) };
    }
    if (!this.o.store.getClient(c.clientId)) return { kind: 'error', status: 400, message: 'This client is no longer registered. Start the connection again from your client.' };
    const grant = this.o.store.createGrant({ clientId: c.clientId, clientName: c.clientName, email: c.email, redirectHost: new URL(redirectUri).host });
    this.sweep(this.codes);
    const code = random();
    this.codes.set(code, { clientId: c.clientId, redirectUri, challenge: codeChallenge, grantId: grant.id, expiresAt: Date.now() + PENDING_TTL_MS });
    this.o.logger.info('client approved', { client: `oauth:${grant.clientName}#${grant.id.slice(0, 6)}`, redirectHost: grant.redirectHost, expiresAt: grant.expiresAt });
    return { kind: 'redirect', url: redirectWith(redirectUri, { code, state }) };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const c = this.codes.get(authorizationCode);
    if (!c || c.clientId !== client.client_id || Date.now() >= c.expiresAt) throw new InvalidGrantError('Invalid or expired authorization code.');
    return c.challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.take(this.codes, authorizationCode);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code.');
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    return this.o.store.issueTokens(c.grantId);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    return this.o.store.refresh(client.client_id, refreshToken);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const client = this.o.store.verifyAccess(token);
    if (!client) throw new InvalidTokenError('Invalid or expired access token.');
    return { token: '', clientId: client.name, scopes: [], expiresAt: Math.floor(Date.parse(client.expiresAt!) / 1000), extra: { client } };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.o.store.revokeToken(request.token);
  }
}
