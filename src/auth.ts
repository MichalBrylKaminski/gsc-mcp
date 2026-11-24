import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthToken } from './config.js';
import type { Logger } from './logger.js';

const DAY_MS = 86_400_000;
/** Warn in the logs and in tool responses when a token has this many days or fewer left. */
export const EXPIRY_WARNING_DAYS = 14;

export interface TokenRegistryOptions {
  /** On: a token stops working at 00:00 UTC on its date. Off: no token ever expires, and dates are ignored. */
  autoExpire: boolean;
  logger: Logger;
}

/** What tools and logs may know about the client behind a request. */
export interface ClientInfo {
  name: string;
  /** Only with auto-expire. */
  expiresAt?: string;
  daysLeft?: number;
}

export type CheckResult = { kind: 'ok'; client: ClientInfo } | { kind: 'expired'; name: string } | { kind: 'unknown' };

interface Entry {
  label: string;
  digest: Buffer;
  expiresAtMs?: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** When a token dated `expiresOn` (YYYY-MM-DD) stops working: 00:00 UTC that day. */
export const expiryMs = (expiresOn: string) => Date.parse(`${expiresOn}T00:00:00Z`);

/**
 * A new random token whose expiry date is `ttlDays` from today (UTC), and the
 * entry to put in MCP_AUTH_TOKENS: "name:token:YYYY-MM-DD".
 */
export function issueToken(name: string, ttlDays: number, now = Date.now()) {
  const token = randomBytes(32).toString('hex');
  const expiresOn = utcDay(Date.parse(`${utcDay(now)}T00:00:00Z`) + ttlDays * DAY_MS);
  return { name, token, expiresOn, entry: `${name}:${token}:${expiresOn}` };
}

/**
 * The accepted bearer tokens. With auto-expire, the date on each token is the
 * only thing that ends it; nothing else is tracked.
 */
export class TokenRegistry {
  private readonly entries: Entry[];
  /** label -> the UTC day its "expires soon" warning was last logged. */
  private readonly warnedOn = new Map<string, string>();

  constructor(
    tokens: readonly AuthToken[],
    private readonly opts: TokenRegistryOptions,
  ) {
    this.entries = tokens.map((t) => ({
      label: t.label,
      digest: sha256(t.token),
      ...(opts.autoExpire && t.expiresOn ? { expiresAtMs: expiryMs(t.expiresOn) } : {}),
    }));

    const dated = tokens.filter((t) => t.expiresOn).map((t) => t.label);
    if (!opts.autoExpire && dated.length) {
      opts.logger.warn('token expiry dates are ignored because MCP_AUTH_AUTO_EXPIRE is off', { clients: dated });
    }
    const now = Date.now();
    for (const e of this.entries) {
      const info = this.info(e, now);
      if (info.daysLeft === undefined) continue;
      if (info.daysLeft <= 0) opts.logger.error('token expired', { client: e.label, expiresAt: info.expiresAt });
      else if (info.daysLeft <= EXPIRY_WARNING_DAYS) {
        opts.logger.warn('token expires soon', { client: e.label, expiresAt: info.expiresAt, daysLeft: info.daysLeft });
        this.warnedOn.set(e.label, utcDay(now));
      }
    }
  }

  private info(e: Entry, now: number): ClientInfo {
    if (e.expiresAtMs === undefined) return { name: e.label };
    return { name: e.label, expiresAt: new Date(e.expiresAtMs).toISOString(), daysLeft: Math.ceil((e.expiresAtMs - now) / DAY_MS) };
  }

  /** Each client's name and expiry, for the startup log. Never the token. */
  clients(): ClientInfo[] {
    const now = Date.now();
    return this.entries.map((e) => this.info(e, now));
  }

  /** Every token is compared, so the timing doesn't reveal which one matched. */
  check(given: string): CheckResult {
    const digest = sha256(given);
    let match: Entry | undefined;
    for (const e of this.entries) if (timingSafeEqual(digest, e.digest) && !match) match = e;
    if (!match) return { kind: 'unknown' };
    const now = Date.now();
    if (match.expiresAtMs !== undefined && now >= match.expiresAtMs) return { kind: 'expired', name: match.label };
    const client = this.info(match, now);
    if (client.daysLeft !== undefined && client.daysLeft <= EXPIRY_WARNING_DAYS && this.warnedOn.get(match.label) !== utcDay(now)) {
      this.warnedOn.set(match.label, utcDay(now));
      this.opts.logger.warn('token expires soon', { client: match.label, expiresAt: client.expiresAt, daysLeft: client.daysLeft });
    }
    return { kind: 'ok', client };
  }
}
