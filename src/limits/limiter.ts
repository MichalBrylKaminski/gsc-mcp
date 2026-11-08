import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GscToolError } from '../errors.js';
import type { Logger } from '../logger.js';
import { nextPtMidnight, ptDay, sleep } from '../time.js';
import type { BucketLimits, WindowSpec } from './quotas.js';

/** Sliding-window request counters, keyed by WindowSpec.id. */
export class SlidingWindows {
  private hits = new Map<string, number[]>();

  private prune(spec: WindowSpec, now: number): number[] {
    const arr = this.hits.get(spec.id) ?? [];
    let drop = 0;
    while (drop < arr.length && arr[drop]! <= now - spec.windowMs) drop++;
    if (drop) arr.splice(0, drop);
    if (arr.length) this.hits.set(spec.id, arr);
    else this.hits.delete(spec.id);
    return arr;
  }

  /** Milliseconds until every window has room for one more request (0 = now). */
  waitTime(specs: WindowSpec[], now: number): number {
    let wait = 0;
    for (const spec of specs) {
      const arr = this.prune(spec, now);
      if (arr.length >= spec.limit) {
        const freesAt = arr[arr.length - spec.limit]! + spec.windowMs;
        wait = Math.max(wait, freesAt - now + 1);
      }
    }
    return wait;
  }

  record(specs: WindowSpec[], now: number): void {
    for (const spec of specs) {
      const arr = this.hits.get(spec.id) ?? [];
      arr.push(now);
      this.hits.set(spec.id, arr);
    }
  }

  used(spec: WindowSpec, now: number): number {
    return this.prune(spec, now).length;
  }
}

interface DailyState {
  day: string;
  counts: Record<string, number>;
}

/**
 * Per-day counters that reset at midnight Pacific Time (when Google resets
 * daily quotas). Saved to disk so a restart doesn't forget today's usage.
 */
export class DailyCounters {
  private state: DailyState = { day: '', counts: {} };
  private writing: Promise<void> | undefined;
  private dirty = false;

  constructor(
    private readonly file: string | undefined,
    private readonly logger?: Logger,
  ) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as DailyState;
      if (typeof saved.day === 'string' && saved.counts && typeof saved.counts === 'object') this.state = saved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger?.warn('quota state unreadable, starting fresh', { file });
    }
  }

  private current(now: number): DailyState {
    const day = ptDay(now);
    if (this.state.day !== day) this.state = { day, counts: {} };
    return this.state;
  }

  used(id: string, now: number): number {
    return this.current(now).counts[id] ?? 0;
  }

  increment(id: string, now: number): void {
    const s = this.current(now);
    s.counts[id] = (s.counts[id] ?? 0) + 1;
    this.persist();
  }

  snapshot(now: number): DailyState {
    const s = this.current(now);
    return { day: s.day, counts: { ...s.counts } };
  }

  private persist(): void {
    if (!this.file) return;
    this.dirty = true;
    if (this.writing) return;
    const file = this.file;
    this.writing = (async () => {
      mkdirSync(dirname(file), { recursive: true });
      while (this.dirty) {
        this.dirty = false;
        const tmp = `${file}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(this.state));
          await rename(tmp, file);
        } catch (err) {
          this.logger?.error('failed to save quota state', { file, error: (err as Error).message });
        }
      }
    })().finally(() => {
      this.writing = undefined;
    });
  }

  /** Waits for pending writes to finish. */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }
}

/** Limits how many Google calls run at once. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class RateLimiter {
  constructor(
    readonly windows: SlidingWindows,
    readonly daily: DailyCounters,
    private readonly maxWaitMs: number,
  ) {}

  /**
   * Takes one request slot from every window and daily counter in `limits`.
   * Waits (up to maxWaitMs) for a full minute/second window; fails at once on
   * an exhausted daily counter.
   */
  async acquire(limits: BucketLimits): Promise<void> {
    const start = Date.now();
    for (;;) {
      const now = Date.now();
      for (const d of limits.daily) {
        if (this.daily.used(d.id, now) >= d.limit) {
          const resetAt = new Date(nextPtMidnight(now));
          throw new GscToolError(
            'DAILY_QUOTA_EXHAUSTED',
            `Daily limit of ${d.limit} requests reached for ${d.id}. It resets at midnight Pacific Time (${resetAt.toISOString()}).`,
            { resetAt: resetAt.toISOString(), retryAfterSeconds: Math.ceil((resetAt.getTime() - now) / 1000) },
          );
        }
      }
      const wait = this.windows.waitTime(limits.windows, now);
      if (wait === 0) {
        this.windows.record(limits.windows, now);
        for (const d of limits.daily) this.daily.increment(d.id, now);
        return;
      }
      if (now - start + wait > this.maxWaitMs) {
        throw new GscToolError('LOCAL_RATE_LIMIT', 'Too many requests right now; the server is pacing calls to stay within Google limits.', {
          retryAfterSeconds: Math.ceil(wait / 1000),
        });
      }
      await sleep(wait);
    }
  }
}
