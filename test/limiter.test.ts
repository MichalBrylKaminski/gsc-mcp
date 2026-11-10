import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GscToolError } from '../src/errors.js';
import { DailyCounters, ensureWritableDir, RateLimiter, Semaphore, SlidingWindows } from '../src/limits/limiter.js';
import { limitsFor } from '../src/limits/quotas.js';
import { nextPtMidnight, ptDay } from '../src/time.js';

const spec = { id: 'w', limit: 3, windowMs: 60_000 };

describe('SlidingWindows', () => {
  it('allows up to the limit, then reports when the oldest hit expires', () => {
    const w = new SlidingWindows();
    for (let t = 0; t < 3; t++) {
      expect(w.waitTime([spec], 1000 + t)).toBe(0);
      w.record([spec], 1000 + t);
    }
    expect(w.waitTime([spec], 2000)).toBe(1000 + 60_000 - 2000 + 1);
    expect(w.waitTime([spec], 61_001)).toBe(0);
  });

  it('takes the longest wait across windows', () => {
    const w = new SlidingWindows();
    const sec = { id: 's', limit: 1, windowMs: 1000 };
    w.record([spec, sec], 0);
    expect(w.waitTime([spec, sec], 10)).toBe(991);
  });
});

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('waits for a free slot when within maxWaitMs', async () => {
    const limiter = new RateLimiter(new SlidingWindows(), new DailyCounters(undefined), 120_000);
    const limits = { windows: [{ id: 'x', limit: 1, windowMs: 60_000 }], daily: [] };
    await limiter.acquire(limits);
    let done = false;
    const p = limiter.acquire(limits).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(done).toBe(true);
  });

  it('fails with retryAfterSeconds when the wait is too long', async () => {
    const limiter = new RateLimiter(new SlidingWindows(), new DailyCounters(undefined), 1_000);
    const limits = { windows: [{ id: 'x', limit: 1, windowMs: 60_000 }], daily: [] };
    await limiter.acquire(limits);
    const err = await limiter.acquire(limits).catch((e) => e);
    expect(err).toBeInstanceOf(GscToolError);
    expect(err.code).toBe('LOCAL_RATE_LIMIT');
    expect(err.details.retryAfterSeconds).toBe(61);
  });

  it('shares one deadline instead of its own maxWaitMs when given one', async () => {
    const limiter = new RateLimiter(new SlidingWindows(), new DailyCounters(undefined), 120_000);
    const limits = { windows: [{ id: 'x', limit: 1, windowMs: 60_000 }], daily: [] };
    await limiter.acquire(limits);
    await expect(limiter.acquire(limits, { deadline: Date.now() + 1_000 })).rejects.toMatchObject({ code: 'LOCAL_RATE_LIMIT' });
  });

  it('enforces the per-site daily URL inspection limit and resets at PT midnight', async () => {
    const limiter = new RateLimiter(new SlidingWindows(), new DailyCounters(undefined), 0);
    const limits = { windows: [], daily: [{ id: 'd', limit: 2 }] };
    await limiter.acquire(limits);
    await limiter.acquire(limits);
    const err = await limiter.acquire(limits).catch((e) => e);
    expect(err.code).toBe('DAILY_QUOTA_EXHAUSTED');
    expect(err.details.resetAt).toBe(new Date(nextPtMidnight(Date.now())).toISOString());

    vi.setSystemTime(nextPtMidnight(Date.now()));
    await expect(limiter.acquire(limits)).resolves.toBeUndefined();
  });

  it('applies the safety factor to Google limits', () => {
    const l = limitsFor('urlInspection', 'sc-domain:a.com', 0.8);
    expect(l.daily[0]).toEqual({ id: 'urlInspection:site:sc-domain:a.com:day', limit: 1600 });
    expect(l.windows.find((w) => w.id.includes(':site:'))?.limit).toBe(480);
    const o = limitsFor('other', undefined, 0.8);
    expect(o.windows.map((w) => w.limit)).toEqual([16, 160]);
  });
});

