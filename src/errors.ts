import { nextPtMidnight } from './time.js';

export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SITE_NOT_ALLOWED'
  | 'LOCAL_RATE_LIMIT'
  | 'DAILY_QUOTA_EXHAUSTED'
  | 'LOAD_QUOTA_COOLDOWN'
  | 'GOOGLE_RATE_LIMIT'
  | 'GOOGLE_QUOTA_EXCEEDED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'AUTH_ERROR'
  | 'UPSTREAM_ERROR'
  | 'CANCELLED'
  | 'INTERNAL';

export interface ErrorDetails {
  retryAfterSeconds?: number;
  resetAt?: string;
  [key: string]: unknown;
}

/** An error whose message is safe to show to the MCP client. */
export class GscToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = 'GscToolError';
  }
}

export type GoogleErrorKind =
  | 'rateLimit' // short-term rate limit: retry with backoff
  | 'loadQuota' // Search Analytics load quota: back off for minutes
  | 'dailyQuota' // daily quota: retrying today won't help
  | 'server' // 5xx: retry with backoff
  | 'permission'
  | 'notFound'
  | 'badRequest'
  | 'auth'
  | 'network'
  | 'other';

export interface ClassifiedGoogleError {
  kind: GoogleErrorKind;
  status?: number;
  reason?: string;
  message: string;
  retryAfterMs?: number;
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'RESOURCE_EXHAUSTED']);
const DAILY_REASONS = new Set(['dailyLimitExceeded', 'dailyLimitExceededUnreg']);
// System error codes as surfaced by gaxios 8 (node-fetch) on Node.
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

