import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import express, { type Response } from 'express';
import type { ClientInfo } from '../auth.js';
import type { Logger } from '../logger.js';
import { consentPage, errorPage } from './pages.js';
import type { GscOAuthProvider } from './provider.js';
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

/**
 * Headers for every page: never cached, no scripts, never framed (so the
 * consent buttons can't be clickjacked). No form-action: browsers apply it to
 * the redirect after the consent form, which goes to the client's own URI.
 */
export function sendPage(res: Response, status: number, html: string): void {
  res
    .status(status)
    .set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    .type('html')
    .send(html);
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * The OAuth authorization server (discovery, /register, /authorize, /token,
 * /revoke from the SDK) plus our Google callback and consent page. Mount at
 * the app root.
 */
export function oauthRouter(o: OAuthRouterOptions): express.Router {
  const router = express.Router();
  router.use(
    mcpAuthRouter({
      provider: o.provider,
      issuerUrl: o.publicUrl,
      resourceServerUrl: new URL(o.mcpPath, o.publicUrl),
      resourceName: 'Google Search Console (read-only)',
    }),
  );

  router.get('/oauth/google/callback', async (req, res) => {
    const ret = await o.provider.handleGoogleReturn({ state: str(req.query.state), code: str(req.query.code), error: str(req.query.error) });
    switch (ret.kind) {
      case 'consent':
        return sendPage(res, 200, consentPage(ret));
      case 'redirect':
        return void res.set('Cache-Control', 'no-store').redirect(302, ret.url);
      case 'session':
        // The Connected clients page handles this kind of sign-in.
        return sendPage(res, 400, errorPage('This sign-in is not used here.'));
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

  return router;
}
