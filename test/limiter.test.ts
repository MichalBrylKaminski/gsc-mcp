import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GscToolError } from '../src/errors.js';
import { DailyCounters, RateLimiter, Semaphore, SlidingWindows } from '../src/limits/limiter.js';
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
});
