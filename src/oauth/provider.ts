import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTokenError, TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';
import { expiryDayFor } from '../auth.js';
import type { Logger } from '../logger.js';
import type { GoogleSignIn } from './google.js';
import { randomSecret as random, sameSecret } from './secrets.js';
import { cleanClientName, grantLabel, type OAuthStore } from './store.js';

/** How long a started sign-in, a consent page and an authorization code stay usable. */
export const PENDING_TTL_MS = 300_000;
/** Cap on in-flight client sign-ins, so /authorize spam can't grow memory without bound. */
const MAX_PENDING = 1000;

export type GoogleReturn =
  | { kind: 'consent'; consentId: string; csrf: string; clientName: string; redirectHost: string; expiresOn: string }
  | { kind: 'session'; email: string }
  | { kind: 'redirect'; url: string }
  | { kind: 'error'; status: 400 | 403 | 502; message: string };

type Pending =
  | { kind: 'authorize'; clientId: string; params: AuthorizationParams; nonce: string; expiresAt: number }
  | { kind: 'session'; nonce: string; expiresAt: number };

/**
 * A sign-in for the Connected clients page, bound to the browser that started
 * it: the caller keeps `binding` in a short-lived cookie and passes it back
 * with Google's redirect. Nothing is stored on the server, so starting many
 * sign-ins can't push out the owner's.
 */
export interface SessionSignIn {
  url: string;
  binding: string;
}

interface Consent {
  csrf: string;
  /** The end date shown on the consent page, which the grant gets. */
  expiresOn: string;
  clientId: string;
  clientName: string;
  params: AuthorizationParams;
  email: string;
  expiresAt: number;
}

/** An approved request. The grant is created only when the code is exchanged, so an unused approval leaves nothing behind. */
interface Code {
  clientId: string;
  clientName: string;
  email: string;
  expiresOn: string;
  redirectUri: string;
  challenge: string;
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

/** The first part of an error message: google-auth-library appends the ID token or its payload after a colon. */
export const safeReason = (err: unknown) => String((err as Error)?.message ?? err).split(':')[0]!.slice(0, 120);

/** Where codes go, for the consent page and the clients list: the host for https, otherwise scheme and host (or just the scheme). */
export function redirectTarget(redirectUri: string): string {
  const url = new URL(redirectUri);
  if (url.protocol === 'https:') return url.host;
  return url.host ? `${url.protocol}//${url.host}` : url.protocol;
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
    if (map.size >= MAX_PENDING) throw new TooManyRequestsError('Too many sign-ins are in progress; try again in a few minutes.');
  }

  /** Takes a single-use entry: it is deleted whether or not it is still valid. */
  private take<T extends { expiresAt: number }>(map: Map<string, T>, key: string | undefined): T | undefined {
    if (key === undefined) return undefined;
    const v = map.get(key);
    map.delete(key);
    return v && Date.now() < v.expiresAt ? v : undefined;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep(this.pending);
    const state = random();
    const nonce = random();
    this.pending.set(state, { kind: 'authorize', clientId: client.client_id, params, nonce, expiresAt: Date.now() + PENDING_TTL_MS });
    res.redirect(302, this.o.google.authUrl(state, nonce));
  }

  /** Google sign-in for the Connected clients page; see SessionSignIn. */
  startSessionSignIn(): SessionSignIn {
    const state = random();
    const nonce = random();
    return { url: this.o.google.authUrl(state, nonce), binding: `${state}.${nonce}` };
  }

