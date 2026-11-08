/**
 * Published Search Console API usage limits.
 * Source: https://developers.google.com/webmaster-tools/limits (checked 2026-11-08).
 * Update this table if Google changes them.
 *
 * Search Analytics also has a "load" quota with no published numbers (10-minute
 * short-term and 1-day long-term windows). It is handled reactively by the
 * circuit breaker in retry.ts, plus caching to avoid repeating queries.
 */
export const GOOGLE_LIMITS = {
  searchAnalytics: {
    perSitePerMinute: 1_200,
    perUserPerMinute: 1_200,
    perProjectPerMinute: 40_000,
    perProjectPerDay: 30_000_000,
  },
  urlInspection: {
    perSitePerMinute: 600,
    perSitePerDay: 2_000,
    perProjectPerMinute: 15_000,
    perProjectPerDay: 10_000_000,
  },
  /** Sites, sitemaps and every other resource. */
  other: {
    perUserPerSecond: 20,
    perUserPerMinute: 200,
    perProjectPerDay: 100_000_000,
  },
} as const;

/** Google's advice: after a short-term load-quota error, wait 15 minutes. */
export const LOAD_QUOTA_COOLDOWN_MS = 15 * 60_000;

export type Bucket = 'searchAnalytics' | 'urlInspection' | 'other';

export interface WindowSpec {
  id: string;
  limit: number;
  windowMs: number;
}

export interface DailySpec {
  id: string;
  limit: number;
}

export interface BucketLimits {
  windows: WindowSpec[];
  daily: DailySpec[];
}

const MINUTE = 60_000;
const SECOND = 1_000;

/**
 * The limits enforced locally for one call, scaled by `safetyFactor`.
 * The server uses a single service account, so per-user and per-project
 * windows collapse into one global window per bucket. Project-level daily
 * quotas are unreachable at the per-minute rates and are not tracked.
 */
export function limitsFor(bucket: Bucket, siteUrl: string | undefined, safetyFactor: number): BucketLimits {
  const scale = (n: number) => Math.max(1, Math.floor(n * safetyFactor));
  switch (bucket) {
    case 'searchAnalytics': {
      const l = GOOGLE_LIMITS.searchAnalytics;
      const windows: WindowSpec[] = [
        { id: 'searchAnalytics:user:minute', limit: scale(Math.min(l.perUserPerMinute, l.perProjectPerMinute)), windowMs: MINUTE },
      ];
      if (siteUrl) windows.push({ id: `searchAnalytics:site:${siteUrl}:minute`, limit: scale(l.perSitePerMinute), windowMs: MINUTE });
      return { windows, daily: [] };
    }
    case 'urlInspection': {
      const l = GOOGLE_LIMITS.urlInspection;
      const windows: WindowSpec[] = [
        { id: 'urlInspection:project:minute', limit: scale(l.perProjectPerMinute), windowMs: MINUTE },
      ];
      const daily: DailySpec[] = [];
      if (siteUrl) {
        windows.push({ id: `urlInspection:site:${siteUrl}:minute`, limit: scale(l.perSitePerMinute), windowMs: MINUTE });
        daily.push({ id: `urlInspection:site:${siteUrl}:day`, limit: scale(l.perSitePerDay) });
      }
      return { windows, daily };
    }
    case 'other': {
      const l = GOOGLE_LIMITS.other;
      return {
        windows: [
          { id: 'other:user:second', limit: scale(l.perUserPerSecond), windowMs: SECOND },
          { id: 'other:user:minute', limit: scale(l.perUserPerMinute), windowMs: MINUTE },
        ],
        daily: [],
      };
    }
  }
}
