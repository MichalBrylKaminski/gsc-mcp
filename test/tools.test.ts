import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchAnalyticsQueryRequest } from '../src/google/client.js';
import { comparePeriods, LAG_PADDING_DAYS, runSiteOverview } from '../src/tools/overview.js';
import { MAX_PAGE_SIZE, runSearchAnalytics, validateQuery, type SearchAnalyticsInput } from '../src/tools/searchAnalytics.js';
import { runBatchInspection } from '../src/tools/urlInspection.js';
import { fakeApi, googleError, makeService } from './helpers.js';

const base: SearchAnalyticsInput = { siteUrl: 'sc-domain:a.com', startDate: '2026-10-01', endDate: '2026-10-31' };

describe('validateQuery', () => {
  it('accepts a plain query', () => {
    expect(validateQuery({ ...base, dimensions: ['query', 'page'] })).toEqual([]);
  });

  it('rejects combinations Google would refuse', () => {
    expect(validateQuery({ ...base, startDate: '2026-11-01' })).toHaveLength(1);
    expect(validateQuery({ ...base, dimensions: ['query', 'query'] })).toHaveLength(1);
    expect(validateQuery({ ...base, dimensions: ['hour'] })[0]).toMatch(/hourly_all/);
    expect(validateQuery({ ...base, dimensions: ['hour'], dataState: 'hourly_all' })).toEqual([]);
    expect(validateQuery({ ...base, aggregationType: 'byProperty', dimensions: ['page'] })).toHaveLength(1);
    expect(validateQuery({ ...base, aggregationType: 'byProperty', type: 'discover' })).toHaveLength(1);
    expect(validateQuery({ ...base, aggregationType: 'byNewsShowcasePanel', type: 'web' })).toHaveLength(2);
  });
});

/** Fake Search Analytics API holding `total` rows. */
function pagedApi(total: number) {
  return vi.fn(async (_site: string, body: SearchAnalyticsQueryRequest) => {
    const start = body.startRow ?? 0;
    const n = Math.max(0, Math.min(body.rowLimit ?? 1000, total - start));
    return { responseAggregationType: 'byProperty', rows: Array.from({ length: n }, (_, i) => ({ keys: [`q${start + i}`], clicks: 1, impressions: 3, ctr: 1 / 3, position: 2.345 })) };
  });
}

