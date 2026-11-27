import { randomBytes, randomUUID } from 'node:crypto';
import { InvalidClientMetadataError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { DAY_MS, EXPIRY_WARNING_DAYS, expiryDayFor, expiryMs, utcDay, type ClientInfo } from '../auth.js';
import { JsonFile } from '../limits/limiter.js';
import type { Logger } from '../logger.js';
import { randomSecret, sha256Hex as sha256 } from '../secrets.js';

export const ACCESS_TOKEN_TTL_MS = 3_600_000;
/**
 * A client may present the refresh token it exchanged last again for this long
 * (its response was lost, or several of its requests refreshed at once) and get
 * another pair, instead of having the grant revoked as a copied token.
 */
export const REFRESH_REUSE_GRACE_MS = 60_000;
/** Live access tokens, and live refresh tokens from grace repeats, kept per grant; the oldest go first. */
const MAX_LIVE_TOKENS = 10;
/** A registered client that never got a grant is forgotten after this long. */
export const UNUSED_CLIENT_TTL_MS = 86_400_000;
export const MAX_CLIENTS = 100;
/** A client this new may be part-way through a sign-in (three 5-minute steps), so it isn't dropped to make room. */
export const RECENT_CLIENT_MS = 900_000;
/** How often a changed "last used" time is saved. */
export const LAST_USED_FLUSH_MS = 60_000;
export const CLIENT_NAME_MAX = 64;
const MAX_REDIRECT_URIS = 10;
const MAX_USED_REFRESH_HASHES = 100;
const MAX_METADATA_STRING = 2048;

/** What the Connected clients page and logs may know about a grant. */
export interface GrantView {
  id: string;
  clientId: string;
  clientName: string;
  email: string;
  redirectHost: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
}

export interface IssuedTokens {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  refresh_token: string;
}

interface StoredGrant {
  id: string;
  clientId: string;
  clientName: string;
  email: string;
  redirectHost: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
  /** Each access token works until its own expiry, so a refresh never cuts off a request already holding one. */
  accessTokens: { hash: string; expiresAt: number }[];
  /** Usually one; grace repeats add more, all retired when any of them is exchanged. */
  refreshHashes: string[];
  /** The refresh token exchanged last and when, for REFRESH_REUSE_GRACE_MS. */
  lastRefresh?: { hash: string; at: number };
  /** Refresh tokens already exchanged or retired, oldest first; seeing one again means it was copied. */
  usedRefreshHashes: string[];
}

type StoredClient = OAuthClientInformationFull & { registeredAt: number };

interface State {
  version: 1;
  clients: StoredClient[];
  grants: StoredGrant[];
}

export interface OAuthStoreOptions {
  /** Where to persist; omit to keep everything in memory (tests). */
  file?: string;
  /** Grant lifetime: a grant ends at 00:00 UTC on (approval day + ttlDays). */
  ttlDays: number;
  logger: Logger;
}

const iso = (ms: number) => new Date(ms).toISOString();

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validClient(c: unknown): c is StoredClient {
  const x = c as StoredClient | null;
  return !!x && isStr(x.client_id) && isTime(x.registeredAt) && Array.isArray(x.redirect_uris) && x.redirect_uris.every(isStr) && !('client_secret' in x);
}

function validGrant(g: unknown): g is StoredGrant {
  const x = g as StoredGrant | null;
  return (
    !!x &&
    [x.id, x.clientId, x.clientName, x.email, x.redirectHost].every(isStr) &&
    isTime(x.createdAt) &&
    isTime(x.expiresAt) &&
    (x.lastUsedAt === undefined || isTime(x.lastUsedAt)) &&
    Array.isArray(x.accessTokens) &&
    x.accessTokens.every((a) => !!a && isStr(a.hash) && isTime(a.expiresAt)) &&
    Array.isArray(x.refreshHashes) &&
    x.refreshHashes.every(isStr) &&
    (x.lastRefresh === undefined || (!!x.lastRefresh && isStr(x.lastRefresh.hash) && isTime(x.lastRefresh.at))) &&
    Array.isArray(x.usedRefreshHashes) &&
    x.usedRefreshHashes.every(isStr)
  );
}

/** How a grant appears in logs and as ClientInfo.name: oauth:<client name>#<first 6 chars of the grant id>. */
export const grantLabel = (g: { clientName: string; id: string }) => `oauth:${g.clientName}#${g.id.slice(0, 6)}`;

/** A client-chosen name, safe to show and log: no control or format characters, at most 64 characters. */
export function cleanClientName(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/[\p{C}]/gu, '').trim().slice(0, CLIENT_NAME_MAX).trim();
  return cleaned || 'client';
}

/**
 * Registered OAuth clients and the grants the owner approved, with their
 * current tokens. Tokens are kept only as SHA-256 hashes, in memory and on disk.
 */
