import express, { type Request, type Response } from 'express';
import type { ClientInfo } from '../auth.js';
import type { Logger } from '../logger.js';
import { errorPage, escapeHtml, page, sendPage } from './pages.js';
import type { GscOAuthProvider } from './provider.js';
import { randomSecret as random, sameSecret } from './secrets.js';
import { grantLabel, type GrantView, type OAuthStore } from './store.js';

export const SESSION_TTL_MS = 43_200_000;
/** The __Host- prefix makes browsers refuse this cookie from any other host, e.g. a sibling subdomain. */
export const SESSION_COOKIE = '__Host-gsc_mcp_session';
/** Holds a clients-page sign-in's state and nonce between GET /clients and Google's redirect back. */
export const SIGNIN_COOKIE = '__Host-gsc_mcp_signin';
/** Owner sessions are few; the cap only stops a runaway loop from growing memory. */
const MAX_SESSIONS = 100;

export interface Session {
  email: string;
  csrf: string;
  expiresAt: number;
}


/** Sessions for the Connected clients page, in memory only: a restart signs the owner out. */
export class OwnerSessions {
  private readonly sessions = new Map<string, Session>();

  create(email: string): string {
    const now = Date.now();
    for (const [k, s] of this.sessions) if (now >= s.expiresAt) this.sessions.delete(k);
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    const id = random();
    this.sessions.set(id, { email, csrf: random(), expiresAt: now + SESSION_TTL_MS });
    return id;
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (s && Date.now() >= s.expiresAt) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  delete(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }
}

/** The value of one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export const sessionCookie = (id: string) => `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
const clearedCookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
/** Lax, so the browser sends it on Google's top-level redirect back to us. */
export const signInCookie = (binding: string) => `${SIGNIN_COOKIE}=${binding}; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax`;
export const clearedSignInCookie = `${SIGNIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : 'never');
const when = (iso: string | undefined) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'never');

export function clientsPage(v: { email: string; csrf: string; grants: GrantView[]; fixed: ClientInfo[] }): string {
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">`;
  const rows = v.grants
    .map(
      (g) => `<tr>
        <td>${escapeHtml(g.clientName)}<div class="muted">#${escapeHtml(g.id.slice(0, 6))}</div></td>
        <td>${escapeHtml(g.redirectHost)}</td>
        <td>${escapeHtml(day(g.createdAt))}</td>
        <td>${escapeHtml(day(g.expiresAt))}</td>
        <td>${escapeHtml(when(g.lastUsedAt))}</td>
        <td><form class="inline" method="post" action="/clients/revoke">${csrf}<input type="hidden" name="grantId" value="${escapeHtml(g.id)}"><button class="danger" type="submit">Revoke</button></form></td>
      </tr>`,
    )
    .join('');
  const grants = v.grants.length
    ? `<div class="table-wrap"><table><thead><tr><th>Client</th><th>Sends codes to</th><th>Approved</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
       <form method="post" action="/clients/revoke-all">${csrf}<button class="danger" type="submit">Revoke all</button></form>`
    : '<p class="muted">No client is signed in through OAuth.</p>';
  const fixed = v.fixed.length
    ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Expires</th></tr></thead><tbody>${v.fixed
        .map((f) => `<tr><td>${escapeHtml(f.name)}</td><td>${escapeHtml(day(f.expiresAt))}</td></tr>`)
        .join('')}</tbody></table></div><p class="muted">Fixed tokens are changed in MCP_AUTH_TOKENS on the server.</p>`
    : '<p class="muted">No fixed tokens are configured.</p>';
  return page(
    'Connected clients',
    `<div class="card">
      <h1>Connected clients</h1>
      <p class="muted">Signed in as ${escapeHtml(v.email)}.</p>
      <h2>Signed in with OAuth</h2>${grants}
      <h2>Fixed tokens</h2>${fixed}
      <form method="post" action="/clients/sign-out">${csrf}<div class="actions"><button type="submit">Sign out</button></div></form>
    </div>`,
  );
}

export interface ClientsRoutesOptions {
  provider: GscOAuthProvider;
  store: OAuthStore;
  sessions: OwnerSessions;
  fixedClients: () => ClientInfo[];
  logger: Logger;
}

/** The Connected clients page: lists grants and fixed tokens, revokes grants. Owner-only, behind Google sign-in. */
export function clientsRoutes(o: ClientsRoutesOptions): express.Router {
  const router = express.Router();
  const sessionOf = (req: Request) => {
    const id = readCookie(req.headers.cookie, SESSION_COOKIE);
    return { id, session: o.sessions.get(id) };
  };

  router.get('/clients', (req, res) => {
    const { session } = sessionOf(req);
    if (!session) {
      const signIn = o.provider.startSessionSignIn();
      return void res.set({ 'Cache-Control': 'no-store', 'Set-Cookie': signInCookie(signIn.binding) }).redirect(302, signIn.url);
    }
    sendPage(res, 200, clientsPage({ email: session.email, csrf: session.csrf, grants: o.store.grants(), fixed: o.fixedClients() }));
  });

  const form = express.urlencoded({ extended: false, limit: '4kb' });
  /** Runs `act` only for a live session with the right csrf; otherwise 403. Then back to the list. */
  const post = (path: string, act: (body: Record<string, unknown>, session: Session, id: string, res: Response) => void) =>
    router.post(path, form, (req, res) => {
      const { id, session } = sessionOf(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const csrf = typeof body.csrf === 'string' ? body.csrf : '';
      if (!session || !id || !sameSecret(csrf, session.csrf)) {
        return sendPage(res, 403, errorPage('Your session has ended or this form is out of date. Open the Connected clients page again.'));
      }
      act(body, session, id, res);
      res.set('Cache-Control', 'no-store').redirect(303, '/clients');
    });

  post('/clients/revoke', (body, session) => {
    const grantId = typeof body.grantId === 'string' ? body.grantId : '';
    const grant = o.store.grants().find((g) => g.id === grantId);
    if (grant && o.store.revokeGrant(grantId)) {
      o.logger.info('grant revoked', { client: grantLabel(grant), by: session.email });
    }
  });
  post('/clients/revoke-all', (_body, session) => {
    o.logger.info('all grants revoked', { count: o.store.revokeAll(), by: session.email });
  });
  post('/clients/sign-out', (_body, _session, id, res) => {
    o.sessions.delete(id);
    res.set('Set-Cookie', clearedCookie);
  });

  return router;
}