describe('runSearchAnalytics', () => {
  it('returns columnar rows and flags possible truncation', async () => {
    const query = pagedApi(5000);
    const service = makeService(fakeApi({ querySearchAnalytics: query }));
    const res = await runSearchAnalytics(service, { ...base, dimensions: ['query'], rowLimit: 10 }, 25_000);
    expect(res.columns).toEqual(['query', 'clicks', 'impressions', 'ctr', 'position']);
    expect(res.rows[0]).toEqual(['q0', 1, 3, 0.3333, 2.35]);
    expect(res).toMatchObject({ rowCount: 10, truncated: true, nextStartRow: 10, requests: 1 });
    expect(query.mock.calls[0]![1]).toMatchObject({ rowLimit: 10, startRow: 0, dimensions: ['query'] });
  });

  it('fetchAll pages until a short page', async () => {
    const query = pagedApi(60_000);
    const service = makeService(fakeApi({ querySearchAnalytics: query }));
    const res = await runSearchAnalytics(service, { ...base, dimensions: ['query'], fetchAll: true, maxRows: 100_000 }, 100_000);
    expect(query.mock.calls.map((c) => [c[1].startRow, c[1].rowLimit])).toEqual([
      [0, MAX_PAGE_SIZE],
      [25_000, MAX_PAGE_SIZE],
      [50_000, MAX_PAGE_SIZE],
    ]);
    expect(res).toMatchObject({ rowCount: 60_000, truncated: false, requests: 3 });
  });

  it('fetchAll stops at the row cap', async () => {
    const query = pagedApi(60_000);
    const service = makeService(fakeApi({ querySearchAnalytics: query }));
    const res = await runSearchAnalytics(service, { ...base, fetchAll: true, dimensions: ['query'] }, 30_000);
    expect(query.mock.calls.map((c) => c[1].rowLimit)).toEqual([25_000, 5_000]);
    expect(res).toMatchObject({ rowCount: 30_000, truncated: true, nextStartRow: 30_000 });
  });

  it('rejects invalid queries without calling Google', async () => {
    const query = pagedApi(1);
    const service = makeService(fakeApi({ querySearchAnalytics: query }));
    await expect(runSearchAnalytics(service, { ...base, dimensions: ['hour'] }, 1000)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('comparePeriods', () => {
  it('compares the last N days of data with the N days before', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      keys: [`2026-10-${String(i + 1).padStart(2, '0')}`],
      clicks: i < 5 ? 1 : 2,
      impressions: 10,
      position: i < 5 ? 4 : 2,
    }));
    const r = comparePeriods(rows, 5, { today: '2026-10-13' });
    expect(r).toMatchObject({ latestDataDate: '2026-10-10', noRecentData: false });
    expect(r.current).toMatchObject({ startDate: '2026-10-06', clicks: 10, impressions: 50, ctr: 0.2, position: 2, daysWithData: 5 });
    expect(r.previous).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-05', clicks: 5, position: 4 });
    expect(r.change).toEqual({ clicksPct: 100, impressionsPct: 0, ctrPoints: 10, position: -2 });
    expect(r.current?.daysWithData).toBe(5);
  });

  it('uses calendar days, so gaps on sparse sites do not shift the periods', () => {
    const rows = ['2026-10-01', '2026-10-04', '2026-10-10'].map((d) => ({ keys: [d], clicks: 1, impressions: 1, position: 1 }));
    const r = comparePeriods(rows, 5, { today: '2026-10-14' });
    expect(r.current).toMatchObject({ startDate: '2026-10-06', clicks: 1, daysWithData: 1 });
    expect(r.previous).toMatchObject({ startDate: '2026-10-01', clicks: 2, daysWithData: 2 });
  });

  it('flags a previous period that starts before the fetched window', () => {
    const rows = [{ keys: ['2026-10-10'], clicks: 1, impressions: 1, position: 1 }];
    expect(comparePeriods(rows, 5, { today: '2026-10-13', fetchedFrom: '2026-10-01' }).previousPeriodComplete).toBe(true);
    expect(comparePeriods(rows, 5, { today: '2026-10-13', fetchedFrom: '2026-10-02' }).previousPeriodComplete).toBe(false);
  });

  it('does not hide a site that stopped getting impressions', () => {
    // Steady traffic until 2026-10-10, nothing since; today is 2026-10-24.
    const rows = Array.from({ length: 10 }, (_, i) => ({ keys: [`2026-10-${String(i + 1).padStart(2, '0')}`], clicks: 1, impressions: 1, position: 1 }));
    const r = comparePeriods(rows, 5, { today: '2026-10-24' });
    expect(r).toMatchObject({ latestDataDate: '2026-10-10', noRecentData: true, note: expect.stringContaining('2026-10-10') });
    expect(r.current).toMatchObject({ startDate: '2026-10-16', endDate: '2026-10-20', clicks: 0, daysWithData: 0 });
    expect(comparePeriods([], 5, { today: '2026-10-24' })).toMatchObject({ latestDataDate: null, noRecentData: true, current: { clicks: 0 } });
  });
});

describe('runSiteOverview', () => {
  afterEach(() => vi.useRealTimers());

  it('fetches both periods plus lag padding in one date-grouped query', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T20:00:00Z'));
    const query = vi.fn(async (_site: string, _body: SearchAnalyticsQueryRequest) => ({ rows: [] }));
    const service = makeService(fakeApi({ querySearchAnalytics: query }));
    const res = await runSiteOverview(service, { siteUrl: 'sc-domain:a.com', days: 28 });
    expect(query).toHaveBeenCalledTimes(1);
    // 2 x 28 days + 14 days of lag padding before 2026-11-08 (PT).
    expect(LAG_PADDING_DAYS).toBe(14);
    expect(query.mock.calls[0]![1]).toMatchObject({ startDate: '2026-08-30', endDate: '2026-11-08', dimensions: ['date'], dataState: 'final' });
    expect(res.performance).toMatchObject({ days: 28, latestDataDate: null, noRecentData: true, current: { endDate: '2026-11-04' } });
  });
});

