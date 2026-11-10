/** Search Console dates and daily quotas use Pacific Time. */
const PT = 'America/Los_Angeles';
const HOUR = 3_600_000;

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: PT,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The Pacific Time calendar date (YYYY-MM-DD) at instant `ms`. */
export function ptDay(ms: number): string {
  return dayFormat.format(ms);
}

/** The instant of the next Pacific Time midnight after `ms`, correct across DST changes. */
export function nextPtMidnight(ms: number): number {
  const [h = 0, m = 0, s = 0] = clockFormat.format(ms).split(':').map(Number);
  const today = ptDay(ms);
  let candidate = ms - (ms % 1000) + (86_400 - (h * 3600 + m * 60 + s)) * 1000;
  // A 25-hour day (DST ends) puts the naive midnight at 23:00 of the same day.
  if (ptDay(candidate) === today) candidate += HOUR;
  // A 23-hour day (DST starts) puts it at 01:00 of the next day.
  else if (ptDay(candidate - HOUR) !== today) candidate -= HOUR;
  return candidate;
}

/** Adds `days` to a YYYY-MM-DD date string. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Waits `ms`, or less if `signal` aborts first (callers check `signal.aborted`). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
