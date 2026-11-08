import { cacheKey, ResponseCache, TTL } from '../cache.js';
import { classifyGoogleError, GscToolError, toToolError } from '../errors.js';
import { DailyCounters, RateLimiter, Semaphore, SlidingWindows } from '../limits/limiter.js';
import { limitsFor, LOAD_QUOTA_COOLDOWN_MS, type Bucket } from '../limits/quotas.js';
import { CircuitBreaker, withRetry } from '../limits/retry.js';
import type { Logger } from '../logger.js';
import { nextPtMidnight } from '../time.js';
import type { GscApi, InspectUrlIndexRequest, SearchAnalyticsQueryRequest } from './client.js';

export interface GscServiceOptions {
  serviceAccountEmail: string;
  allowedSites?: string[];
  safetyFactor: number;
  maxQueueWaitMs: number;
  maxConcurrency: number;
  cacheEnabled: boolean;
  quotaStateFile?: string;
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
  logger: Logger;
}

/**
 * GSC URL-prefix properties are exact URLs ending in "/"; domain properties
 * are "sc-domain:<host>". Fix the common slips (missing slash, letter case).
 */
export function normalizeSiteUrl(siteUrl: string): string {
  const s = siteUrl.trim();
  if (/^sc-domain:/i.test(s)) return `sc-domain:${s.slice('sc-domain:'.length).toLowerCase()}`;
  try {
    const u = new URL(s);
    return u.pathname.endsWith('/') ? u.href : `${u.href}/`;
  } catch {
    throw new GscToolError('INVALID_ARGUMENT', `"${siteUrl}" is not a valid property. Use "https://www.example.com/" or "sc-domain:example.com".`);
  }
}

interface CallSpec<T> {
  tool: string;
  bucket: Bucket;
  siteUrl?: string;
  params: unknown;
  ttlMs: number;
  bypassCache?: boolean;
  run: () => Promise<T>;
}

export class GscService {
  readonly limiter: RateLimiter;
  readonly breaker = new CircuitBreaker();
  private readonly cache: ResponseCache;
  private readonly semaphore: Semaphore;
  private readonly allowed?: Set<string>;

  constructor(
    private readonly api: GscApi,
    readonly opts: GscServiceOptions,
  ) {
    this.limiter = new RateLimiter(new SlidingWindows(), new DailyCounters(opts.quotaStateFile, opts.logger), opts.maxQueueWaitMs);
    this.cache = new ResponseCache(opts.cacheEnabled);
    this.semaphore = new Semaphore(opts.maxConcurrency);
    if (opts.allowedSites?.length) this.allowed = new Set(opts.allowedSites.map(normalizeSiteUrl));
  }

  /** Normalizes a site URL and checks it against GSC_ALLOWED_SITES. */
  site(siteUrl: string): string {
    const s = normalizeSiteUrl(siteUrl);
    if (this.allowed && !this.allowed.has(s)) {
      throw new GscToolError('SITE_NOT_ALLOWED', `Property "${s}" is not in this server's allowlist. Call list_sites to see the allowed properties.`);
    }
    return s;
  }

  private async call<T>(spec: CallSpec<T>): Promise<{ value: T; cached: boolean }> {
    const started = Date.now();
    const log = this.opts.logger;
    const breakerKey = spec.bucket === 'searchAnalytics' && spec.siteUrl ? `searchAnalytics:${spec.siteUrl}` : undefined;
    try {
      const { value, hit } = await this.cache.getOrLoad(
        cacheKey(spec.tool, spec.params),
        spec.ttlMs,
        async () => {
          if (breakerKey) {
            const remaining = this.breaker.remaining(breakerKey);
            if (remaining > 0) {
              throw new GscToolError(
                'LOAD_QUOTA_COOLDOWN',
                `Search Analytics for "${spec.siteUrl}" is cooling down after Google reported its load quota as exceeded. ` +
                  `Retry in ${Math.ceil(remaining / 60_000)} min, or use cached/narrower queries.`,
                { retryAfterSeconds: Math.ceil(remaining / 1000) },
              );
            }
          }
          const limits = limitsFor(spec.bucket, spec.siteUrl, this.opts.safetyFactor);
          try {
            return await withRetry(
              async () => {
                await this.limiter.acquire(limits);
                return this.semaphore.run(spec.run);
              },
              {
                ...this.opts.retry,
                onRetry: ({ attempt, delayMs, error }) =>
                  log.warn('retrying google call', { tool: spec.tool, site: spec.siteUrl, attempt, delayMs: Math.round(delayMs), status: error.status, reason: error.reason }),
              },
            );
          } catch (err) {
            const kind = err instanceof GscToolError ? undefined : classifyGoogleError(err).kind;
            if (breakerKey && (kind === 'loadQuota' || kind === 'rateLimit')) {
              this.breaker.trip(breakerKey, LOAD_QUOTA_COOLDOWN_MS);
              log.warn('search analytics circuit opened', { site: spec.siteUrl, kind, cooldownMs: LOAD_QUOTA_COOLDOWN_MS });
            }
            throw err;
          }
        },
        spec.bypassCache,
      );
      log.info('tool call', { tool: spec.tool, site: spec.siteUrl, cached: hit, ms: Date.now() - started });
      return { value, cached: hit };
    } catch (err) {
      const toolErr = toToolError(err, { siteUrl: spec.siteUrl, serviceAccountEmail: this.opts.serviceAccountEmail });
      log.warn('tool call failed', { tool: spec.tool, site: spec.siteUrl, code: toolErr.code, ms: Date.now() - started });
      throw toolErr;
    }
  }