export class OAuthStore {
  private readonly clients = new Map<string, StoredClient>();
  private readonly grantsById = new Map<string, StoredGrant>();
  private readonly byAccess = new Map<string, StoredGrant>();
  private readonly byRefresh = new Map<string, StoredGrant>();
  private readonly byUsedRefresh = new Map<string, StoredGrant>();
  /** grant id -> the UTC day its "expires soon" warning was last logged. */
  private readonly warnedOn = new Map<string, string>();
  private readonly file: JsonFile<State>;
  private lastUsedDirty = false;
  private readonly timers: NodeJS.Timeout[];

  constructor(private readonly opts: OAuthStoreOptions) {
    this.file = new JsonFile<State>(opts.file, 'OAuth state', opts.logger, { setAsideCorrupt: true });
    this.load();
    this.prune();
    this.timers = [
      setInterval(() => {
        if (this.lastUsedDirty) this.save();
      }, LAST_USED_FLUSH_MS),
      setInterval(() => this.prune(), DAY_MS),
    ];
    for (const t of this.timers) t.unref();
  }

  private load(): void {
    const state = this.file.read((s) => {
      const x = s as State | null;
      return x?.version === 1 && Array.isArray(x.clients) && Array.isArray(x.grants);
    });
    if (!state) return;
    let dropped = 0;
    for (const c of state.clients as unknown[]) {
      if (validClient(c)) this.clients.set(c.client_id, c);
      else dropped++;
    }
    for (const g of state.grants as unknown[]) {
      if (validGrant(g) && this.clients.has(g.clientId)) this.index(g);
      else dropped++;
    }
    if (dropped) this.opts.logger.warn('dropped malformed OAuth state entries', { file: this.opts.file, dropped });
  }

  private index(g: StoredGrant): void {
    this.grantsById.set(g.id, g);
    for (const a of g.accessTokens) this.byAccess.set(a.hash, g);
    for (const h of g.refreshHashes) this.byRefresh.set(h, g);
    for (const h of g.usedRefreshHashes) this.byUsedRefresh.set(h, g);
  }

  private save(): void {
    this.lastUsedDirty = false;
    this.file.save(() => ({ version: 1, clients: [...this.clients.values()], grants: [...this.grantsById.values()] }));
  }

  getClient(id: string): OAuthClientInformationFull | undefined {
    const c = this.clients.get(id);
    if (!c) return undefined;
    const { registeredAt: _r, ...client } = c;
    return client;
  }

  /**
   * Called by the SDK's /register handler, which has already assigned client_id
   * (and a client_secret, unless the client asked to be public). Every client
   * is made public: the secret is dropped so it is never stored, and PKCE
   * protects the code exchange instead. Only the fields this server uses are kept.
   */
  registerClient(info: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
    if (this.clients.size >= MAX_CLIENTS) this.prune();
    if (this.clients.size >= MAX_CLIENTS) {
      // Registering grants nothing, so making room by forgetting the oldest client without a grant is safe,
      // unless it is recent enough to be mid-sign-in.
      const inUse = new Set([...this.grantsById.values()].map((g) => g.clientId));
      const idle = [...this.clients.values()].filter((c) => !inUse.has(c.client_id));
      const oldest = idle.filter((c) => Date.now() - c.registeredAt >= RECENT_CLIENT_MS).sort((a, b) => a.registeredAt - b.registeredAt)[0];
      if (!oldest) {
        throw new InvalidClientMetadataError(
          idle.length
            ? 'Too many clients registered in the last few minutes; try again in 15 minutes.'
            : 'This server has too many connected clients; revoke one on the Connected clients page first.',
        );
      }
      this.clients.delete(oldest.client_id);
    }
    const given = info as Partial<OAuthClientInformationFull>;
    const uris = given.redirect_uris ?? [];
    if (!uris.length || uris.length > MAX_REDIRECT_URIS || uris.some((u) => typeof u !== 'string' || u.length > MAX_METADATA_STRING)) {
      throw new InvalidClientMetadataError(`redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URLs of at most ${MAX_METADATA_STRING} characters`);
    }
    const client: OAuthClientInformationFull = {
      client_id: given.client_id || randomUUID(),
      ...(given.client_id_issued_at !== undefined ? { client_id_issued_at: given.client_id_issued_at } : {}),
      redirect_uris: [...uris],
      token_endpoint_auth_method: 'none',
      ...(given.client_name !== undefined ? { client_name: String(given.client_name).slice(0, MAX_METADATA_STRING) } : {}),
      ...(given.grant_types ? { grant_types: given.grant_types.slice(0, 5).map((t) => String(t).slice(0, 64)) } : {}),
      ...(given.response_types ? { response_types: given.response_types.slice(0, 5).map((t) => String(t).slice(0, 64)) } : {}),
      ...(given.scope !== undefined ? { scope: String(given.scope).slice(0, MAX_METADATA_STRING) } : {}),
    };
    this.clients.set(client.client_id, { ...client, registeredAt: Date.now() });
    this.save();
    return client;
  }

