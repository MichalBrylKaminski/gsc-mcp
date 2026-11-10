import { cacheKey, ResponseCache, TTL } from '../cache.js';
import { cancelledError, classifyGoogleError, deadlineError, GscToolError, isDeadlineError, toToolError, type ClassifiedGoogleError } from '../errors.js';
import { DailyCounters, JsonFile, RateLimiter, Semaphore, SlidingWindows } from '../limits/limiter.js';
import {
  GLOBAL_PAUSE_MIN_PROPERTIES,
  GLOBAL_PAUSE_MS,
  GLOBAL_PAUSE_TRIGGER_WINDOW_MS,
  GOOGLE_LIMITS,
  limitsFor,
  QUOTA_PAUSE_STEPS_MS,
  type Bucket,
} from '../limits/quotas.js';
import { CircuitBreaker, withRetry } from '../limits/retry.js';
import type { Logger } from '../logger.js';
import { nextPtMidnight, ptDay } from '../time.js';
import type { GscApi, InspectUrlIndexRequest, RequestOptions, SearchAnalyticsQueryRequest } from './client.js';

export interface GscServiceOptions {
  serviceAccountEmail: string;
  allowedSites?: string[];
  safetyFactor: number;
  maxQueueWaitMs: number;
  maxConcurrency: number;
  cacheEnabled: boolean;
  quotaStateFile?: string;
  /** Where quota pauses are saved, so a restart doesn't resume a paused property early. */
  pauseStateFile?: string;
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
  logger: Logger;
}

const invalidSite = (siteUrl: string) =>
  new GscToolError('INVALID_ARGUMENT', `"${siteUrl}" is not a valid property. Use "https://www.example.com/" or "sc-domain:example.com".`);

/**
 * GSC URL-prefix properties are exact http(s) URLs ending in "/"; domain
 * properties are "sc-domain:<host>". Fix the common slips (missing slash,
 * letter case) and reject anything else before it costs quota. Hosts are
 * parsed the way browsers do, so internationalized domains become punycode
 * (bücher.de -> xn--bcher-kva.de) on both properties and inspected URLs.
 */