describe('DailyCounters persistence', () => {
  it('survives a restart on the same PT day and resets on a new one', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gsc-mcp-')), 'quota.json');
    const now = Date.parse('2026-11-08T20:00:00Z');
    const a = new DailyCounters(file);
    a.increment('d', now);
    a.increment('d', now);
    await a.flush();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ day: ptDay(now), counts: { d: 2 } });

    const b = new DailyCounters(file);
    expect(b.used('d', now)).toBe(2);
    expect(b.used('d', now + 24 * 3_600_000)).toBe(0);
  });
});

describe('quota state directory', () => {
  it('rejects a DATA_DIR that cannot be written at startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsc-mcp-'));
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, '');
    expect(() => ensureWritableDir(join(file, 'data'))).toThrow(/not writable/);
    expect(() => ensureWritableDir(join(dir, 'data'))).not.toThrow();
  });

  it('logs instead of crashing when a later save fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsc-mcp-'));
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, '');
    const error = vi.fn();
    const counters = new DailyCounters(join(file, 'data', 'quota.json'), { debug() {}, info() {}, warn() {}, error });
    counters.increment('d', Date.now());
    await counters.flush();
    expect(error).toHaveBeenCalledWith('failed to save quota state', expect.anything());
    expect(counters.used('d', Date.now())).toBe(1);
  });

  it('fill raises a counter but never lowers it', () => {
    const c = new DailyCounters(undefined);
    const now = Date.now();
    c.fill('d', 5, now);
    c.fill('d', 3, now);
    expect(c.used('d', now)).toBe(5);
  });
});

describe('PT time helpers', () => {
  it('finds the next Pacific midnight, including on DST change days', () => {
    // Normal day (PST, UTC-8).
    expect(new Date(nextPtMidnight(Date.parse('2026-11-08T20:00:00Z'))).toISOString()).toBe('2026-11-09T08:00:00.000Z');
    // 2026-11-01 is 25 hours long (PDT -> PST).
    expect(new Date(nextPtMidnight(Date.parse('2026-11-01T08:00:00Z'))).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    // 2026-03-08 is 23 hours long (PST -> PDT).
    expect(new Date(nextPtMidnight(Date.parse('2026-03-08T09:00:00Z'))).toISOString()).toBe('2026-03-09T07:00:00.000Z');
  });
});

describe('Semaphore', () => {
  it('runs at most N tasks at once', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it('hands a freed slot to the next waiter, so a newcomer cannot overshoot', async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let peak = 0;
    const track = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    };
    let releaseA!: () => void;
    const a = sem.run(async () => {
      active++;
      await new Promise<void>((r) => (releaseA = r));
      active--;
    });
    const b = sem.run(track);
    releaseA();
    // Arrives in the gap between A releasing and B resuming.
    const c = a.then(() => sem.run(track));
    await Promise.all([a, b, c]);
    expect(peak).toBe(1);
  });

  it('stops waiting when the caller aborts', async () => {
    const sem = new Semaphore(1);
    let release!: () => void;
    const busy = sem.run(() => new Promise<void>((r) => (release = r)));
    const controller = new AbortController();
    const waiting = sem.run(async () => 'never', Infinity, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
    release();
    await busy;
    await expect(sem.run(async () => 'free')).resolves.toBe('free');
  });

  it('gives up waiting for a slot after maxWaitMs', async () => {
    const sem = new Semaphore(1);
    let release!: () => void;
    const busy = sem.run(() => new Promise<void>((r) => (release = r)));
    await expect(sem.run(async () => 'late', 10)).rejects.toMatchObject({ code: 'LOCAL_RATE_LIMIT' });
    // The timed-out waiter must not hold a place in the queue.
    const next = sem.run(async () => 'next', 1_000);
    release();
    await busy;
    await expect(next).resolves.toBe('next');
  });
});
