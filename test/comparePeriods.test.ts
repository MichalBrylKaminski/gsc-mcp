import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiDataRow, SearchAnalyticsQueryRequest } from '../src/google/client.js';
import { mergePeriods, periodWarnings, resolvePeriods, runComparePeriods, sortMerged } from '../src/tools/comparePeriods.js';
import { fakeApi, googleError, makeService } from './helpers.js';

const site = 'sc-domain:a.com';

describe('resolvePeriods', () => {
  it('defaults the baseline to the same number of days just before the current period', () => {
    expect(resolvePeriods({ currentStart: '2026-10-01', currentEnd: '2026-10-28' })).toEqual({
      current: { startDate: '2026-10-01', endDate: '2026-10-28' },
      previous: { startDate: '2026-09-03', endDate: '2026-09-30' },
    });
  });

  it('uses an explicit baseline', () => {
    const r = resolvePeriods({ currentStart: '2026-10-01', currentEnd: '2026-10-31', previousStart: '2025-10-01', previousEnd: '2025-10-31' });
    expect(r.previous).toEqual({ startDate: '2025-10-01', endDate: '2025-10-31' });
  });

  it('rejects reversed periods and a half-given baseline', () => {
    expect(() => resolvePeriods({ currentStart: '2026-10-02', currentEnd: '2026-10-01' })).toThrow(/currentStart/);
    expect(() => resolvePeriods({ currentStart: '2026-10-01', currentEnd: '2026-10-02', previousStart: '2026-09-01' })).toThrow(/both/);
    expect(() =>
      resolvePeriods({ currentStart: '2026-10-01', currentEnd: '2026-10-02', previousStart: '2026-09-05', previousEnd: '2026-09-01' }),
    ).toThrow(/previousStart/);
  });
});

describe('periodWarnings', () => {
  const cur = { startDate: '2026-10-01', endDate: '2026-10-28' };
  const prev = { startDate: '2026-09-03', endDate: '2026-09-30' };

  it('says nothing about a clean comparison', () => {
    expect(periodWarnings(cur, prev, 'final', '2026-11-13')).toEqual([]);
  });

  it('flags unequal lengths, overlap and days without final data yet', () => {
    expect(periodWarnings(cur, { startDate: '2026-09-01', endDate: '2026-09-30' }, 'final', '2026-11-13')[0]).toMatch(/28 vs 30 days/);
    expect(periodWarnings(cur, { startDate: '2026-09-29', endDate: '2026-10-26' }, 'final', '2026-11-13')).toEqual([expect.stringMatching(/overlap/)]);
    expect(periodWarnings(cur, prev, 'final', '2026-10-30')).toEqual([expect.stringMatching(/2026-10-26/)]);
    expect(periodWarnings(cur, prev, 'all', '2026-10-30')).toEqual([]);
  });
});

describe('mergePeriods', () => {
  // [query, clicks, impressions, ctr, position]
  const cur = [
    ['a', 10, 100, 0.1, 3],
    ['b', 5, 50, 0.1, 5],
  ];
  const prev = [
    ['a', 4, 80, 0.05, 4],
    ['c', 7, 70, 0.1, 6],
  ];

  it('matches rows and treats a row missing from a fully fetched period as zero', () => {
    const merged = mergePeriods(1, { rows: cur, complete: true }, { rows: prev, complete: true });
    expect(merged.map((r) => [r.keys[0], r.status, r.clicksChange, r.impressionsChange])).toEqual([
      ['a', 'both', 6, 20],
      ['b', 'new', 5, 50],
      ['c', 'gone', -7, -70],
    ]);
    expect(merged[1]!.prev).toEqual({ clicks: 0, impressions: 0, ctr: null, position: null });
  });

  it('reports unknown values when the other period was cut off', () => {
    const merged = mergePeriods(1, { rows: cur, complete: false }, { rows: prev, complete: false });
    expect(merged.map((r) => [r.keys[0], r.status, r.clicksChange])).toEqual([
      ['a', 'both', 6],
      ['b', 'notInPreviousRows', null],
      ['c', 'notInCurrentRows', null],
    ]);
    expect(merged[2]!.cur.clicks).toBeNull();
  });

  it('matches on every dimension', () => {
    const merged = mergePeriods(2, { rows: [['a', 'MOBILE', 1, 1, 1, 1]], complete: true }, { rows: [['a', 'DESKTOP', 1, 1, 1, 1]], complete: true });
    expect(merged.map((r) => r.status)).toEqual(['new', 'gone']);
  });
});

describe('sortMerged', () => {
  const merged = mergePeriods(
    1,
    {
      rows: [
        ['up', 20, 200, 0.1, 2],
        ['down', 1, 300, 0.01, 9],
        ['flat', 50, 500, 0.1, 1],
        ['unknown', 99, 990, 0.1, 1],
      ],
      complete: true,
    },
    {
      rows: [
        ['up', 5, 100, 0.05, 3],
        ['down', 9, 100, 0.09, 4],
        ['flat', 50, 600, 0.08, 1],
      ],
      complete: false,
    },
  );
  const order = (s: Parameters<typeof sortMerged>[1]) => sortMerged(merged, s).map((r) => r.keys[0]);

  it('puts the biggest movers first, either way, and unknown changes last', () => {
    expect(order('clicksChange')).toEqual(['up', 'down', 'flat', 'unknown']);
  });

  it('keeps only gains or losses for the gained/lost orders', () => {
    expect(order('clicksGained')).toEqual(['up']);
    expect(order('clicksLost')).toEqual(['down']);
    expect(order('impressionsGained')).toEqual(['down', 'up']);
    expect(order('impressionsLost')).toEqual(['flat']);
  });

  it('sorts by current clicks', () => {
    expect(order('clicks')).toEqual(['unknown', 'flat', 'up', 'down']);
  });
});

