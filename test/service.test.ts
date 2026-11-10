import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSiteUrl, urlInProperty } from '../src/google/service.js';
import { fakeApi, googleError, makeService } from './helpers.js';

const DAILY_ID = 'urlInspection:site:sc-domain:a.com:day';

describe('normalizeSiteUrl', () => {
  it('adds the trailing slash and lowercases domain properties', () => {
    expect(normalizeSiteUrl('https://www.example.com')).toBe('https://www.example.com/');
    expect(normalizeSiteUrl('https://www.example.com/blog/')).toBe('https://www.example.com/blog/');
    expect(normalizeSiteUrl('SC-DOMAIN:Example.COM')).toBe('sc-domain:example.com');
  });

  it('accepts internationalized and underscore domains, as punycode', () => {
    expect(normalizeSiteUrl('sc-domain:bücher.de')).toBe('sc-domain:xn--bcher-kva.de');
    expect(normalizeSiteUrl('sc-domain:xn--bcher-kva.de')).toBe('sc-domain:xn--bcher-kva.de');
    expect(normalizeSiteUrl('sc-domain:my_host.example.com')).toBe('sc-domain:my_host.example.com');
    expect(normalizeSiteUrl('https://bücher.de/Blog')).toBe('https://xn--bcher-kva.de/Blog/');
    expect(urlInProperty('https://www.bücher.de/x', normalizeSiteUrl('sc-domain:bücher.de'))).toBe(true);
  });

  it('rejects things that cannot be properties', () => {
    for (const bad of [
      'example',
      'javascript:alert(1)',
      'mailto:a@b.com',
      'https://a.com/x?y=1',
      'https://a.com/#top',
      'https://a.com/blog?',
      'https://a.com/blog#',
      'https://u:p@a.com/',
      'sc-domain:',
      'sc-domain:a b.com',
      'sc-domain:a.com/x',
      'sc-domain:a.com:443',
      'sc-domain:localhost',
    ]) {
      expect(() => normalizeSiteUrl(bad), bad).toThrow(/not a valid property/);
    }
  });
});

describe('urlInProperty', () => {
  it('matches URL-prefix properties by prefix and domain properties by host', () => {
    expect(urlInProperty('https://www.a.com/blog/x', 'https://www.a.com/blog/')).toBe(true);
    expect(urlInProperty('https://www.a.com/other', 'https://www.a.com/blog/')).toBe(false);
    expect(urlInProperty('http://www.a.com/blog/x', 'https://www.a.com/blog/')).toBe(false);
    expect(urlInProperty('https://WWW.A.COM/blog/x', 'https://www.a.com/blog/')).toBe(true);
    expect(urlInProperty('https://a.com/', 'sc-domain:a.com')).toBe(true);
    expect(urlInProperty('http://shop.a.com/x', 'sc-domain:a.com')).toBe(true);
    expect(urlInProperty('https://evila.com/', 'sc-domain:a.com')).toBe(false);
    expect(urlInProperty('ftp://a.com/', 'sc-domain:a.com')).toBe(false);
  });
});