export function normalizeSiteUrl(siteUrl: string): string {
  const s = siteUrl.trim();
  if (/^sc-domain:/i.test(s)) {
    const domain = s.slice('sc-domain:'.length);
    if (!domain || /[/\\?#@:\s]/.test(domain)) throw invalidSite(siteUrl);
    let host: string;
    try {
      host = new URL(`http://${domain}`).hostname;
    } catch {
      throw invalidSite(siteUrl);
    }
    if (!/^[^.]+(\.[^.]+)+$/.test(host)) throw invalidSite(siteUrl);
    return `sc-domain:${host}`;
  }
  // A bare "?" or "#" leaves u.search/u.hash empty, so check the raw string.
  if (/[?#]/.test(s)) throw invalidSite(siteUrl);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw invalidSite(siteUrl);
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) throw invalidSite(siteUrl);
  return `${u.origin}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`;
}

/** normalizeSiteUrl for values Google returned: never throws, so one odd property can't break a listing. */
export function normalizeKnownSiteUrl(siteUrl: string): string {
  try {
    return normalizeSiteUrl(siteUrl);
  } catch {
    return siteUrl.trim();
  }
}

/** Whether `url` belongs to property `site` (already normalized). */
export function urlInProperty(url: string, site: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (site.startsWith('sc-domain:')) {
    const domain = site.slice('sc-domain:'.length);
    return u.hostname === domain || u.hostname.endsWith(`.${domain}`);
  }
  return u.href.startsWith(site);
}

interface CallSpec<T> {
  tool: string;
  bucket: Bucket;
  siteUrl?: string;
  params: unknown;
  ttlMs: number;
  bypassCache?: boolean;
  /** Aborts waiting and the Google request when the client goes away. */
  signal?: AbortSignal;
  /** Epoch ms after which the call gives up, including any queueing and retries. */
  deadline?: number;
  run: (opts: RequestOptions) => Promise<T>;
}

/** Per-call cancellation, for callers that have a client signal or a time budget. */
export interface CallOptions {
  signal?: AbortSignal;
  deadline?: number;
}

const MAX_JOIN_ATTEMPTS = 3;

interface QuotaStrike {
  step: number;
  /** PT day of the pause; a new day starts the steps over. */
  day: string;
  /** When the latest pause began. */
  pausedAt: number;
}

interface PauseState {
  breaker?: unknown;
  strikes?: Record<string, QuotaStrike>;
}
const GLOBAL_ANALYTICS_KEY = 'searchAnalytics:*';

export class GscService {
  readonly limiter: RateLimiter;
  readonly breaker = new CircuitBreaker();
  private readonly cache: ResponseCache;
  private readonly semaphore: Semaphore;
  private readonly allowed?: Set<string>;
  /** Consecutive quota pauses per property (no success in between), to spot a used-up daily quota. */
  private readonly quotaStrikes = new Map<string, QuotaStrike>();
  private readonly pauseStore: JsonFile<PauseState>;
  private recentAnalyticsPauses: { site: string; at: number }[] = [];

  constructor(
    private readonly api: GscApi,
    readonly opts: GscServiceOptions,
  ) {
    this.limiter = new RateLimiter(new SlidingWindows(), new DailyCounters(opts.quotaStateFile, opts.logger), opts.maxQueueWaitMs);
    this.cache = new ResponseCache(opts.cacheEnabled);
    this.semaphore = new Semaphore(opts.maxConcurrency);
    if (opts.allowedSites?.length) this.allowed = new Set(opts.allowedSites.map(normalizeSiteUrl));
    this.pauseStore = new JsonFile(opts.pauseStateFile, 'pause state', opts.logger);
    const saved = this.pauseStore.read();
    const now = Date.now();
    // No pause outlasts the later of the next PT midnight and the longest short step (a 1-hour pause can
    // cross midnight), so anything longer is stale or corrupt, e.g. saved while the clock was far ahead.
    this.breaker.restore(saved?.breaker, Math.max(nextPtMidnight(now) - now, QUOTA_PAUSE_STEPS_MS.at(-1)!), now);
    const today = ptDay(now);
    for (const [key, st] of Object.entries(saved?.strikes && typeof saved.strikes === 'object' ? saved.strikes : {})) {
      const valid =
        Number.isInteger(st?.step) && st.step >= 0 && st.day === today && Number.isFinite(st.pausedAt) && st.pausedAt <= now;
      if (valid) this.quotaStrikes.set(key, { step: Math.min(st.step, QUOTA_PAUSE_STEPS_MS.length), day: st.day, pausedAt: st.pausedAt });
    }
    this.breaker.onChange = () => this.savePauses();
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
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const { value, hit } = await this.cache.getOrLoad(cacheKey(spec.tool, spec.params), spec.ttlMs, () => this.load(spec), spec.bypassCache);
          log.info('tool call', { tool: spec.tool, site: spec.siteUrl, cached: hit, ms: Date.now() - started });
          return { value, cached: hit };
        } catch (err) {
          // We may have joined another caller's in-flight call that was then cancelled or ran out of
          // its own time budget; that isn't our failure, so try again with our own call.
          const othersCancel = err instanceof GscToolError && err.code === 'CANCELLED' && !spec.signal?.aborted;
          const othersDeadline = isDeadlineError(err) && (spec.deadline === undefined || Date.now() < spec.deadline);
          if (!(othersCancel || othersDeadline) || attempt >= MAX_JOIN_ATTEMPTS) throw err;
        }
      }
    } catch (err) {
      const toolErr = toToolError(err, { siteUrl: spec.siteUrl, serviceAccountEmail: this.opts.serviceAccountEmail });
      log.warn('tool call failed', { tool: spec.tool, site: spec.siteUrl, code: toolErr.code, message: toolErr.message, ms: Date.now() - started });
      throw toolErr;
    }
  }

  /** One Google call through the breaker, concurrency cap, rate limiter and retries. */
  private async load<T>(spec: CallSpec<T>): Promise<T> {
    this.checkBreaker(spec);
    const limits = limitsFor(spec.bucket, spec.siteUrl, this.opts.safetyFactor);
    const { signal, deadline } = spec;
    const log = this.opts.logger;
    try {
      return await withRetry(
        () => {
          // Don't spend quota on a request whose caller has already given up.
          if (deadline !== undefined && Date.now() >= deadline) throw deadlineError();
          // One queueing budget per attempt, shared by the concurrency cap and the rate limiter.
          const queueDeadline = Math.min(Date.now() + this.opts.maxQueueWaitMs, deadline ?? Infinity);
          // Take the rate-limit slot only once a concurrency slot is held, so a
          // request is counted when it is actually sent.
          return this.semaphore.run(
            async () => {
              this.checkBreaker(spec); // before taking a rate-limit slot it wouldn't use
              await this.limiter.acquire(limits, { deadline: queueDeadline, signal });
              // Another call may have paused this site while we queued.
              this.checkBreaker(spec);
              const sentAt = Date.now();
              try {
                const value = await spec.run({ signal: requestSignal(signal, deadline) });
                // Google is serving this property again, so the next quota error starts at the shortest
                // pause. A request sent before the latest pause began proves nothing about it.
                const key = this.breakerKey(spec);
                const strike = key ? this.quotaStrikes.get(key) : undefined;
                if (key && strike && sentAt >= strike.pausedAt) {
                  this.quotaStrikes.delete(key);
                  this.savePauses();
                }
                return value;
              } catch (err) {
                // Record quota state before the slot is released, so queued calls see it.
                if (!signal?.aborted) this.noteQuotaError(spec, classifyGoogleError(err));
                throw err;
              }
            },
            queueDeadline - Date.now(),
            signal,
          );
        },
        {
          ...this.opts.retry,
          // Quota errors pause the property instead (see noteQuotaError): a retry only adds load or spends inspections.
          retryable: spec.bucket === 'other' ? undefined : (c) => c.kind !== 'rateLimit',
          deadline,
          signal,
          onRetry: ({ attempt, delayMs, error }) =>
            log.warn('retrying google call', { tool: spec.tool, site: spec.siteUrl, attempt, delayMs: Math.round(delayMs), status: error.status, reason: error.reason }),
        },
      );
    } catch (err) {
      if (err instanceof GscToolError) throw err;
      if (signal?.aborted) throw cancelledError();
      const c = classifyGoogleError(err);
      if (deadline !== undefined && Date.now() >= deadline && c.status === undefined) throw deadlineError();
      if (c.kind === 'loadQuota' || c.kind === 'rateLimit') {
        const open = this.openPause(spec);
        if (open) throw this.pauseError(spec, open, c.message);
      }
      throw err;
    }
  }

  /** The per-property pause key for buckets with quota pauses. */
  private breakerKey(spec: { bucket: Bucket; siteUrl?: string }): string | undefined {
    return spec.bucket !== 'other' && spec.siteUrl ? `${spec.bucket}:${spec.siteUrl}` : undefined;
  }

  /** The active pause for a call, if any: its property's, or the account-wide Search Analytics one. */
  private openPause(spec: { bucket: Bucket; siteUrl?: string }, now = Date.now()) {
    const key = this.breakerKey(spec);
    const site = key ? this.breaker.check(key, now) : undefined;
    const global = spec.bucket === 'searchAnalytics' ? this.breaker.check(GLOBAL_ANALYTICS_KEY, now) : undefined;
    if (site && global) return site.remainingMs >= global.remainingMs ? site : global;
    return site ?? global;
  }

  private checkBreaker(spec: CallSpec<unknown>): void {
    const open = this.openPause(spec);
    if (open) throw this.pauseError(spec, open);
  }

  private pauseError(spec: CallSpec<unknown>, open: { remainingMs: number; reason: string }, googleMessage?: string): GscToolError {
    const retryAfterSeconds = Math.ceil(open.remainingMs / 1000);
    const minutes = Math.ceil(retryAfterSeconds / 60);
    const what = spec.bucket === 'searchAnalytics' ? 'Search Analytics' : 'URL Inspection';
    const said = googleMessage ? ` Google said: ${googleMessage}` : '';
    if (open.reason === 'dailyQuota') {
      const resetAt = new Date(Date.now() + open.remainingMs).toISOString();
      return new GscToolError(
        'GOOGLE_QUOTA_EXCEEDED',
        `${what} for "${spec.siteUrl}" is paused until midnight Pacific Time (${resetAt}): Google reported a daily limit, or kept reporting ` +
          `its quota as exceeded after 15-minute and 1-hour pauses with no successful call, so today's quota is most likely used up.${said}`,
        { resetAt, retryAfterSeconds },
      );
    }
    if (open.reason === 'quotaGlobal') {
      return new GscToolError(
        'LOAD_QUOTA_COOLDOWN',
        `Search Analytics is paused for every property for ${minutes} min because Google reported quota errors on several properties ` +
          `within minutes (the load quota may apply to the whole account). Repeat earlier (cached) queries meanwhile.${said}`,
        { retryAfterSeconds },
      );
    }
    if (spec.bucket === 'urlInspection') {
      return new GscToolError(
        'GOOGLE_QUOTA_EXCEEDED',
        `URL Inspection for "${spec.siteUrl}" is paused for ${minutes} min because Google reported a quota as exceeded. This server stays ` +
          "under the per-minute limit, so this usually means the property's ~2,000 daily inspections are used up (other tools using the " +
          `property share them). If it keeps happening, the pause grows to 1 hour, then until midnight Pacific.${said}`,
        { retryAfterSeconds },
      );
    }
    return new GscToolError(
      'LOAD_QUOTA_COOLDOWN',
      `Search Analytics for "${spec.siteUrl}" is paused for ${minutes} min because Google reported a quota as exceeded (most likely its ` +
        `load quota). Use shorter date ranges and fewer page/query dimensions, or repeat earlier (cached) queries.${said}`,
      { retryAfterSeconds },
    );
  }

  /**
   * Records what a Google error says about quota, so later calls don't repeat it.
   * Google sends the same error for every exceeded quota, so a generic one
   * pauses the property: 15 minutes, then 1 hour, then until midnight Pacific
   * if errors keep coming with no successful call in between.
   */
  private noteQuotaError(spec: CallSpec<unknown>, c: ClassifiedGoogleError): void {
    const log = this.opts.logger;
    const key = this.breakerKey(spec);
    if (!key) return;
    const now = Date.now();
    if (c.kind === 'dailyQuota') {
      if (spec.bucket === 'urlInspection') {
        // Google's own daily limit, not the scaled one, so raising QUOTA_SAFETY_FACTOR can't reopen today.
        const daily = limitsFor('urlInspection', spec.siteUrl, this.opts.safetyFactor).daily[0]!;
        this.limiter.daily.fill(daily.id, GOOGLE_LIMITS.urlInspection.perSitePerDay, now);
      } else {
        this.breaker.trip(key, nextPtMidnight(now) - now, 'dailyQuota', now);
      }
      log.warn('google reported a daily quota exhausted', { bucket: spec.bucket, site: spec.siteUrl });
      return;
    }
    if (c.kind !== 'loadQuota' && c.kind !== 'rateLimit') return;
    // A request sent before a pause (this property's or the account-wide one) began; that pause already covers it.
    if (this.openPause(spec, now)) return;
    const today = ptDay(now);
    const prev = this.quotaStrikes.get(key);
    const step = prev && prev.day === today ? prev.step + 1 : 0;
    this.quotaStrikes.set(key, { step, day: today, pausedAt: now });
    const untilMidnight = step >= QUOTA_PAUSE_STEPS_MS.length;
    const ms = untilMidnight ? nextPtMidnight(now) - now : QUOTA_PAUSE_STEPS_MS[step]!;
    this.breaker.trip(key, ms, untilMidnight ? 'dailyQuota' : 'quota', now);
    log.warn('paused after google quota error', { bucket: spec.bucket, site: spec.siteUrl, step, pauseMs: ms });
    // Only first pauses count: a repeat on one property says nothing about the account.
    if (spec.bucket === 'searchAnalytics' && spec.siteUrl && step === 0) {
      this.recentAnalyticsPauses = this.recentAnalyticsPauses.filter((p) => now - p.at < GLOBAL_PAUSE_TRIGGER_WINDOW_MS);
      this.recentAnalyticsPauses.push({ site: spec.siteUrl, at: now });
      if (new Set(this.recentAnalyticsPauses.map((p) => p.site)).size >= GLOBAL_PAUSE_MIN_PROPERTIES) {
        this.recentAnalyticsPauses = [];
        this.breaker.trip(GLOBAL_ANALYTICS_KEY, GLOBAL_PAUSE_MS, 'quotaGlobal', now);
        log.warn('search analytics paused for every property', { pauseMs: GLOBAL_PAUSE_MS });
      }
    }
  }

  async listSites(bypassCache?: boolean, opts: CallOptions = {}) {
    const res = await this.call({
      tool: 'sites.list',
      bucket: 'other',
      params: {},
      ttlMs: TTL.sites,
      bypassCache,
      ...opts,
      run: (o) => this.api.listSites(o),
    });
    if (!this.allowed) return res;
    return { ...res, value: res.value.filter((s) => s.siteUrl && this.allowed!.has(normalizeKnownSiteUrl(s.siteUrl))) };
  }

  async getSite(siteUrl: string, bypassCache?: boolean, opts: CallOptions = {}) {
    const site = this.site(siteUrl);
    return this.call({
      tool: 'sites.get',
      bucket: 'other',
      siteUrl: site,
      params: { site },
      ttlMs: TTL.sites,
      bypassCache,
      ...opts,
      run: (o) => this.api.getSite(site, o),
    });
  }

  async listSitemaps(siteUrl: string, sitemapIndex?: string, bypassCache?: boolean, opts: CallOptions = {}) {
    const site = this.site(siteUrl);
    return this.call({
      tool: 'sitemaps.list',
      bucket: 'other',
      siteUrl: site,
      params: { site, sitemapIndex },
      ttlMs: TTL.sitemaps,
      bypassCache,
      ...opts,
      run: (o) => this.api.listSitemaps(site, sitemapIndex, o),
    });
  }

  async getSitemap(siteUrl: string, feedpath: string, bypassCache?: boolean, opts: CallOptions = {}) {
    const site = this.site(siteUrl);
    return this.call({
      tool: 'sitemaps.get',
      bucket: 'other',
      siteUrl: site,
      params: { site, feedpath },
      ttlMs: TTL.sitemaps,
      bypassCache,
      ...opts,
      run: (o) => this.api.getSitemap(site, feedpath, o),
    });
  }

  async querySearchAnalytics(siteUrl: string, request: SearchAnalyticsQueryRequest, bypassCache?: boolean, opts: CallOptions = {}) {
    const site = this.site(siteUrl);
    // Spell out Google's defaults so equivalent requests share a cache entry.
    const body: SearchAnalyticsQueryRequest = {
      ...request,
      dimensions: request.dimensions?.length ? request.dimensions : undefined,
      type: request.type ?? 'web',
      dataState: request.dataState ?? 'final',
      aggregationType: request.aggregationType ?? 'auto',
      rowLimit: request.rowLimit ?? 1_000,
      startRow: request.startRow ?? 0,
    };
    const fresh = body.dataState === 'all' || body.dataState === 'hourly_all';
    return this.call({
      tool: 'searchanalytics.query',
      bucket: 'searchAnalytics',
      siteUrl: site,
      params: { site, body },
      ttlMs: fresh ? TTL.analyticsFresh : TTL.analyticsFinal,
      bypassCache,
      ...opts,
      run: (o) => this.api.querySearchAnalytics(site, body, o),
    });
  }

  async inspectUrl(siteUrl: string, inspectionUrl: string, languageCode?: string, bypassCache?: boolean, opts: CallOptions = {}) {
    const site = this.site(siteUrl);
    if (!urlInProperty(inspectionUrl, site)) {
      throw new GscToolError('INVALID_ARGUMENT', `"${inspectionUrl}" is not part of property "${site}". Inspect only URLs within the property.`);
    }
    // Canonical form, so spelling variants of one URL share a cache entry and one daily inspection.
    const parsed = new URL(inspectionUrl);
    parsed.hash = ''; // Google ignores fragments
    const url = parsed.href;
    const body: InspectUrlIndexRequest = { siteUrl: site, inspectionUrl: url, languageCode: languageCode ?? 'en-US' };
    return this.call({
      tool: 'urlInspection.index.inspect',
      bucket: 'urlInspection',
      siteUrl: site,
      params: body,
      ttlMs: TTL.inspection,
      bypassCache,
      signal: opts.signal,
      deadline: opts.deadline,
      run: (o) => this.api.inspectUrl(body, o),
    });
  }

  /** Local view of quota usage. Google's own counters are in the Cloud console. */
  quotaStatus(siteUrls: string[]) {
    const now = Date.now();
    const sites = siteUrls.map((raw) => {
      const site = normalizeKnownSiteUrl(raw);
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
        // Google reporting the day as used up fills the counter past the local limit; show it as full.
        urlInspectionToday: { used: Math.min(used, daily.limit), limit: daily.limit, remaining: Math.max(0, daily.limit - used) },
        urlInspectionThisMinute: window(inspection),
        searchAnalyticsThisMinute: window(analytics),
        searchAnalyticsCooldownSeconds: Math.ceil((this.openPause({ bucket: 'searchAnalytics', siteUrl: site }, now)?.remainingMs ?? 0) / 1000),
        urlInspectionCooldownSeconds: Math.ceil((this.openPause({ bucket: 'urlInspection', siteUrl: site }, now)?.remainingMs ?? 0) / 1000),
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

  private savePauses(): void {
    this.pauseStore.save(() => ({ breaker: this.breaker.snapshot(), strikes: Object.fromEntries(this.quotaStrikes) }));
  }

  async flush(): Promise<void> {
    await Promise.all([this.limiter.daily.flush(), this.pauseStore.flush()]);
  }
}

/** The signal for one Google request: aborts on client disconnect or at the deadline. */
function requestSignal(signal: AbortSignal | undefined, deadline: number | undefined): AbortSignal | undefined {
  const parts = [signal, deadline === undefined ? undefined : AbortSignal.timeout(Math.max(1, deadline - Date.now()))].filter(
    (x): x is AbortSignal => x !== undefined,
  );
  return parts.length > 1 ? AbortSignal.any(parts) : parts[0];
}
