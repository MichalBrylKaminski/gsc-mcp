import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';
import { authInfoFor, expiryDayFor } from '../auth.js';
import type { Logger } from '../logger.js';
import type { GoogleSignIn } from './google.js';
import { randomSecret as random, sameSecret } from '../secrets.js';
import { cleanClientName, grantLabel, type OAuthStore } from './store.js';

/** How long a started sign-in, a consent page and an authorization code stay usable. */
export const PENDING_TTL_MS = 300_000;
/**
 * Caps on in-flight sign-ins, consent pages and codes, so /authorize spam can't
 * grow memory without bound. Past a cap the oldest entry is dropped rather than
 * the new one refused, so a flood can't lock the owner out: it would have to
 * outpace the owner's own sign-in, and one client can hold only a few.
 */
const MAX_PENDING = 1000;
const MAX_PENDING_PER_CLIENT = 20;

export type GoogleReturn =
  | { kind: 'consent'; consentId: string; csrf: string; clientName: string; redirectHost: string; expiresOn: string }
  | { kind: 'session'; email: string }
  | { kind: 'redirect'; url: string }
  | { kind: 'error'; status: 400 | 403 | 429 | 502; message: string };

type Pending = { clientId: string; params: AuthorizationParams; nonce: string; expiresAt: number };

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

