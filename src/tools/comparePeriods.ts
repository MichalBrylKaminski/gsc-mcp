import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GscToolError } from '../errors.js';
import type { GscService } from '../google/service.js';
import { addDays, daysBetween, ptDay } from '../time.js';
import { bypassCacheSchema, handle, READ_ONLY, siteUrlSchema, type ToolDeps } from './common.js';
import { FINAL_DATA_LAG_DAYS, periodChange } from './overview.js';
import { DEFAULT_FETCH_ALL_ROWS, dateSchema, runSearchAnalytics, searchAnalyticsInput, validateQuery, type SearchAnalyticsInput } from './searchAnalytics.js';

/** Dimensions whose values mean the same thing in both periods, so rows can be matched. */
const COMPARE_DIMENSIONS = ['query', 'page', 'country', 'device', 'searchAppearance'] as const;
export const SORT_ORDERS = ['clicksChange', 'clicksGained', 'clicksLost', 'impressionsChange', 'impressionsGained', 'impressionsLost', 'clicks'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];
export const DEFAULT_COMPARE_LIMIT = 50;
export const MAX_COMPARE_LIMIT = 1_000;

export const comparePeriodsInput = {
  siteUrl: siteUrlSchema,
  currentStart: dateSchema.describe('First day of the period you are analyzing, inclusive, YYYY-MM-DD in Pacific Time.'),
  currentEnd: dateSchema.describe('Last day of the period you are analyzing, inclusive.'),
  previousStart: dateSchema
    .optional()
    .describe('First day of the baseline period. Omit previousStart and previousEnd to use the same number of days just before currentStart.'),
  previousEnd: dateSchema.optional().describe('Last day of the baseline period, inclusive.'),
  dimensions: z
    .array(z.enum(COMPARE_DIMENSIONS))
    .optional()
    .describe(
      'Match rows across the two periods by these dimensions, e.g. ["query"] or ["page"]. Omit to compare totals only (cheapest). ' +
        'Cost note: each period is a separate query, so query+page grouping over long ranges costs twice the load quota.',
    ),
  type: searchAnalyticsInput.type,
  dimensionFilterGroups: searchAnalyticsInput.dimensionFilterGroups,
  aggregationType: searchAnalyticsInput.aggregationType,
  dataState: z
    .enum(['final', 'all'])
    .optional()
    .describe('"final" (default): finished data only. "all": includes fresh, incomplete data for the last few days.'),
  rowsPerPeriod: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Rows fetched for each period, by clicks, before matching (default ${DEFAULT_FETCH_ALL_ROWS.toLocaleString('en-US')}, capped by the server limit). ` +
        'If a period has more rows than this, a row missing from it is reported as unknown rather than as new or gone.',
    ),
  sortBy: z
    .enum(SORT_ORDERS)
    .optional()
    .describe(
      '"clicksChange" (default): biggest movers either way. "clicksGained"/"clicksLost": only rows that gained/lost clicks, largest first. ' +
        'The impressions variants work the same way. "clicks": current-period clicks.',
    ),
  limit: z.number().int().min(1).max(MAX_COMPARE_LIMIT).optional().describe(`Rows to return after sorting (default ${DEFAULT_COMPARE_LIMIT}).`),
  bypassCache: bypassCacheSchema,
};

const inputObject = z.object(comparePeriodsInput);
export type ComparePeriodsInput = z.infer<typeof inputObject>;

interface Period {
  startDate: string;
  endDate: string;
}

/** Fills in the default baseline: the same number of days just before the current period. */
export function resolvePeriods(a: Pick<ComparePeriodsInput, 'currentStart' | 'currentEnd' | 'previousStart' | 'previousEnd'>) {
  const errors: string[] = [];
  if (a.currentStart > a.currentEnd) errors.push('currentStart must be on or before currentEnd.');
  if ((a.previousStart === undefined) !== (a.previousEnd === undefined)) errors.push('Give both previousStart and previousEnd, or neither.');
  else if (a.previousStart && a.previousEnd && a.previousStart > a.previousEnd) errors.push('previousStart must be on or before previousEnd.');
  if (errors.length) throw new GscToolError('INVALID_ARGUMENT', errors.join(' '));

  const days = daysBetween(a.currentStart, a.currentEnd) + 1;
  const current: Period = { startDate: a.currentStart, endDate: a.currentEnd };
  const previous: Period =
    a.previousStart && a.previousEnd
      ? { startDate: a.previousStart, endDate: a.previousEnd }
      : { startDate: addDays(a.currentStart, -days), endDate: addDays(a.currentStart, -1) };
  return { current, previous };
}

/** Things that make the comparison misleading without making it wrong. */
export function periodWarnings(current: Period, previous: Period, dataState: string, today: string): string[] {
  const warnings: string[] = [];
  const currentDays = daysBetween(current.startDate, current.endDate) + 1;
  const previousDays = daysBetween(previous.startDate, previous.endDate) + 1;
  if (currentDays !== previousDays) {
    warnings.push(`The periods have different lengths (${currentDays} vs ${previousDays} days), so totals are not directly comparable.`);
  }
  if (previous.startDate <= current.endDate && current.startDate <= previous.endDate) {
    warnings.push('The periods overlap, so the shared days count in both.');
  }
  const lastFinalDay = addDays(today, -FINAL_DATA_LAG_DAYS);
  if (dataState === 'final' && (current.endDate > lastFinalDay || previous.endDate > lastFinalDay)) {
    warnings.push(
      `Final data is usually published only through about ${lastFinalDay}. Days after that may be missing, which makes the period look worse. ` +
        'End the period earlier, or use dataState "all".',
    );
  }
  return warnings;
}

/** [...keys, clicks, impressions, ctr, position], as runSearchAnalytics returns them. */
type FetchedRow = unknown[];

interface FetchedPeriod {
  rows: FetchedRow[];
  /** False when the period may have more rows than were fetched. */
  complete: boolean;
}

type Side = { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null };

const ZERO: Side = { clicks: 0, impressions: 0, ctr: null, position: null };
const UNKNOWN: Side = { clicks: null, impressions: null, ctr: null, position: null };

function side(row: FetchedRow, dimCount: number): Side {
  const [clicks, impressions, ctr, position] = row.slice(dimCount) as [number, number, number | null, number | null];
  return { clicks, impressions, ctr, position };
}

const diff = (a: number | null, b: number | null, digits = 0) => (a == null || b == null ? null : Number((a - b).toFixed(digits)));

export const COMPARE_COLUMNS = [
  'status',
  'clicks',
  'previousClicks',
  'clicksChange',
  'impressions',
  'previousImpressions',
  'impressionsChange',
  'ctr',
  'previousCtr',
  'position',
  'previousPosition',
  'positionChange',
] as const;

interface MergedRow {
  keys: unknown[];
  status: 'both' | 'new' | 'gone' | 'notInPreviousRows' | 'notInCurrentRows';
  cur: Side;
  prev: Side;
  clicksChange: number | null;
  impressionsChange: number | null;
}

/**
 * Matches rows of the two periods by their dimension values. A row missing
 * from a period counts as zero only when that period was fetched in full;
 * otherwise it may just rank below the rows that were fetched, so its values
 * are unknown (null).
 */
export function mergePeriods(dimCount: number, current: FetchedPeriod, previous: FetchedPeriod): MergedRow[] {
  const key = (r: FetchedRow) => JSON.stringify(r.slice(0, dimCount));
  const prevByKey = new Map(previous.rows.map((r) => [key(r), r]));
  const merged: MergedRow[] = [];
  const build = (keys: unknown[], status: MergedRow['status'], cur: Side, prev: Side): MergedRow => ({
    keys,
    status,
    cur,
    prev,
    clicksChange: diff(cur.clicks, prev.clicks),
    impressionsChange: diff(cur.impressions, prev.impressions),
  });

  for (const r of current.rows) {
    const k = key(r);
    const p = prevByKey.get(k);
    prevByKey.delete(k);
    const keys = r.slice(0, dimCount);
    if (p) merged.push(build(keys, 'both', side(r, dimCount), side(p, dimCount)));
    else merged.push(build(keys, previous.complete ? 'new' : 'notInPreviousRows', side(r, dimCount), previous.complete ? ZERO : UNKNOWN));
  }
  for (const p of prevByKey.values()) {
    merged.push(build(p.slice(0, dimCount), current.complete ? 'gone' : 'notInCurrentRows', current.complete ? ZERO : UNKNOWN, side(p, dimCount)));
  }
  return merged;
}

/** Sorts (and for the gained/lost orders, filters) merged rows. Unknown changes sort last. */
export function sortMerged(rows: MergedRow[], sortBy: SortOrder): MergedRow[] {
  const metric = sortBy.startsWith('impressions') ? 'impressionsChange' : 'clicksChange';
  let kept = rows;
  let score: (r: MergedRow) => number | null;
  if (sortBy === 'clicks') score = (r) => r.cur.clicks;
  else if (sortBy.endsWith('Gained')) {
    kept = rows.filter((r) => (r[metric] ?? 0) > 0);
    score = (r) => r[metric];
  } else if (sortBy.endsWith('Lost')) {
    kept = rows.filter((r) => (r[metric] ?? 0) < 0);
    score = (r) => -r[metric]!;
  } else score = (r) => (r[metric] == null ? null : Math.abs(r[metric]));

  return [...kept].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) {
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sb - sa;
    }
    return (b.cur.clicks ?? 0) - (a.cur.clicks ?? 0) || (b.prev.clicks ?? 0) - (a.prev.clicks ?? 0);
  });
}

function toColumns(r: MergedRow): unknown[] {
  return [
    ...r.keys,
    r.status,
    r.cur.clicks,
    r.prev.clicks,
    r.clicksChange,
    r.cur.impressions,
    r.prev.impressions,
    r.impressionsChange,
    r.cur.ctr,
    r.prev.ctr,
    r.cur.position,
    r.prev.position,
    diff(r.cur.position, r.prev.position, 2),
  ];
}

/** Totals from a query without dimensions: one row, or none when the period had no impressions. */
function periodTotals(rows: FetchedRow[]) {
  const s = rows[0] ? side(rows[0], 0) : ZERO;
  return { clicks: s.clicks ?? 0, impressions: s.impressions ?? 0, ctr: s.ctr, position: s.position };
}

export async function runComparePeriods(service: GscService, a: ComparePeriodsInput, maxRowsPerCall: number, signal?: AbortSignal) {
  // Everything below is checked before any request, so bad input costs no quota.
  const siteUrl = service.site(a.siteUrl);
  const { current, previous } = resolvePeriods(a);
  const dims = a.dimensions ?? [];
  const dataState = a.dataState ?? 'final';
  const common: SearchAnalyticsInput = {
    siteUrl,
    startDate: current.startDate,
    endDate: current.endDate,
    type: a.type,
    dimensionFilterGroups: a.dimensionFilterGroups,
    aggregationType: a.aggregationType,
    dataState,
    bypassCache: a.bypassCache,
  };
  const totalsQuery = (p: Period): SearchAnalyticsInput => ({ ...common, ...p, rowLimit: 1 });
  const rowsQuery = (p: Period): SearchAnalyticsInput => ({ ...common, ...p, dimensions: dims, fetchAll: true, maxRows: a.rowsPerPeriod });
  const queries = [totalsQuery(current), totalsQuery(previous), ...(dims.length ? [rowsQuery(current), rowsQuery(previous)] : [])];
  const problems = [...new Set(queries.flatMap(validateQuery))];
  if (problems.length) throw new GscToolError('INVALID_ARGUMENT', problems.join(' '));

  const results = await Promise.all(queries.map((q) => runSearchAnalytics(service, q, maxRowsPerCall, signal)));
  const [curTotals, prevTotals, curRows, prevRows] = results;
  const curSum = periodTotals(curTotals!.rows);
  const prevSum = periodTotals(prevTotals!.rows);

  const sortBy = a.sortBy ?? 'clicksChange';
  const sorted =
    curRows && prevRows
      ? sortMerged(mergePeriods(dims.length, { rows: curRows.rows, complete: !curRows.truncated }, { rows: prevRows.rows, complete: !prevRows.truncated }), sortBy)
      : undefined;
  const shown = sorted?.slice(0, a.limit ?? DEFAULT_COMPARE_LIMIT);
  const rowSection =
    sorted && shown
      ? { sortBy, columns: [...dims, ...COMPARE_COLUMNS], rows: shown.map(toColumns), rowCount: shown.length, matchingRows: sorted.length }
      : {};

  return {
    siteUrl,
    type: a.type ?? 'web',
    dataState,
    dimensions: dims,
    current: { ...current, ...curSum, ...(curRows ? { rowsFetched: curRows.rowCount, allRowsFetched: !curRows.truncated } : {}) },
    previous: { ...previous, ...prevSum, ...(prevRows ? { rowsFetched: prevRows.rowCount, allRowsFetched: !prevRows.truncated } : {}) },
    change: {
      clicks: curSum.clicks - prevSum.clicks,
      impressions: curSum.impressions - prevSum.impressions,
      ...periodChange(curSum, prevSum),
    },
    warnings: periodWarnings(current, previous, dataState, ptDay(Date.now())),
    ...rowSection,
    requests: results.reduce((n, r) => n + r.requests, 0),
    cached: results.every((r) => r.cached),
  };
}

export function registerComparePeriodsTools(server: McpServer, { service, logger, maxRowsPerCall }: ToolDeps): void {
  server.registerTool(
    'compare_periods',
    {
      title: 'Compare two periods',
      description:
        'Compares search performance between a current period and a baseline period. Returns totals for both with the change ' +
        '(clicksPct, impressionsPct, ctrPoints in percentage points, position where negative means better), and, when dimensions are given, ' +
        'rows matched across the periods with each one\'s change. Row status: "both", "new" (no data in the baseline), "gone" (no data in the current period), ' +
        'or "notInPreviousRows"/"notInCurrentRows" when the row ranked below the rows fetched for that period, so its values there are unknown (null). ' +
        'The baseline defaults to the same number of days just before currentStart. Check "warnings" before drawing conclusions. ' +
        'Totals come from a query without dimensions, so they include anonymized queries that query rows leave out. Results are cached.',
      inputSchema: comparePeriodsInput,
      annotations: READ_ONLY,
    },
    handle(logger, (args: ComparePeriodsInput, { signal }) => runComparePeriods(service, args, maxRowsPerCall, signal)),
  );
}
