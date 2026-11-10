import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cancelledError, GscToolError } from '../errors.js';
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

/**
 * Fails fast if `dir` can't hold the quota state. Without it the per-site
 * daily URL inspection counter would silently reset on every restart.
 */
export function ensureWritableDir(dir: string): void {
  const probe = join(dir, `.write-test-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, 'ok');
    renameSync(probe, `${probe}.renamed`);
    unlinkSync(`${probe}.renamed`);
  } catch (err) {
    throw new Error(
      `DATA_DIR "${dir}" is not writable (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). ` +
        'Daily quota counters must persist across restarts; mount a writable volume there (the container runs as uid 1000).',
    );
  }
}

/**
 * A JSON state file saved atomically (temp file, fsync, rename) with coalesced
 * writes. Failures are logged, never thrown: in-memory state stays authoritative.
 */
export class JsonFile<T> {
  private writing: Promise<void> | undefined;
  private dirty = false;
  private latest: (() => T) | undefined;

  constructor(
    readonly file: string | undefined,
    private readonly label: string,
    private readonly logger?: Logger,
  ) {}

  read(): T | undefined {
    if (!this.file) return undefined;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger?.warn(`${this.label} unreadable, starting fresh`, { file: this.file });
      return undefined;
    }
  }

  /** Schedules a save of `data()`, evaluated when the write happens. */
  save(data: () => T): void {
    if (!this.file) return;
    this.latest = data;
    this.dirty = true;
    if (this.writing) return;
    const file = this.file;
    this.writing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const tmp = `${file}.tmp`;
        try {
          await mkdir(dirname(file), { recursive: true });
          // flush: fsync before rename, so a crash can't leave an empty state file.
          await writeFile(tmp, JSON.stringify(this.latest!()), { flush: true });
          await rename(tmp, file);
        } catch (err) {
          this.logger?.error(`failed to save ${this.label}`, { file, error: (err as Error).message });
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
  private readonly store: JsonFile<DailyState>;

  constructor(file: string | undefined, logger?: Logger) {
    this.store = new JsonFile(file, 'quota state', logger);
    const saved = this.store.read();
    if (saved && typeof saved.day === 'string' && saved.counts && typeof saved.counts === 'object') this.state = saved;
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

  /** Raises a counter to at least `value`, e.g. when Google says today's quota is used up. */
  fill(id: string, value: number, now: number): void {
    const s = this.current(now);
    if ((s.counts[id] ?? 0) >= value) return;
    s.counts[id] = value;
    this.persist();
  }

  private persist(): void {
    this.store.save(() => this.state);
  }

  /** Waits for pending writes to finish. */
  flush(): Promise<void> {
    return this.store.flush();
  }
}

/** Limits how many Google calls run at once. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  /**
   * Runs `fn` when a slot is free; fails if no slot frees up within
   * `maxWaitMs`, or if `signal` aborts while waiting.
   */
  async run<T>(fn: () => Promise<T>, maxWaitMs = Infinity, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw cancelledError();
    if (this.active < this.max) this.active++;
    else await this.wait(maxWaitMs, signal); // release() hands its slot straight to us
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private release(): void {
    const next = this.queue.shift();
    // Pass the slot on without freeing it, so a newcomer can't slip in between.
    if (next) next();
    else this.active--;
  }

  private wait(maxWaitMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter = () => {
        cleanup();
        resolve();
      };
      const leave = (err: Error) => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        cleanup();
        reject(err);
      };
      const onAbort = () => leave(cancelledError());
      if (Number.isFinite(maxWaitMs)) {
        timer = setTimeout(
          () =>
            leave(
              new GscToolError('LOCAL_RATE_LIMIT', 'The server is busy with other Google calls; try again shortly.', {
                retryAfterSeconds: Math.max(1, Math.ceil(maxWaitMs / 1000)),
              }),
            ),
          Math.max(0, maxWaitMs),
        );
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
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
   * Waits for a full minute/second window until `deadline` (default: now +
   * maxWaitMs); fails at once on an exhausted daily counter.
   */
  async acquire(limits: BucketLimits, opts: { deadline?: number; signal?: AbortSignal } = {}): Promise<void> {
    const deadline = opts.deadline ?? Date.now() + this.maxWaitMs;
    for (;;) {
      if (opts.signal?.aborted) throw cancelledError();
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
      if (now + wait > deadline) {
        throw new GscToolError('LOCAL_RATE_LIMIT', 'Too many requests right now; the server is pacing calls to stay within Google limits.', {
          retryAfterSeconds: Math.ceil(wait / 1000),
        });
      }
      await sleep(wait, opts.signal);
    }
  }
}