/** Whether a clients-page sign-in cookie belongs to this Google `state`. */
export function bindingMatches(binding: string, state: string): boolean {
  const parts = binding.split('.');
  return parts.length === 3 && !!parts[1] && /^\d+$/.test(parts[2]!) && sameSecret(parts[0]!, state);
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

  /**
   * Makes room for one more entry: drops expired ones, then the oldest while
   * `limit` or more match `counts` (all entries by default). Entries share one
   * TTL, so insertion order is age order.
   */
  private makeRoom<T extends { expiresAt: number }>(map: Map<string, T>, limit = MAX_PENDING, counts: (v: T) => boolean = () => true): void {
    const now = Date.now();
    for (const [k, v] of map) if (now >= v.expiresAt) map.delete(k);
    const matching = [...map].filter(([, v]) => counts(v));
    for (let i = 0; matching.length - i >= limit; i++) map.delete(matching[i]![0]);
  }

  /** Takes a single-use entry: it is deleted whether or not it is still valid. */
  private take<T extends { expiresAt: number }>(map: Map<string, T>, key: string | undefined): T | undefined {
    if (key === undefined) return undefined;
    const v = map.get(key);
    map.delete(key);
    return v && Date.now() < v.expiresAt ? v : undefined;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.makeRoom(this.pending, MAX_PENDING_PER_CLIENT, (v) => v.clientId === client.client_id);
    this.makeRoom(this.pending);
    const state = random();
    const nonce = random();
    this.pending.set(state, { clientId: client.client_id, params, nonce, expiresAt: Date.now() + PENDING_TTL_MS });
    res.redirect(302, this.o.google.authUrl(state, nonce));
  }

  /** Google sign-in for the Connected clients page; see SessionSignIn. */
  startSessionSignIn(): SessionSignIn {
    const state = random();
    const nonce = random();
    return { url: this.o.google.authUrl(state, nonce), binding: `${state}.${nonce}.${Date.now()}` };
  }

  /**
   * Handles Google's redirect back to /oauth/google/callback. `binding` is the
   * clients-page sign-in cookie, if the browser has one. `admit` is asked just
   * before Google is called (a rate limit); false answers with a 429.
   */
  async handleGoogleReturn(q: { state?: string; code?: string; error?: string }, binding?: string, admit: () => boolean = () => true): Promise<GoogleReturn> {
    const pending = this.take(this.pending, q.state);
    let nonce = pending?.nonce;
    if (!pending && binding && q.state && bindingMatches(binding, q.state)) {
      const [, boundNonce, issuedAt] = binding.split('.');
      if (Date.now() < Number(issuedAt) + PENDING_TTL_MS) nonce = boundNonce;
    }
    if (nonce === undefined) return { kind: 'error', status: 400, message: STALE };
    const params = pending?.params;
    /** Ends the sign-in: a client gets an OAuth error at its redirect URI (it is waiting for one), the clients page an error page. */
    const fail = (status: 403 | 429 | 502, page: string, error: string, description: string): GoogleReturn =>
      params ? { kind: 'redirect', url: redirectWith(params.redirectUri, { error, error_description: description, state: params.state }) } : { kind: 'error', status, message: page };
    const denied = (reason: string, email?: string): GoogleReturn => {
      if (email !== undefined) this.o.logger.warn('sign-in refused', { email, reason });
      else this.o.logger.warn('sign-in cancelled', { reason });
      return fail(403, 'Sign-in was refused or cancelled.', 'access_denied', 'The server owner did not approve this client.');
    };
    if (q.error || !q.code) return denied((q.error ?? 'no code from Google').slice(0, 64));

    if (!admit()) {
      this.o.logger.warn('sign-in rate limited');
      return fail(429, 'Too many sign-in attempts from this address. Wait ten minutes and try again.', 'temporarily_unavailable', 'Too many sign-in attempts; wait ten minutes and try again.');
    }
    let identity;
    try {
      identity = await this.o.google.verify(q.code);
    } catch (err) {
      // Google may be down, or the code was made up.
      this.o.logger.warn('Google sign-in failed', { error: safeReason(err) });
      return fail(502, 'Google sign-in failed. Open the Connected clients page again.', 'temporarily_unavailable', 'Google sign-in failed; try again.');
    }
    if (identity.nonce === undefined || !sameSecret(identity.nonce, nonce)) {
      this.o.logger.warn('Google sign-in failed', { error: 'nonce mismatch' });
      return fail(403, 'Google sign-in could not be verified. Open the Connected clients page again.', 'access_denied', 'Google sign-in could not be verified; try again.');
    }
    const email = identity.email.trim().toLowerCase();
    if (!identity.emailVerified) return denied('email not verified', identity.email);
    if (!this.allowed.has(email)) return denied('email not allowed', identity.email);

    if (!pending) return { kind: 'session', email };

    const p = pending;
    const client = this.o.store.getClient(p.clientId);
    if (!client) return { kind: 'error', status: 400, message: 'This client is no longer registered. Start the connection again from your client.' };
    this.makeRoom(this.consents);
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
    this.makeRoom(this.codes);
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

  /**
   * RFC 6749 4.1.3: redirect_uri must match the authorization request. The SDK
   * fills it in at /authorize when a client with one registered URI leaves it
   * out, so it may be omitted here only when the code went to that one URI.
   */
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.take(this.codes, authorizationCode);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code.');
    const implied = client.redirect_uris.length === 1 && client.redirect_uris[0] === c.redirectUri;
    if (redirectUri === undefined ? !implied : redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    if (!this.o.store.getClient(c.clientId)) throw new InvalidGrantError('This client is no longer registered.');
    const grant = this.o.store.createGrant({ clientId: c.clientId, clientName: c.clientName, email: c.email, redirectHost: redirectTarget(c.redirectUri), expiresOn: c.expiresOn });
    this.o.logger.info('client connected', { client: grantLabel(grant), email: grant.email, redirectHost: grant.redirectHost, expiresAt: grant.expiresAt });
    const tokens = this.o.store.issueTokens(grant.id);
    await this.o.store.flush(); // wait for the write, so a crash right after can't forget them (a failed write is logged)
    return tokens;
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const tokens = this.o.store.refresh(client.client_id, refreshToken);
    await this.o.store.flush(); // the old refresh token is spent; wait for the new one to be written (a failed write is logged)
    return tokens;
  }

  /**
   * Required by OAuthServerProvider; the SDK router doesn't call it here, and
   * bearerAuth (src/http.ts) checks tokens through OAuthStore.verifyAccess.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const client = this.o.store.verifyAccess(token);
    if (!client) throw new InvalidTokenError('Invalid or expired access token.');
    return authInfoFor(client);
  }

  /** RFC 7009: a client can revoke only its own tokens; anything else is ignored. */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.o.store.revokeToken(request.token, client.client_id);
  }
}
