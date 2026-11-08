import { describe, expect, it, vi } from 'vitest';
import { normalizeSiteUrl } from '../src/google/service.js';
import { fakeApi, googleError, makeService } from './helpers.js';

describe('normalizeSiteUrl', () => {
  it('adds the trailing slash and lowercases domain properties', () => {
    expect(normalizeSiteUrl('https://www.example.com')).toBe('https://www.example.com/');
    expect(normalizeSiteUrl('https://www.example.com/blog/')).toBe('https://www.example.com/blog/');
    expect(normalizeSiteUrl('SC-DOMAIN:Example.COM')).toBe('sc-domain:example.com');
    expect(() => normalizeSiteUrl('example')).toThrow(/not a valid property/);
  });
});

describe('GscService', () => {
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

  it('enforces the site allowlist, including in list_sites', async () => {
    const service = makeService(fakeApi(), { allowedSites: ['sc-domain:example.org'] });
    expect((await service.listSites()).value.map((s) => s.siteUrl)).toEqual(['sc-domain:example.org']);
    await expect(service.getSite('https://www.example.com/')).rejects.toMatchObject({ code: 'SITE_NOT_ALLOWED' });
  });

  it('opens the circuit for a site after a load-quota error', async () => {
    const query = vi.fn().mockRejectedValue(googleError(429, 'rateLimitExceeded', 'Search Analytics load quota exceeded'));
    const service = makeService(fakeApi({ querySearchAnalytics: query }));
    const body = { startDate: '2026-10-01', endDate: '2026-10-31' };
    await expect(service.querySearchAnalytics('sc-domain:a.com', body)).rejects.toMatchObject({ code: 'LOAD_QUOTA_COOLDOWN' });
    await expect(service.querySearchAnalytics('sc-domain:a.com', { ...body, endDate: '2026-10-30' })).rejects.toMatchObject({
      code: 'LOAD_QUOTA_COOLDOWN',
      details: { retryAfterSeconds: 900 },
    });
    expect(query).toHaveBeenCalledTimes(1);
    // Other sites are unaffected.
    query.mockResolvedValue({ rows: [] });
    await expect(service.querySearchAnalytics('sc-domain:b.com', body)).resolves.toBeDefined();
  });

  it('stops URL inspection at the daily limit', async () => {
    const inspectUrl = vi.fn(async () => ({}));
    const service = makeService(fakeApi({ inspectUrl }));
    for (let i = 0; i < 1998; i++) service.limiter.daily.increment('urlInspection:site:sc-domain:a.com:day', Date.now());
    await service.inspectUrl('sc-domain:a.com', 'https://a.com/1');
    await service.inspectUrl('sc-domain:a.com', 'https://a.com/2');
    await expect(service.inspectUrl('sc-domain:a.com', 'https://a.com/3')).rejects.toMatchObject({ code: 'DAILY_QUOTA_EXHAUSTED' });
    // Cached results don't use quota.
    await expect(service.inspectUrl('sc-domain:a.com', 'https://a.com/1')).resolves.toMatchObject({ cached: true });
    expect(inspectUrl).toHaveBeenCalledTimes(2);
    expect(service.quotaStatus(['sc-domain:a.com']).sites[0]?.urlInspectionToday).toEqual({ used: 2000, limit: 2000, remaining: 0 });
  });

  it('turns a 403 into an actionable permission error', async () => {
    const service = makeService(fakeApi({ getSite: async () => Promise.reject(googleError(403, 'forbidden', 'no access')) }));
    await expect(service.getSite('sc-domain:a.com')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: expect.stringContaining('bot@project.iam.gserviceaccount.com'),
    });
  });
});