  async listSites(bypassCache?: boolean) {
    const res = await this.call({
      tool: 'sites.list',
      bucket: 'other',
      params: {},
      ttlMs: TTL.sites,
      bypassCache,
      run: () => this.api.listSites(),
    });
    if (!this.allowed) return res;
    return { ...res, value: res.value.filter((s) => s.siteUrl && this.allowed!.has(normalizeSiteUrl(s.siteUrl))) };
  }

  async getSite(siteUrl: string, bypassCache?: boolean) {
    const site = this.site(siteUrl);
    return this.call({
      tool: 'sites.get',
      bucket: 'other',
      siteUrl: site,
      params: { site },
      ttlMs: TTL.sites,
      bypassCache,
      run: () => this.api.getSite(site),
    });
  }

  async listSitemaps(siteUrl: string, sitemapIndex?: string, bypassCache?: boolean) {
    const site = this.site(siteUrl);
    return this.call({
      tool: 'sitemaps.list',
      bucket: 'other',
      siteUrl: site,
      params: { site, sitemapIndex },
      ttlMs: TTL.sitemaps,
      bypassCache,
      run: () => this.api.listSitemaps(site, sitemapIndex),
    });
  }

  async getSitemap(siteUrl: string, feedpath: string, bypassCache?: boolean) {
    const site = this.site(siteUrl);
    return this.call({
      tool: 'sitemaps.get',
      bucket: 'other',
      siteUrl: site,
      params: { site, feedpath },
      ttlMs: TTL.sitemaps,
      bypassCache,
      run: () => this.api.getSitemap(site, feedpath),
    });
  }

  async querySearchAnalytics(siteUrl: string, body: SearchAnalyticsQueryRequest, bypassCache?: boolean) {
    const site = this.site(siteUrl);
    const fresh = body.dataState === 'all' || body.dataState === 'hourly_all';
    return this.call({
      tool: 'searchanalytics.query',
      bucket: 'searchAnalytics',
      siteUrl: site,
      params: { site, body },
      ttlMs: fresh ? TTL.analyticsFresh : TTL.analyticsFinal,
      bypassCache,
      run: () => this.api.querySearchAnalytics(site, body),
    });
  }

  async inspectUrl(siteUrl: string, inspectionUrl: string, languageCode?: string, bypassCache?: boolean) {
    const site = this.site(siteUrl);
    const body: InspectUrlIndexRequest = { siteUrl: site, inspectionUrl, languageCode };
    return this.call({
      tool: 'urlInspection.index.inspect',
      bucket: 'urlInspection',
      siteUrl: site,
      params: body,
      ttlMs: TTL.inspection,
      bypassCache,
      run: () => this.api.inspectUrl(body),
    });
  }

  /** Local view of quota usage. Google's own counters are in the Cloud console. */
  quotaStatus(siteUrls: string[]) {
    const now = Date.now();
    const sites = siteUrls.map((raw) => {
      const site = normalizeSiteUrl(raw);
      const inspection = limitsFor('urlInspection', site, this.opts.safetyFactor);
      const analytics = limitsFor('searchAnalytics', site, this.opts.safetyFactor);
      const daily = inspection.daily[0]!;
      const used = this.limiter.daily.used(daily.id, now);
      const window = (l: typeof analytics) => {
        const w = l.windows.find((x) => x.id.includes(':site:'))!;
        return { used: this.limiter.windows.used(w, now), limit: w.limit };
      };
      return {
        siteUrl: site,
        urlInspectionToday: { used, limit: daily.limit, remaining: Math.max(0, daily.limit - used) },
        urlInspectionThisMinute: window(inspection),
        searchAnalyticsThisMinute: window(analytics),
        searchAnalyticsCooldownSeconds: Math.ceil(this.breaker.remaining(`searchAnalytics:${site}`, now) / 1000),
      };
    });
    const other = limitsFor('other', undefined, this.opts.safetyFactor).windows.map((w) => ({
      window: w.id,
      used: this.limiter.windows.used(w, now),
      limit: w.limit,
    }));
    return {
      dailyResetAt: new Date(nextPtMidnight(now)).toISOString(),
      safetyFactor: this.opts.safetyFactor,
      sites,
      sitesAndSitemaps: other,
    };
  }

  flush(): Promise<void> {
    return this.limiter.daily.flush();
  }
}