  /**
   * Records the owner's approval. The grant has no tokens until issueTokens.
   * `expiresOn` (YYYY-MM-DD) is the date the owner was shown; by default today + ttlDays.
   */
  createGrant(g: { clientId: string; clientName: string; email: string; redirectHost: string; expiresOn?: string }): GrantView {
    if (!this.clients.has(g.clientId)) throw new Error(`unknown client ${g.clientId}`);
    const now = Date.now();
    const grant: StoredGrant = {
      id: randomBytes(16).toString('hex'),
      clientId: g.clientId,
      clientName: cleanClientName(g.clientName),
      email: g.email,
      redirectHost: g.redirectHost,
      createdAt: now,
      expiresAt: expiryMs(g.expiresOn ?? expiryDayFor(this.opts.ttlDays, now)),
      accessTokens: [],
      refreshHashes: [],
      usedRefreshHashes: [],
    };
    this.index(grant);
    this.save();
    return this.view(grant);
  }

  /** A fresh access and refresh token for a grant; any refresh token it had stops working. */
  issueTokens(grantId: string): IssuedTokens {
    const g = this.grantsById.get(grantId);
    if (!g || Date.now() >= g.expiresAt) throw new InvalidGrantError('The sign-in has ended; sign in again.');
    this.retireRefreshTokens(g);
    return this.mint(g);
  }

  /**
   * Exchanges a refresh token for a new pair. Each refresh token works once;
   * one that comes back after use was copied, so the whole grant is revoked.
   * The exception: the token exchanged last, presented again by its own client
   * within REFRESH_REUSE_GRACE_MS of that exchange, gets another pair, as often
   * as it comes (parallel requests may all refresh with it). The refresh tokens
   * those pairs carry live side by side until one of them is exchanged, which
   * retires the rest: so if a thief took one, whichever of the two refreshes
   * second presents a used token and the grant is revoked.
   * Callers handing the tokens out should await flush() first, so a crash
   * right after can't forget the new refresh token.
   */
  refresh(clientId: string, refreshToken: string): IssuedTokens {
    const hash = sha256(refreshToken);
    const now = Date.now();
    const reused = this.byUsedRefresh.get(hash);
    if (reused) {
      if (now >= reused.expiresAt) {
        this.removeGrant(reused);
        throw new InvalidGrantError('The sign-in has ended; sign in again.');
      }
      const last = reused.lastRefresh;
      if (reused.clientId === clientId && last?.hash === hash && now - last.at < REFRESH_REUSE_GRACE_MS) {
        this.opts.logger.warn('refresh token presented again within the grace period; issued another pair', { client: grantLabel(reused) });
        return this.mint(reused);
      }
      this.opts.logger.error('refresh token reused', { client: grantLabel(reused), note: 'the grant was revoked; the client must sign in again' });
      this.removeGrant(reused);
      throw new InvalidGrantError('This refresh token was already used. The sign-in was revoked; sign in again.');
    }
    const g = this.byRefresh.get(hash);
    if (!g || g.clientId !== clientId) throw new InvalidGrantError('Unknown refresh token.');
    if (now >= g.expiresAt) {
      this.removeGrant(g);
      throw new InvalidGrantError('The sign-in has ended; sign in again.');
    }
    this.retireRefreshTokens(g);
    g.lastRefresh = { hash, at: now };
    return this.mint(g);
  }

  /** A new access token alongside the live ones, and a new refresh token alongside the live ones. */
  private mint(g: StoredGrant): IssuedTokens {
    const access = randomSecret();
    const refresh = randomSecret();
    const now = Date.now();
    const expiresAt = Math.min(now + ACCESS_TOKEN_TTL_MS, g.expiresAt);
    for (const a of g.accessTokens) if (now >= a.expiresAt) this.byAccess.delete(a.hash);
    g.accessTokens = g.accessTokens.filter((a) => now < a.expiresAt);
    const accessHash = sha256(access);
    g.accessTokens.push({ hash: accessHash, expiresAt });
    this.byAccess.set(accessHash, g);
    while (g.accessTokens.length > MAX_LIVE_TOKENS) this.byAccess.delete(g.accessTokens.shift()!.hash);
    const refreshHash = sha256(refresh);
    g.refreshHashes.push(refreshHash);
    this.byRefresh.set(refreshHash, g);
    while (g.refreshHashes.length > MAX_LIVE_TOKENS) this.markUsed(g, g.refreshHashes.shift()!);
    this.save();
    return { access_token: access, token_type: 'bearer', expires_in: Math.max(0, Math.floor((expiresAt - now) / 1000)), refresh_token: refresh };
  }

