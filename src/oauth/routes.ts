import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ClientInfo } from '../auth.js';
import type { Logger } from '../logger.js';
import { clearedSignInCookie, clientsRoutes, OwnerSessions, readCookie, SESSION_COOKIE, sessionCookie, SIGNIN_COOKIE } from './clients.js';
import { consentPage, errorPage, sendPage } from './pages.js';
import { bindingMatches, safeReason, type GscOAuthProvider } from './provider.js';
import { RateLimit } from './rateLimit.js';
import type { OAuthStore } from './store.js';

export interface OAuthRouterOptions {
  provider: GscOAuthProvider;
  /** The public origin, which is also the OAuth issuer. */
  publicUrl: URL;
  mcpPath: string;
  store: OAuthStore;
  /** The fixed tokens, listed read-only on the Connected clients page. */
  fixedClients: () => ClientInfo[];
  logger: Logger;
}

/** Where the MCP endpoint's protected-resource metadata is served, e.g. /.well-known/oauth-protected-resource/gsc-mcp. */
export function resourceMetadataUrl(publicUrl: URL, mcpPath: string): string {
  return getOAuthProtectedResourceMetadataUrl(new URL(mcpPath, publicUrl));
}

const CALLBACK_LIMIT = 30;
const CALLBACK_WINDOW_MS = 600_000;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * The OAuth authorization server (discovery, /register, /authorize, /token,
 * /revoke from the SDK) plus our Google callback, the consent page and the
 * Connected clients page. Mount at the app root.
 */
export function oauthRouter(o: OAuthRouterOptions): express.Router {
  const router = express.Router();
  const sessions = new OwnerSessions();
  // Each callback may cost a request to Google; real sign-ins need a handful.
  const callbacks = new RateLimit(CALLBACK_LIMIT, CALLBACK_WINDOW_MS);
  router.use(
    mcpAuthRouter({
      provider: o.provider,
      issuerUrl: o.publicUrl,
      resourceServerUrl: new URL(o.mcpPath, o.publicUrl),
      resourceName: 'Google Search Console (read-only)',
    }),
  );

  router.get('/oauth/google/callback', async (req, res) => {
    const state = str(req.query.state);
    const binding = readCookie(req.headers.cookie, SIGNIN_COOKIE);
    // Single use, but only for its own sign-in: a client's sign-in in the same browser leaves it alone.
    if (binding && state && bindingMatches(binding, state)) res.append('Set-Cookie', clearedSignInCookie);
    let ret;
    try {
      // Only callbacks that would reach Google count toward the limit.
      ret = await o.provider.handleGoogleReturn({ state, code: str(req.query.code), error: str(req.query.error) }, binding, () => callbacks.take(req.ip ?? 'unknown'));
    } catch (err) {
      o.logger.error('sign-in callback failed', { error: safeReason(err) });
      return sendPage(res, 500, errorPage('Sign-in failed. Start the connection again from your client.'));
    }
    switch (ret.kind) {
      case 'consent':
        return sendPage(res, 200, consentPage(ret));
      case 'redirect':
        return void res.set('Cache-Control', 'no-store').redirect(302, ret.url);
      case 'session':
        sessions.delete(readCookie(req.headers.cookie, SESSION_COOKIE)); // a new sign-in ends the previous session
        o.logger.info('owner signed in to the clients page', { email: ret.email });
        return void res.set('Cache-Control', 'no-store').append('Set-Cookie', sessionCookie(sessions.create(ret.email))).redirect(302, '/clients');
      case 'error':
        return sendPage(res, ret.status, errorPage(ret.message));
    }
  });

  router.post('/oauth/consent', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = str(body.decision);
    if (decision !== 'approve' && decision !== 'deny') return sendPage(res, 400, errorPage('Choose Approve or Deny.'));
    const ret = o.provider.decideConsent(str(body.consentId) ?? '', str(body.csrf) ?? '', decision === 'approve');
    if (ret.kind === 'error') return sendPage(res, ret.status, errorPage(ret.message));
    res.set('Cache-Control', 'no-store').redirect(302, ret.url);
  });

  router.use(clientsRoutes({ provider: o.provider, store: o.store, sessions, fixedClients: o.fixedClients, logger: o.logger }));

  // Body-parser failures on these forms (too large, malformed) as pages, not JSON-RPC errors.
  router.use(['/oauth', '/clients'], (err: { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) o.logger.error('sign-in page failed', { error: safeReason(err) });
    sendPage(res, status, errorPage(status === 413 ? 'The form was too large.' : 'Something went wrong. Start again from your client.'));
  });

  return router;
}