/** Fake API: totals per period, plus query rows per period. */
function periodApi(data: Record<string, { totals: ApiDataRow; rows: ApiDataRow[] }>) {
  return vi.fn(async (_site: string, body: SearchAnalyticsQueryRequest) => {
    const d = data[body.startDate ?? ""];
    if (!d) return { rows: [] };
    return { rows: body.dimensions?.length ? d.rows.slice(body.startRow ?? 0, (body.startRow ?? 0) + (body.rowLimit ?? 1000)) : [d.totals] };
  });
}

describe('runComparePeriods', () => {
  afterEach(() => vi.useRealTimers());

  const data = {
    '2026-10-01': {
      totals: { clicks: 120, impressions: 2000, ctr: 0.06, position: 7.5 },
      rows: [
        { keys: ['a'], clicks: 60, impressions: 600, ctr: 0.1, position: 2 },
        { keys: ['b'], clicks: 10, impressions: 400, ctr: 0.025, position: 9 },
      ],
    },
    '2026-09-03': {
      totals: { clicks: 100, impressions: 2500, ctr: 0.04, position: 8 },
      rows: [
        { keys: ['a'], clicks: 30, impressions: 500, ctr: 0.06, position: 3 },
        { keys: ['c'], clicks: 40, impressions: 900, ctr: 0.0444, position: 4 },
      ],
    },
  };

  it('compares totals only with two cheap queries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T20:00:00Z'));
    const query = periodApi(data);
    const res = await runComparePeriods(makeService(fakeApi({ querySearchAnalytics: query })), { siteUrl: site, currentStart: '2026-10-01', currentEnd: '2026-10-28' }, 25_000);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map((c) => [c[1].startDate, c[1].endDate, c[1].dimensions, c[1].dataState])).toEqual([
      ['2026-10-01', '2026-10-28', undefined, 'final'],
      ['2026-09-03', '2026-09-30', undefined, 'final'],
    ]);
    expect(res.current).toMatchObject({ startDate: '2026-10-01', clicks: 120, impressions: 2000 });
    expect(res.previous).toMatchObject({ startDate: '2026-09-03', clicks: 100 });
    expect(res.change).toEqual({ clicks: 20, impressions: -500, clicksPct: 20, impressionsPct: -20, ctrPoints: 2, position: -0.5 });
    expect(res.warnings).toEqual([]);
    expect(res).not.toHaveProperty('rows');
  });

  it('matches rows across periods when dimensions are given', async () => {
    const query = periodApi(data);
    const res = await runComparePeriods(
      makeService(fakeApi({ querySearchAnalytics: query })),
      { siteUrl: site, currentStart: '2026-10-01', currentEnd: '2026-10-28', dimensions: ['query'], sortBy: 'clicksLost' },
      25_000,
    );
    expect(query).toHaveBeenCalledTimes(4);
    expect(res).toMatchObject({ sortBy: 'clicksLost', rowCount: 1, matchingRows: 1, requests: 4 });
    expect(res.columns?.slice(0, 5)).toEqual(['query', 'status', 'clicks', 'previousClicks', 'clicksChange']);
    expect(res.rows).toEqual([['c', 'gone', 0, 40, -40, 0, 900, -900, null, 0.0444, null, 4, null]]);
    expect(res.current).toMatchObject({ rowsFetched: 2, allRowsFetched: true });
  });

  it('marks rows outside the fetched rows as unknown', async () => {
    const query = periodApi(data);
    const res = await runComparePeriods(
      makeService(fakeApi({ querySearchAnalytics: query })),
      { siteUrl: site, currentStart: '2026-10-01', currentEnd: '2026-10-28', dimensions: ['query'], rowsPerPeriod: 2 },
      25_000,
    );
    expect(res.current).toMatchObject({ rowsFetched: 2, allRowsFetched: false });
    expect(res.rows?.map((r) => [r[0], r[1]])).toEqual([
      ['a', 'both'],
      ['b', 'notInPreviousRows'],
      ['c', 'notInCurrentRows'],
    ]);
  });

  it('rejects bad input before calling Google', async () => {
    const query = periodApi(data);
    const service = makeService(fakeApi({ querySearchAnalytics: query }));
    await expect(runComparePeriods(service, { siteUrl: site, currentStart: '2026-10-02', currentEnd: '2026-10-01' }, 25_000)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      runComparePeriods(service, { siteUrl: site, currentStart: '2026-10-01', currentEnd: '2026-10-28', dimensions: ['page'], aggregationType: 'byProperty' }, 25_000),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/byProperty/) });
    expect(query).not.toHaveBeenCalled();
  });

  it('passes quota errors through', async () => {
    const query = vi.fn().mockRejectedValue(googleError(429, 'rateLimitExceeded', 'Quota exceeded'));
    const service = makeService(fakeApi({ querySearchAnalytics: query }));
    await expect(runComparePeriods(service, { siteUrl: site, currentStart: '2026-10-01', currentEnd: '2026-10-28' }, 25_000)).rejects.toMatchObject({
      code: 'LOAD_QUOTA_COOLDOWN',
    });
  });
});