  private retireRefreshTokens(g: StoredGrant): void {
    for (const h of g.refreshHashes) this.markUsed(g, h);
    g.refreshHashes = [];
  }

  private markUsed(g: StoredGrant, hash: string): void {
    this.byRefresh.delete(hash);
    g.usedRefreshHashes.push(hash);
    this.byUsedRefresh.set(hash, g);
    // Keep the most recent ones; an older copied token is still useless, just not detected as reuse.
    while (g.usedRefreshHashes.length > MAX_USED_REFRESH_HASHES) this.byUsedRefresh.delete(g.usedRefreshHashes.shift()!);
  }

  /** The client behind a valid access token, or undefined. Records the use. */
  verifyAccess(token: string): ClientInfo | undefined {
    const hash = sha256(token);
    const g = this.byAccess.get(hash);
    const now = Date.now();
    const expiresAt = g?.accessTokens.find((a) => a.hash === hash)?.expiresAt;
    if (!g || expiresAt === undefined || now >= expiresAt || now >= g.expiresAt) return undefined;
    g.lastUsedAt = now;
    this.lastUsedDirty = true;
    const client: ClientInfo = { name: grantLabel(g), expiresAt: iso(g.expiresAt), daysLeft: Math.ceil((g.expiresAt - now) / DAY_MS), signIn: true };
    if (client.daysLeft! <= EXPIRY_WARNING_DAYS && this.warnedOn.get(g.id) !== utcDay(now)) {
      this.warnedOn.set(g.id, utcDay(now));
      this.opts.logger.warn('sign-in expires soon', { client: client.name, expiresAt: client.expiresAt, daysLeft: client.daysLeft });
    }
    return client;
  }

  /** Revokes the grant behind an access or refresh token (RFC 7009); unknown tokens, or another client's, are ignored. */
  revokeToken(token: string, clientId?: string): void {
    const hash = sha256(token);
    const g = this.byAccess.get(hash) ?? this.byRefresh.get(hash) ?? this.byUsedRefresh.get(hash);
    if (g && (clientId === undefined || g.clientId === clientId)) this.removeGrant(g);
  }

  /** The revoked grant, or undefined if there was none with this id. */
  revokeGrant(id: string): GrantView | undefined {
    const g = this.grantsById.get(id);
    if (!g) return undefined;
    this.removeGrant(g);
    return this.view(g);
  }

  revokeAll(): number {
    const n = this.grantsById.size;
    for (const g of [...this.grantsById.values()]) this.removeGrant(g, false);
    if (n) this.save();
    return n;
  }

  private removeGrant(g: StoredGrant, save = true): void {
    this.grantsById.delete(g.id);
    for (const a of g.accessTokens) this.byAccess.delete(a.hash);
    for (const h of g.refreshHashes) this.byRefresh.delete(h);
    for (const h of g.usedRefreshHashes) this.byUsedRefresh.delete(h);
    this.warnedOn.delete(g.id);
    if (save) this.save();
  }

  /** Live grants, newest first. Expired ones no longer work and are dropped by the next prune. */
  grants(): GrantView[] {
    const now = Date.now();
    return [...this.grantsById.values()]
      .filter((g) => now < g.expiresAt)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => this.view(g));
  }

  /** Drops expired grants, and clients that registered over a day ago and have no grant. Runs daily on its own. */
  prune(): void {
    const now = Date.now();
    let changed = false;
    for (const g of [...this.grantsById.values()]) {
      if (now >= g.expiresAt) {
        this.removeGrant(g, false);
        changed = true;
      }
    }
    const inUse = new Set([...this.grantsById.values()].map((g) => g.clientId));
    for (const [id, c] of this.clients) {
      if (!inUse.has(id) && now - c.registeredAt > UNUSED_CLIENT_TTL_MS) {
        this.clients.delete(id);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Saves pending changes (including last-use times) and waits for the write. */
  async flush(): Promise<void> {
    if (this.lastUsedDirty) this.save();
    await this.file.flush();
  }

  /** Stops the periodic save and prune; call on shutdown after flush(). */
  close(): void {
    for (const t of this.timers) clearInterval(t);
  }

  private view(g: StoredGrant): GrantView {
    return {
      id: g.id,
      clientId: g.clientId,
      clientName: g.clientName,
      email: g.email,
      redirectHost: g.redirectHost,
      createdAt: iso(g.createdAt),
      expiresAt: iso(g.expiresAt),
      ...(g.lastUsedAt !== undefined ? { lastUsedAt: iso(g.lastUsedAt) } : {}),
    };
  }
}