describe('runBatchInspection', () => {
  it('records per-URL errors and stops on quota errors', async () => {
    const inspectUrl = vi
      .fn()
      .mockResolvedValueOnce({ indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } })
      .mockRejectedValueOnce(googleError(403, 'dailyLimitExceeded', 'Quota exceeded'));
    const service = makeService(fakeApi({ inspectUrl }));
    const res = await runBatchInspection(service, {
      siteUrl: 'sc-domain:a.com',
      inspectionUrls: ['https://a.com/1', 'https://b.com/2', 'https://a.com/3', 'https://a.com/4'],
    });
    expect(res.results.map((r) => r.error ? (r.error as { code: string }).code : r.skipped ? 'skipped' : r.verdict)).toEqual([
      'PASS',
      'INVALID_ARGUMENT',
      'GOOGLE_QUOTA_EXCEEDED',
      'skipped',
    ]);
    expect(res).toMatchObject({ inspected: 1, failed: 2, skipped: 1, stoppedReason: { code: 'GOOGLE_QUOTA_EXCEEDED' } });
    expect(inspectUrl).toHaveBeenCalledTimes(2); // b.com was rejected locally
  });

  it('stops after repeated Google outages', async () => {
    const inspectUrl = vi.fn().mockRejectedValue(googleError(503));
    const service = makeService(fakeApi({ inspectUrl }), { retry: { maxRetries: 0 } });
    const urls = Array.from({ length: 6 }, (_, i) => `https://a.com/${i}`);
    const res = await runBatchInspection(service, { siteUrl: 'sc-domain:a.com', inspectionUrls: urls });
    expect(res).toMatchObject({ failed: 3, skipped: 3, stoppedReason: { code: 'UPSTREAM_ERROR' } });
  });

  it('stops when the client disconnects or the deadline passes', async () => {
    const controller = new AbortController();
    const inspectUrl = vi.fn(async () => {
      controller.abort();
      return {};
    });
    const service = makeService(fakeApi({ inspectUrl }));
    const urls = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3'];
    const res = await runBatchInspection(service, { siteUrl: 'sc-domain:a.com', inspectionUrls: urls }, { signal: controller.signal });
    expect(res).toMatchObject({ inspected: 1, skipped: 2, stoppedReason: { code: 'CANCELLED' } });

    const late = await runBatchInspection(makeService(fakeApi()), { siteUrl: 'sc-domain:a.com', inspectionUrls: urls }, { deadlineMs: 0 });
    expect(late).toMatchObject({ inspected: 0, skipped: 3, stoppedReason: { code: 'LOCAL_RATE_LIMIT' } });
  });

  /** A Google call that only ends when its request signal aborts, like a hung connection. */
  const hangingInspect = () =>
    vi.fn(
      (_body: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    );

  it('enforces the deadline during a slow Google call, not only between URLs', async () => {
    const inspectUrl = hangingInspect();
    const service = makeService(fakeApi({ inspectUrl }));
    const started = Date.now();
    const res = await runBatchInspection(service, { siteUrl: 'sc-domain:a.com', inspectionUrls: ['https://a.com/1', 'https://a.com/2'] }, { deadlineMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res).toMatchObject({ failed: 1, skipped: 1, stoppedReason: { code: 'LOCAL_RATE_LIMIT' } });
  });

  it('aborts an in-flight Google call when the client disconnects', async () => {
    const inspectUrl = hangingInspect();
    const service = makeService(fakeApi({ inspectUrl }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const res = await runBatchInspection(service, { siteUrl: 'sc-domain:a.com', inspectionUrls: ['https://a.com/1', 'https://a.com/2'] }, { signal: controller.signal });
    expect(res).toMatchObject({ failed: 1, skipped: 1, stoppedReason: { code: 'CANCELLED' } });
  });
});
