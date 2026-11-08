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
const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET']);

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
      data?: { error?: string | { message?: string; status?: string; errors?: { reason?: string }[] }; error_description?: string };
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
    if (reason && DAILY_REASONS.has(reason)) return { ...base, kind: 'dailyQuota' };
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
        retryAfterSeconds: Math.ceil((c.retryAfterMs ?? 60_000) / 1000),
      });
    case 'loadQuota':
      return new GscToolError(
        'LOAD_QUOTA_COOLDOWN',
        `Search Analytics load quota exceeded${site}. Use shorter date ranges, fewer page/query dimensions, or wait 15 minutes. Google said: ${c.message}`,
        { retryAfterSeconds: 15 * 60 },
      );
    case 'dailyQuota':
      return new GscToolError('GOOGLE_QUOTA_EXCEEDED', `Google daily quota exceeded: ${c.message}`);
    case 'server':
    case 'network':
      return new GscToolError('UPSTREAM_ERROR', `Google API is unavailable right now (${c.status ?? c.message}). Try again shortly.`);
    default:
      return new GscToolError('UPSTREAM_ERROR', `Google API error${c.status ? ` ${c.status}` : ''}: ${c.message}`);
  }
}
