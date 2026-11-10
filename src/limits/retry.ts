import { cancelledError, classifyGoogleError, type ClassifiedGoogleError } from '../errors.js';
import { sleep } from '../time.js';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Extra filter: return false to fail at once on an otherwise retryable error. */
  retryable?: (error: ClassifiedGoogleError) => boolean;
  /** Epoch ms; a retry that would sleep past it fails with the last error instead. */
  deadline?: number;
  /** Stops waiting between attempts when the caller goes away. */
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: ClassifiedGoogleError }) => void;
}

const RETRYABLE = new Set(['rateLimit', 'server', 'network']);

/**
 * Runs `fn`, retrying short-term rate limits and transient failures with
 * exponential backoff and full jitter, honouring Retry-After. Load-quota and
 * daily-quota errors are not retried: retrying soon cannot succeed.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 500, maxDelayMs = 8_000, retryable, deadline = Infinity, signal, onRetry } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const c = classifyGoogleError(err);
      if (attempt >= maxRetries || !RETRYABLE.has(c.kind) || (retryable && !retryable(c))) throw err;
      // A long Retry-After is better reported to the caller than slept through.
      if ((c.retryAfterMs ?? 0) > maxDelayMs * 4) throw err;
      const backoff = Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs = Math.max(backoff, c.retryAfterMs ?? 0);
      if (Date.now() + delayMs >= deadline) throw err;
      onRetry?.({ attempt: attempt + 1, delayMs, error: c });
      await sleep(delayMs, signal);
      if (signal?.aborted) throw cancelledError();
    }
  }
}

/** Blocks a key (e.g. one site's Search Analytics) for a cooldown period. */
export class CircuitBreaker {
  private entries = new Map<string, { until: number; reason: string }>();
  /** Called after every trip, e.g. to save the state. */
  onChange?: () => void;

  trip(key: string, ms: number, reason: string, now = Date.now()): void {
    if (!Number.isFinite(ms) || ms <= 0) return; // a NaN pause would never expire
    const prev = this.entries.get(key);
    if (prev && prev.until > now + ms) return;
    this.entries.set(key, { until: now + ms, reason });
    this.onChange?.();
  }

  /** The cooldowns still active at `now`, for saving. */
  snapshot(now = Date.now()): Record<string, { until: number; reason: string }> {
    return Object.fromEntries([...this.entries].filter(([, e]) => e.until > now));
  }

  /**
   * Loads saved cooldowns, skipping expired or malformed ones and any ending
   * more than `maxMs` from now (e.g. saved while the clock was far ahead).
   */
  restore(saved: unknown, maxMs: number, now = Date.now()): void {
    if (!saved || typeof saved !== 'object') return;
    for (const [key, e] of Object.entries(saved as Record<string, { until?: unknown; reason?: unknown }>)) {
      if (typeof e?.until !== 'number' || typeof e.reason !== 'string') continue;
      if (Number.isFinite(e.until) && e.until > now && e.until <= now + maxMs) this.entries.set(key, { until: e.until, reason: e.reason });
    }
  }

  /** The active cooldown for `key`, or undefined if it isn't blocked. */
  check(key: string, now = Date.now()): { remainingMs: number; reason: string } | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.until <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return { remainingMs: e.until - now, reason: e.reason };
  }
}
