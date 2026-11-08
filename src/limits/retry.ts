import { classifyGoogleError, type ClassifiedGoogleError } from '../errors.js';
import { sleep } from '../time.js';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; error: ClassifiedGoogleError }) => void;
}

const RETRYABLE = new Set(['rateLimit', 'server', 'network']);

/**
 * Runs `fn`, retrying short-term rate limits and transient failures with
 * exponential backoff and full jitter, honouring Retry-After. Load-quota and
 * daily-quota errors are not retried: retrying soon cannot succeed.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 500, maxDelayMs = 8_000, onRetry } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const c = classifyGoogleError(err);
      if (attempt >= maxRetries || !RETRYABLE.has(c.kind)) throw err;
      // A long Retry-After is better reported to the caller than slept through.
      if ((c.retryAfterMs ?? 0) > maxDelayMs * 4) throw err;
      const backoff = Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs = Math.max(backoff, c.retryAfterMs ?? 0);
      onRetry?.({ attempt: attempt + 1, delayMs, error: c });
      await sleep(delayMs);
    }
  }
}

/** Blocks a key (e.g. one site's Search Analytics) for a cooldown period. */
export class CircuitBreaker {
  private openUntil = new Map<string, number>();

  trip(key: string, ms: number, now = Date.now()): void {
    this.openUntil.set(key, now + ms);
  }

  /** Remaining cooldown in ms, or 0 if the key is not blocked. */
  remaining(key: string, now = Date.now()): number {
    const until = this.openUntil.get(key);
    if (until === undefined) return 0;
    if (until <= now) {
      this.openUntil.delete(key);
      return 0;
    }
    return until - now;
  }

  open(now = Date.now()): { key: string; remainingMs: number }[] {
    return [...this.openUntil.keys()].map((key) => ({ key, remainingMs: this.remaining(key, now) })).filter((e) => e.remainingMs > 0);
  }
}