function header(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const v = (headers as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : undefined;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Classifies an error thrown by the googleapis (gaxios) client. */
export function classifyGoogleError(err: unknown): ClassifiedGoogleError {
  const e = err as {
    status?: number;
    code?: string | number;
    message?: string;
    response?: {
      status?: number;
      headers?: unknown;
      data?: {
        error?: string | { message?: string; status?: string; errors?: { reason?: string }[]; details?: { metadata?: { quota_limit?: string } }[] };
        error_description?: string;
      };
    };
  };
  const status = e?.response?.status ?? (typeof e?.status === 'number' ? e.status : undefined);
  const data = e?.response?.data;
  const retryAfterMs = parseRetryAfter(header(e?.response?.headers, 'retry-after'));
  // The OAuth token endpoint answers with { error: "invalid_grant", error_description }.
  if (typeof data?.error === 'string') {
    return { kind: 'auth', status, reason: data.error, message: data.error_description ?? data.error, retryAfterMs };
  }
  const apiError = data?.error;
  const reason = apiError?.errors?.[0]?.reason ?? apiError?.status;
  const message = apiError?.message ?? e?.message ?? String(err);
  const base = { status, reason, message, retryAfterMs };

  if (status === undefined) {
    return { ...base, kind: typeof e?.code === 'string' && NETWORK_CODES.has(e.code) ? 'network' : 'other' };
  }
  if (status === 429 || (status === 403 && reason && (RATE_REASONS.has(reason) || DAILY_REASONS.has(reason)))) {
    // Newer Google errors report daily limits as RESOURCE_EXHAUSTED with a "per day" message or quota_limit.
    const perDay = /per day|daily/i.test(message) || (apiError?.details ?? []).some((d) => /PerDay/i.test(d.metadata?.quota_limit ?? ''));
    if ((reason && DAILY_REASONS.has(reason)) || perDay) return { ...base, kind: 'dailyQuota' };
    if (/load quota/i.test(message)) return { ...base, kind: 'loadQuota' };
    return { ...base, kind: 'rateLimit' };
  }
  if (status >= 500) return { ...base, kind: 'server' };
  if (status === 401) return { ...base, kind: 'auth' };
  if (status === 403) return { ...base, kind: 'permission' };
  if (status === 404) return { ...base, kind: 'notFound' };
  if (status === 400) return { ...base, kind: 'badRequest' };
  return { ...base, kind: 'other' };
}

/** The client went away, so the work was abandoned. */
export const cancelledError = () => new GscToolError('CANCELLED', 'The request was cancelled because the client disconnected.');

const deadlineErrors = new WeakSet<GscToolError>();

/** The caller's time budget (e.g. a batch's deadline) ran out. */
export function deadlineError(): GscToolError {
  const e = new GscToolError('LOCAL_RATE_LIMIT', 'Time limit reached before Google answered; retry the remaining work in another call.', {
    retryAfterSeconds: 1,
  });
  deadlineErrors.add(e);
  return e;
}

/** Whether `err` came from deadlineError(), i.e. one caller's own time budget. */
export const isDeadlineError = (err: unknown): boolean => err instanceof GscToolError && deadlineErrors.has(err);

/**
 * Google returns the same error for every exceeded quota, so a load-quota
 * error can't be told apart from a per-minute one. For Search Analytics the
 * local limiter already keeps under the per-minute limits, so a quota error
 * that still arrives is treated as load quota: wait 15 minutes, as Google advises.
 */
export function loadQuotaError(siteUrl: string | undefined, googleMessage: string): GscToolError {
  const site = siteUrl ? ` for "${siteUrl}"` : '';
  return new GscToolError(
    'LOAD_QUOTA_COOLDOWN',
    `Google reported a Search Analytics quota as exceeded${site} (most likely the load quota). ` +
      `Queries for this property are paused for 15 minutes; use shorter date ranges and fewer page/query dimensions. Google said: ${googleMessage}`,
    { retryAfterSeconds: 15 * 60 },
  );
}

/** How long to hold off after a rate limit that survived retries. */
export function rateLimitCooldownMs(c: ClassifiedGoogleError): number {
  return Math.max(c.retryAfterMs ?? 0, 60_000);
}

export interface ErrorContext {
  siteUrl?: string;
  serviceAccountEmail?: string;
}

/** Turns a Google API error into a GscToolError with an actionable message. */
export function toToolError(err: unknown, ctx: ErrorContext = {}): GscToolError {
  if (err instanceof GscToolError) return err;
  const c = classifyGoogleError(err);
  const site = ctx.siteUrl ? ` "${ctx.siteUrl}"` : '';
  switch (c.kind) {
    case 'permission':
      return new GscToolError(
        'PERMISSION_DENIED',
        `Google denied access to property${site}. In Search Console, open the property > Settings > Users and permissions, ` +
          `and add ${ctx.serviceAccountEmail ?? 'the service account email'} as a user. Google said: ${c.message}`,
      );
    case 'notFound':
      return new GscToolError(
        'NOT_FOUND',
        `Not found${site}. URL-prefix properties need the exact URL with a trailing slash (https://www.example.com/); ` +
          `domain properties use "sc-domain:example.com". Call list_sites to see valid values. Google said: ${c.message}`,
      );
    case 'badRequest':
      return new GscToolError('INVALID_ARGUMENT', `Google rejected the request: ${c.message}`);
    case 'auth':
      return new GscToolError(
        'AUTH_ERROR',
        `The server could not authenticate to Google${c.reason ? ` (${c.reason})` : ''}. ` +
          'Check that the service account key is valid, not deleted or disabled, and that the Search Console API is enabled in its Google Cloud project.',
      );
    case 'rateLimit':
      return new GscToolError('GOOGLE_RATE_LIMIT', `Google rate limit reached: ${c.message}`, {
        retryAfterSeconds: Math.ceil(rateLimitCooldownMs(c) / 1000),
      });
    case 'loadQuota':
      return loadQuotaError(ctx.siteUrl, c.message);
    case 'dailyQuota': {
      const resetAt = nextPtMidnight(Date.now());
      return new GscToolError('GOOGLE_QUOTA_EXCEEDED', `Google daily quota exceeded${site}; it resets at midnight Pacific Time. Google said: ${c.message}`, {
        resetAt: new Date(resetAt).toISOString(),
        retryAfterSeconds: Math.ceil((resetAt - Date.now()) / 1000),
      });
    }
    case 'server':
    case 'network':
      return new GscToolError('UPSTREAM_ERROR', `Google API is unavailable right now (${c.status ?? c.message}). Try again shortly.`);
    default:
      return new GscToolError('UPSTREAM_ERROR', `Google API error${c.status ? ` ${c.status}` : ''}: ${c.message}`);
  }
}