describe('GscService caching', () => {
  it('caches identical requests', async () => {
    const getSite = vi.fn(async (siteUrl: string) => ({ siteUrl }));
    const service = makeService(fakeApi({ getSite }));
    const a = await service.getSite('https://www.example.com');
    const b = await service.getSite('https://www.example.com/');
    expect(getSite).toHaveBeenCalledTimes(1);
    expect([a.cached, b.cached]).toEqual([false, true]);
    await service.getSite('https://www.example.com/', true);
    expect(getSite).toHaveBeenCalledTimes(2);
  });

  it("treats Google's defaults as equal to omitted fields", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const service = makeService(fakeApi({ querySearchAnalytics: query }));
    const range = { startDate: '2026-10-01', endDate: '2026-10-31' };
    await service.querySearchAnalytics('sc-domain:a.com', range);
    await service.querySearchAnalytics('sc-domain:a.com', { ...range, dataState: 'final', type: 'web', aggregationType: 'auto', rowLimit: 1000, startRow: 0 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('shares one Google call between concurrent identical requests', async () => {
    let release!: () => void;
    const getSite = vi.fn(() => new Promise<{ siteUrl: string }>((r) => (release = () => r({ siteUrl: 'sc-domain:a.com' }))));
    const service = makeService(fakeApi({ getSite }));
    const both = Promise.all([service.getSite('sc-domain:a.com'), service.getSite('sc-domain:a.com')]);
    await vi.waitFor(() => expect(getSite).toHaveBeenCalled());
    release();
    const results = await both;
    expect(getSite).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.cached)).toEqual([false, false]);
  });
});

describe('GscService allowlist', () => {
  it('applies to every operation, including list_sites', async () => {
    const api = fakeApi();
    const spies = [vi.spyOn(api, 'getSite'), vi.spyOn(api, 'querySearchAnalytics'), vi.spyOn(api, 'inspectUrl'), vi.spyOn(api, 'listSitemaps')];
    const service = makeService(api, { allowedSites: ['sc-domain:example.org'] });
    expect((await service.listSites()).value.map((s) => s.siteUrl)).toEqual(['sc-domain:example.org']);
    const blocked = 'https://www.example.com/';
    await expect(service.getSite(blocked)).rejects.toMatchObject({ code: 'SITE_NOT_ALLOWED' });
    await expect(service.listSitemaps(blocked)).rejects.toMatchObject({ code: 'SITE_NOT_ALLOWED' });
    await expect(service.querySearchAnalytics(blocked, { startDate: '2026-10-01', endDate: '2026-10-02' })).rejects.toMatchObject({ code: 'SITE_NOT_ALLOWED' });
    await expect(service.inspectUrl(blocked, 'https://www.example.com/x')).rejects.toMatchObject({ code: 'SITE_NOT_ALLOWED' });
    expect(() => service.site(blocked)).toThrow(/allowlist/);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('never fails on unusual property values returned by Google', async () => {
    const odd = 'sc-domain:weird value';
    const api = fakeApi({ listSites: async () => [{ siteUrl: odd }, { siteUrl: 'sc-domain:bücher.de' }, { siteUrl: 'sc-domain:a.com' }] });
    const service = makeService(api, { allowedSites: ['sc-domain:xn--bcher-kva.de'] });
    expect((await service.listSites()).value.map((s) => s.siteUrl)).toEqual(['sc-domain:bücher.de']);
    expect(service.quotaStatus([odd, 'sc-domain:bücher.de']).sites.map((s) => s.siteUrl)).toEqual([odd, 'sc-domain:xn--bcher-kva.de']);
  });
});

describe('GscService quota handling', () => {
  const body = { startDate: '2026-10-01', endDate: '2026-10-31' };

  it('pauses a site for 15 minutes after a load-quota error', async () => {
    const query = vi.fn().mockRejectedValue(googleError(429, 'rateLimitExceeded', 'Search Analytics load quota exceeded'));
    const service = makeService(fakeApi({ querySearchAnalytics: query }));
    await expect(service.querySearchAnalytics('sc-domain:a.com', body)).rejects.toMatchObject({ code: 'LOAD_QUOTA_COOLDOWN' });
    const second = await service.querySearchAnalytics('sc-domain:a.com', { ...body, endDate: '2026-10-30' }).catch((e) => e);
    expect(second).toMatchObject({ code: 'LOAD_QUOTA_COOLDOWN', message: expect.stringContaining('load quota') });
    expect(second.details.retryAfterSeconds).toBeGreaterThan(895);
    expect(query).toHaveBeenCalledTimes(1);
    // Other sites are unaffected.
    query.mockResolvedValue({ rows: [] });
    await expect(service.querySearchAnalytics('sc-domain:b.com', body)).resolves.toBeDefined();
  });

  it('treats any Search Analytics quota error as load quota: no retries, 15-minute pause', async () => {
    // Google sends the same error for every exceeded quota, so a generic one may be the load quota.
    for (const [status, reason] of [[429, 'rateLimitExceeded'], [403, 'quotaExceeded'], [429, 'RESOURCE_EXHAUSTED']] as const) {
      const query = vi.fn().mockRejectedValue(googleError(status, reason, 'Quota exceeded'));
      const service = makeService(fakeApi({ querySearchAnalytics: query }));
      const first = await service.querySearchAnalytics('sc-domain:a.com', body).catch((e) => e);
      expect(first).toMatchObject({ code: 'LOAD_QUOTA_COOLDOWN', details: { retryAfterSeconds: 900 } });
      expect(query).toHaveBeenCalledTimes(1);
      const second = await service.querySearchAnalytics('sc-domain:a.com', { ...body, endDate: '2026-10-30' }).catch((e) => e);
      expect(second.code).toBe('LOAD_QUOTA_COOLDOWN');
      expect(query).toHaveBeenCalledTimes(1);
      expect(service.quotaStatus(['sc-domain:a.com']).sites[0]?.searchAnalyticsCooldownSeconds).toBeGreaterThan(895);
    }
  });

  it('pauses Search Analytics until PT midnight on a daily quota error', async () => {
    const query = vi.fn().mockRejectedValue(googleError(403, 'dailyLimitExceeded', 'Daily Limit Exceeded'));
    const service = makeService(fakeApi({ querySearchAnalytics: query }));
    expect(await service.querySearchAnalytics('sc-domain:a.com', body).catch((e) => e)).toMatchObject({ code: 'GOOGLE_QUOTA_EXCEEDED' });
    const second = await service.querySearchAnalytics('sc-domain:a.com', { ...body, endDate: '2026-10-30' }).catch((e) => e);
    expect(second).toMatchObject({ code: 'GOOGLE_QUOTA_EXCEEDED', details: { resetAt: expect.any(String) } });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('stops queued Search Analytics calls once a quota error pauses the site', async () => {
    let calls = 0;
    const query = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      throw googleError(429, 'rateLimitExceeded', 'Quota exceeded');
    });
    const service = makeService(fakeApi({ querySearchAnalytics: query }), { maxConcurrency: 1, maxQueueWaitMs: 5_000 });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => service.querySearchAnalytics('sc-domain:a.com', { ...body, endDate: `2026-10-2${i}` })),
    );
    expect(calls).toBe(1);
    expect(results.every((r) => r.status === 'rejected' && (r.reason as { code: string }).code === 'LOAD_QUOTA_COOLDOWN')).toBe(true);
  });

  it('inspects spelling variants of one URL only once', async () => {
    const inspectUrl = vi.fn(async () => ({}));
    const service = makeService(fakeApi({ inspectUrl }));
    await service.inspectUrl('sc-domain:a.com', 'https://A.COM:443/x');
    await expect(service.inspectUrl('sc-domain:a.com', 'https://a.com/x')).resolves.toMatchObject({ cached: true });
    await expect(service.inspectUrl('sc-domain:a.com', 'https://a.com/x#top')).resolves.toMatchObject({ cached: true });
    expect(inspectUrl).toHaveBeenCalledTimes(1);
    expect((inspectUrl.mock.calls[0] as unknown[])[0]).toMatchObject({ inspectionUrl: 'https://a.com/x' });
  });

  describe('repeated quota errors', () => {
    afterEach(() => vi.useRealTimers());

    it('pauses URL Inspection on a generic quota error, stepping up to PT midnight while errors continue', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
      const inspectUrl = vi.fn().mockRejectedValue(googleError(429, 'rateLimitExceeded', 'Quota exceeded'));
      const service = makeService(fakeApi({ inspectUrl }));
      const first = await service.inspectUrl('sc-domain:a.com', 'https://a.com/1').catch((e) => e);
      expect(first).toMatchObject({ code: 'GOOGLE_QUOTA_EXCEEDED', details: { retryAfterSeconds: 900 } });
      expect(first.details.resetAt).toBeUndefined();
      expect(inspectUrl).toHaveBeenCalledTimes(1); // not retried: each try costs a daily inspection
      await expect(service.inspectUrl('sc-domain:a.com', 'https://a.com/2')).rejects.toMatchObject({ code: 'GOOGLE_QUOTA_EXCEEDED' });
      expect(inspectUrl).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-11-08T12:16:00Z'));
      expect(await service.inspectUrl('sc-domain:a.com', 'https://a.com/3').catch((e) => e)).toMatchObject({ details: { retryAfterSeconds: 3600 } });
      vi.setSystemTime(new Date('2026-11-08T13:17:00Z'));
      const third = await service.inspectUrl('sc-domain:a.com', 'https://a.com/4').catch((e) => e);
      expect(third).toMatchObject({ code: 'GOOGLE_QUOTA_EXCEEDED', details: { resetAt: '2026-11-09T08:00:00.000Z' } });
      expect(service.quotaStatus(['sc-domain:a.com']).sites[0]?.urlInspectionCooldownSeconds).toBe(19 * 3600 - 17 * 60);
    });

    it('starts again at 15 minutes after a successful call or a new PT day', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
      let fail = true;
      const query = vi.fn(async () => {
        if (fail) throw googleError(429, 'rateLimitExceeded', 'Quota exceeded');
        return { rows: [] };
      });
      const service = makeService(fakeApi({ querySearchAnalytics: query }));
      const run = (endDate: string) => service.querySearchAnalytics('sc-domain:a.com', { ...body, endDate }).catch((e) => e);
      expect(await run('2026-10-01')).toMatchObject({ details: { retryAfterSeconds: 900 } });
      // The reviewer's case: queries succeed after the pause, then one heavy query trips the short-term quota again.
      vi.setSystemTime(new Date('2026-11-08T12:16:00Z'));
      fail = false;
      await run('2026-10-02');
      fail = true;
      vi.setSystemTime(new Date('2026-11-08T12:45:00Z'));
      expect(await run('2026-10-03')).toMatchObject({ code: 'LOAD_QUOTA_COOLDOWN', details: { retryAfterSeconds: 900 } });
      // Errors right after the pause step up...
      vi.setSystemTime(new Date('2026-11-08T13:01:00Z'));
      expect(await run('2026-10-04')).toMatchObject({ details: { retryAfterSeconds: 3600 } });
      vi.setSystemTime(new Date('2026-11-09T07:30:00Z')); // 23:30 PT
      expect(await run('2026-10-05')).toMatchObject({ code: 'GOOGLE_QUOTA_EXCEEDED', details: { resetAt: '2026-11-09T08:00:00.000Z' } });
      // ...but a new PT day starts over.
      vi.setSystemTime(new Date('2026-11-09T08:20:00Z'));
      expect(await run('2026-10-06')).toMatchObject({ code: 'LOAD_QUOTA_COOLDOWN', details: { retryAfterSeconds: 900 } });
    });

    it('does not step up for requests already in flight when the pause began', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const query = vi.fn(async () => {
        await gate;
        throw googleError(429, 'rateLimitExceeded', 'Quota exceeded');
      });
      const service = makeService(fakeApi({ querySearchAnalytics: query }), { maxConcurrency: 2 });
      const both = Promise.allSettled([
        service.querySearchAnalytics('sc-domain:a.com', body),
        service.querySearchAnalytics('sc-domain:a.com', { ...body, endDate: '2026-10-30' }),
      ]);
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
      release();
      await both;
      expect(service.quotaStatus(['sc-domain:a.com']).sites[0]?.searchAnalyticsCooldownSeconds).toBe(900);
    });

    it('pauses Search Analytics for every property briefly when three properties hit quota together', async () => {
      const failing = new Set(['sc-domain:a.com', 'sc-domain:b.com', 'sc-domain:c.com']);
      const query = vi.fn(async (site: string) => {
        if (!failing.has(site)) return { rows: [] };
        throw googleError(429, 'rateLimitExceeded', 'Quota exceeded');
      });
      const service = makeService(fakeApi({ querySearchAnalytics: query }));
      await service.querySearchAnalytics('sc-domain:a.com', body).catch(() => {});
      await service.querySearchAnalytics('sc-domain:b.com', body).catch(() => {});
      await expect(service.querySearchAnalytics('sc-domain:d.com', body)).resolves.toBeDefined(); // two aren't enough
      await service.querySearchAnalytics('sc-domain:c.com', body).catch(() => {});
      const blocked = await service.querySearchAnalytics('sc-domain:d.com', { ...body, endDate: '2026-10-30' }).catch((e) => e);
      expect(blocked).toMatchObject({ code: 'LOAD_QUOTA_COOLDOWN', message: expect.stringContaining('every property') });
      expect(blocked.details.retryAfterSeconds).toBeLessThanOrEqual(300);
      expect(query).toHaveBeenCalledTimes(4);
    });
  });

  it('cancels sites, sitemaps and analytics calls when the client disconnects', async () => {
    const controller = new AbortController();
    controller.abort();
    const service = makeService(fakeApi());
    const opts = { signal: controller.signal };
    await expect(service.listSites(false, opts)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(service.getSite('sc-domain:a.com', false, opts)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(service.listSitemaps('sc-domain:a.com', undefined, false, opts)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(service.getSitemap('sc-domain:a.com', 'https://a.com/s.xml', false, opts)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(service.querySearchAnalytics('sc-domain:a.com', body, false, opts)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('still retries short rate limits on other APIs', async () => {
    const getSite = vi.fn().mockRejectedValueOnce(googleError(429, 'rateLimitExceeded')).mockResolvedValue({ siteUrl: 'sc-domain:a.com' });
    const service = makeService(fakeApi({ getSite }));
    await expect(service.getSite('sc-domain:a.com')).resolves.toMatchObject({ value: { siteUrl: 'sc-domain:a.com' } });
    expect(getSite).toHaveBeenCalledTimes(2);
  });

  it("doesn't fail a caller that joined another client's cancelled call", async () => {
    // The first caller's request hangs until it is aborted; the joiner's own request succeeds.
    const inspectUrl = vi.fn((_body: unknown, opts?: { signal?: AbortSignal }) => {
      const signal = opts?.signal;
      if (!signal) return Promise.resolve({ indexStatusResult: { verdict: 'PASS' } });
      return new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const service = makeService(fakeApi({ inspectUrl }));
    const controller = new AbortController();
    const first = service.inspectUrl('sc-domain:a.com', 'https://a.com/', undefined, false, { signal: controller.signal });
    const joiner = service.inspectUrl('sc-domain:a.com', 'https://a.com/');
    await vi.waitFor(() => expect(inspectUrl).toHaveBeenCalled());
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(joiner).resolves.toMatchObject({ value: { indexStatusResult: { verdict: 'PASS' } } });
  });

  it('counts every retry against the limits', async () => {
    const inspectUrl = vi.fn().mockRejectedValueOnce(googleError(503)).mockRejectedValueOnce(googleError(503)).mockResolvedValue({});
    const service = makeService(fakeApi({ inspectUrl }));
    await service.inspectUrl('sc-domain:a.com', 'https://a.com/');
    expect(service.limiter.daily.used(DAILY_ID, Date.now())).toBe(3);
  });

  it('stops URL inspection at the local daily limit; cached results are free', async () => {
    const inspectUrl = vi.fn(async () => ({}));
    const service = makeService(fakeApi({ inspectUrl }));
    for (let i = 0; i < 1998; i++) service.limiter.daily.increment(DAILY_ID, Date.now());
    await service.inspectUrl('sc-domain:a.com', 'https://a.com/1');
    await service.inspectUrl('sc-domain:a.com', 'https://a.com/2');
    await expect(service.inspectUrl('sc-domain:a.com', 'https://a.com/3')).rejects.toMatchObject({ code: 'DAILY_QUOTA_EXHAUSTED' });
    await expect(service.inspectUrl('sc-domain:a.com', 'https://a.com/1')).resolves.toMatchObject({ cached: true });
    expect(inspectUrl).toHaveBeenCalledTimes(2);
    expect(service.quotaStatus(['sc-domain:a.com']).sites[0]?.urlInspectionToday).toEqual({ used: 2000, limit: 2000, remaining: 0 });
  });

  it("marks the day as used up when Google says so, so later calls don't reach Google", async () => {
    const inspectUrl = vi.fn().mockRejectedValue(googleError(429, 'RESOURCE_EXHAUSTED', "Quota exceeded for 'Inspections' per day per site"));
    const service = makeService(fakeApi({ inspectUrl }));
    const first = await service.inspectUrl('sc-domain:a.com', 'https://a.com/1').catch((e) => e);
    expect(first.code).toBe('GOOGLE_QUOTA_EXCEEDED');
    expect(first.details.resetAt).toBeDefined();
    expect(inspectUrl).toHaveBeenCalledTimes(1); // daily errors are not retried
    await expect(service.inspectUrl('sc-domain:a.com', 'https://a.com/2')).rejects.toMatchObject({ code: 'DAILY_QUOTA_EXHAUSTED' });
    expect(inspectUrl).toHaveBeenCalledTimes(1);
  });

  it('rejects URLs outside the property without spending quota', async () => {
    const inspectUrl = vi.fn(async () => ({}));
    const service = makeService(fakeApi({ inspectUrl }));
    await expect(service.inspectUrl('sc-domain:a.com', 'https://b.com/x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(inspectUrl).not.toHaveBeenCalled();
    expect(service.limiter.daily.used(DAILY_ID, Date.now())).toBe(0);
  });

  it('turns a 403 into an actionable permission error', async () => {
    const service = makeService(fakeApi({ getSite: async () => Promise.reject(googleError(403, 'forbidden', 'no access')) }));
    await expect(service.getSite('sc-domain:a.com')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: expect.stringContaining('bot@project.iam.gserviceaccount.com'),
    });
  });
});