  /**
   * Handles Google's redirect back to /oauth/google/callback. `binding` is the
   * clients-page sign-in cookie, if the browser has one.
   */
  async handleGoogleReturn(q: { state?: string; code?: string; error?: string }, binding?: string): Promise<GoogleReturn> {
    let p: Pending | undefined = this.take(this.pending, q.state);
    if (!p && binding && q.state) {
      const [state, nonce] = binding.split('.');
      if (state && nonce && sameSecret(state, q.state)) p = { kind: 'session', nonce, expiresAt: Infinity };
    }
    if (!p) return { kind: 'error', status: 400, message: STALE };
    const params = p.kind === 'authorize' ? p.params : undefined;
    const denied = (reason: string, email?: string): GoogleReturn => {
      if (email !== undefined) this.o.logger.warn('sign-in refused', { email, reason });
      else this.o.logger.warn('sign-in cancelled', { reason });
      if (!params) return { kind: 'error', status: 403, message: 'Sign-in was refused or cancelled.' };
      return { kind: 'redirect', url: redirectWith(params.redirectUri, { error: 'access_denied', error_description: 'The server owner did not approve this client.', state: params.state }) };
    };
    if (q.error || !q.code) return denied((q.error ?? 'no code from Google').slice(0, 64));

    let identity;
    try {
      identity = await this.o.google.verify(q.code);
    } catch (err) {
      // Google may be down, or the code was made up; either way tell the client, which is waiting.
      this.o.logger.warn('Google sign-in failed', { error: safeReason(err) });
      if (!params) return { kind: 'error', status: 502, message: 'Google sign-in failed. Open the Connected clients page again.' };
      return { kind: 'redirect', url: redirectWith(params.redirectUri, { error: 'temporarily_unavailable', error_description: 'Google sign-in failed; try again.', state: params.state }) };
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
    const consent: Consent = { csrf: random(), expiresOn: expiryDayFor(this.o.ttlDays), clientId: client.client_id, clientName: cleanClientName(client.client_name), params: p.params, email, expiresAt: Date.now() + PENDING_TTL_MS };
    this.consents.set(consentId, consent);
    return {
      kind: 'consent',
      consentId,
      csrf: consent.csrf,
      clientName: consent.clientName,
      redirectHost: redirectTarget(p.params.redirectUri),
      expiresOn: consent.expiresOn,
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
      this.o.logger.warn('client denied', { clientName: c.clientName, clientId: c.clientId, email: c.email });
      return { kind: 'redirect', url: redirectWith(redirectUri, { error: 'access_denied', error_description: 'The server owner denied this client.', state }) };
    }
    if (!this.o.store.getClient(c.clientId)) return { kind: 'error', status: 400, message: 'This client is no longer registered. Start the connection again from your client.' };
    try {
      this.sweep(this.codes);
    } catch {
      return { kind: 'error', status: 400, message: 'Too many sign-ins are in progress; try again in a few minutes.' };
    }
    const code = random();
    this.codes.set(code, { clientId: c.clientId, clientName: c.clientName, email: c.email, expiresOn: c.expiresOn, redirectUri, challenge: codeChallenge, expiresAt: Date.now() + PENDING_TTL_MS });
    this.o.logger.info('client approved', { clientName: c.clientName, clientId: c.clientId, email: c.email, redirectHost: redirectTarget(redirectUri) });
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
    if (!this.o.store.getClient(c.clientId)) throw new InvalidGrantError('This client is no longer registered.');
    const grant = this.o.store.createGrant({ clientId: c.clientId, clientName: c.clientName, email: c.email, redirectHost: redirectTarget(c.redirectUri), expiresOn: c.expiresOn });
    this.o.logger.info('client connected', { client: grantLabel(grant), email: grant.email, redirectHost: grant.redirectHost, expiresAt: grant.expiresAt });
    return this.o.store.issueTokens(grant.id);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    return this.o.store.refresh(client.client_id, refreshToken);
  }

  /**
   * Required by OAuthServerProvider; the SDK router doesn't call it here, and
   * bearerAuth (src/http.ts) checks tokens through OAuthStore.verifyAccess.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const client = this.o.store.verifyAccess(token);
    if (!client) throw new InvalidTokenError('Invalid or expired access token.');
    return { token: '', clientId: client.name, scopes: [], expiresAt: Math.floor(Date.parse(client.expiresAt!) / 1000), extra: { client } };
  }

  /** RFC 7009: a client can revoke only its own tokens; anything else is ignored. */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.o.store.revokeToken(request.token, client.client_id);
  }
}
