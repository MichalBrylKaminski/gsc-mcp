import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GscToolError } from '../errors.js';
import type { SearchAnalyticsQueryRequest, SearchAnalyticsQueryResponse } from '../google/client.js';
import type { GscService } from '../google/service.js';
import { bypassCacheSchema, handle, READ_ONLY, siteUrlSchema, type ToolDeps } from './common.js';

/** Google's maximum rows per Search Analytics request. */
export const MAX_PAGE_SIZE = 25_000;
/** fetchAll's default row target: 25,000 query+page rows would be several MB, too much for an LLM's context. */
export const DEFAULT_FETCH_ALL_ROWS = 5_000;

const DIMENSIONS = ['date', 'hour', 'query', 'page', 'country', 'device', 'searchAppearance'] as const;
const FILTER_DIMENSIONS = ['country', 'device', 'page', 'query', 'searchAppearance'] as const;
const OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'] as const;
const TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const searchAnalyticsInput = {
  siteUrl: siteUrlSchema,
  startDate: date.describe('First day, inclusive, YYYY-MM-DD in Pacific Time. Data goes back about 16 months.'),
  endDate: date.describe('Last day, inclusive, YYYY-MM-DD in Pacific Time.'),
  dimensions: z
    .array(z.enum(DIMENSIONS))
    .optional()
    .describe(
      'Group rows by these dimensions, in order. Omit for one row of totals. "hour" requires dataState "hourly_all". ' +
        'Cost note: grouping by "query" and/or "page" is the most expensive for Google\'s load quota, especially both together over long ranges.',
    ),
  type: z.enum(TYPES).optional().describe('Search type. "web" (default) is the combined "All" tab in Search Console.'),
  dimensionFilterGroups: z
    .array(
      z.object({
        groupType: z.literal('and').optional().describe('Only "and" is supported by Google.'),
        filters: z
          .array(
            z.object({
              dimension: z.enum(FILTER_DIMENSIONS),
              operator: z.enum(OPERATORS).optional().describe('Default "equals" (case-sensitive for page and query). Regex operators use RE2 syntax.'),
              expression: z
                .string()
                .min(1)
                .max(4096)
                .describe('Value to match. country: ISO 3166-1 alpha-3 (e.g. "USA"); device: DESKTOP, MOBILE or TABLET.'),
            }),
          )
          .min(1),
      }),
    )
    .optional()
    .describe('Row filters. All filters in a group must match.'),
  aggregationType: z
    .enum(['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'])
    .optional()
    .describe('How to aggregate. "byProperty" cannot be used with page grouping/filters or with discover/googleNews.'),
  dataState: z
    .enum(['final', 'all', 'hourly_all'])
    .optional()
    .describe('"final" (default): finished data only. "all": includes fresh, incomplete data. "hourly_all": hourly data, use with the "hour" dimension.'),
  rowLimit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe('Rows to return (1-25000, default 1000). Rows are sorted by clicks, descending.'),
  startRow: z.number().int().min(0).optional().describe('Zero-based row offset for paging (default 0).'),
  fetchAll: z
    .boolean()
    .optional()
    .describe('Page through results automatically (25,000 rows per request) until no rows are left or maxRows is reached.'),
  maxRows: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`With fetchAll: stop after this many rows (default ${DEFAULT_FETCH_ALL_ROWS.toLocaleString('en-US')}, capped by the server limit). Large results can overflow your context.`),
  bypassCache: bypassCacheSchema,
};

const inputObject = z.object(searchAnalyticsInput);
export type SearchAnalyticsInput = z.infer<typeof inputObject>;

/** Catches request combinations Google would reject, before spending quota. */
export function validateQuery(q: SearchAnalyticsInput): string[] {
  const errors: string[] = [];
  const dims = q.dimensions ?? [];
  const filters = (q.dimensionFilterGroups ?? []).flatMap((g) => g.filters);
  if (q.startDate > q.endDate) errors.push('startDate must be on or before endDate.');
  if (new Set(dims).size !== dims.length) errors.push('Each dimension can appear only once.');
  if (dims.includes('hour') && q.dataState !== 'hourly_all') errors.push('The "hour" dimension requires dataState "hourly_all".');
  if (q.aggregationType === 'byProperty') {
    if (dims.includes('page') || filters.some((f) => f.dimension === 'page')) {
      errors.push('aggregationType "byProperty" cannot be combined with page grouping or page filters.');
    }
    if (q.type === 'discover' || q.type === 'googleNews') errors.push('aggregationType "byProperty" is not supported for discover or googleNews.');
  }
  if (q.aggregationType === 'byNewsShowcasePanel') {
    if (q.type !== 'discover' && q.type !== 'googleNews') errors.push('aggregationType "byNewsShowcasePanel" requires type "discover" or "googleNews".');
    if (!filters.some((f) => f.dimension === 'searchAppearance' && (f.operator ?? 'equals') === 'equals' && f.expression === 'NEWS_SHOWCASE')) {
      errors.push('aggregationType "byNewsShowcasePanel" requires a searchAppearance equals NEWS_SHOWCASE filter.');
    }
  }
  return errors;
}

const round = (n: number | null | undefined, digits: number) => (n == null ? null : Number(n.toFixed(digits)));

/** Fetches one or more pages and returns compact, column-oriented rows. */
export async function runSearchAnalytics(service: GscService, q: SearchAnalyticsInput, maxRowsPerCall: number, signal?: AbortSignal) {
  const problems = validateQuery(q);
  if (problems.length) throw new GscToolError('INVALID_ARGUMENT', problems.join(' '));

  const siteUrl = service.site(q.siteUrl);
  const dims = q.dimensions ?? [];
  const body: SearchAnalyticsQueryRequest = {
    startDate: q.startDate,
    endDate: q.endDate,
    dimensions: dims.length ? dims : undefined,
    type: q.type,
    dimensionFilterGroups: q.dimensionFilterGroups?.map((g) => ({
      groupType: g.groupType ?? 'and',
      filters: g.filters.map((f) => ({ dimension: f.dimension, operator: f.operator ?? 'equals', expression: f.expression })),
    })),
    aggregationType: q.aggregationType,
    dataState: q.dataState,
  };

  const target = q.fetchAll ? Math.min(q.maxRows ?? DEFAULT_FETCH_ALL_ROWS, maxRowsPerCall) : Math.min(q.rowLimit ?? 1_000, maxRowsPerCall);
  const pageSize = q.fetchAll ? MAX_PAGE_SIZE : target;
  const rows: unknown[][] = [];
  let startRow = q.startRow ?? 0;
  let last: SearchAnalyticsQueryResponse = {};
  let pages = 0;
  let allCached = true;
  let exhausted = false;

  while (rows.length < target) {
    const want = Math.min(pageSize, target - rows.length);
    // The service stops at once if the client disconnected, including between pages.
    const { value, cached } = await service.querySearchAnalytics(siteUrl, { ...body, rowLimit: want, startRow }, q.bypassCache, { signal });
    pages++;
    allCached &&= cached;
    last = value;
    const got = value.rows ?? [];
    for (const r of got) {
      rows.push([...(r.keys ?? []), r.clicks ?? 0, r.impressions ?? 0, round(r.ctr, 4), round(r.position, 2)]);
    }
    startRow += got.length;
    if (got.length < want) {
      exhausted = true;
      break;
    }
    if (!q.fetchAll) break;
  }

  const truncated = !exhausted;
  return {
    siteUrl,
    startDate: q.startDate,
    endDate: q.endDate,
    type: q.type ?? 'web',
    dataState: q.dataState ?? 'final',
    responseAggregationType: last.responseAggregationType,
    metadata: last.metadata,
    columns: [...dims, 'clicks', 'impressions', 'ctr', 'position'],
    rows,
    rowCount: rows.length,
    truncated,
    ...(truncated ? { nextStartRow: startRow } : {}),
    requests: pages,
    cached: allCached,
  };
}

export function registerSearchAnalyticsTools(server: McpServer, { service, logger, maxRowsPerCall }: ToolDeps): void {
  server.registerTool(
    'search_analytics_query',
    {
      title: 'Query search performance',
      description:
        'Clicks, impressions, CTR (0-1) and average position from Search Console Performance reports, grouped and filtered as requested. ' +
        'Rows are returned as arrays matching "columns", sorted by clicks. Google exposes at most about 50,000 rows per day per search type. ' +
        'To save quota: prefer few dimensions and short date ranges; query+page grouping over months is the most expensive request. ' +
        'Results are cached, so repeating a query is free. If "truncated" is true, more rows may exist: page with startRow=nextStartRow or use fetchAll.',
      inputSchema: searchAnalyticsInput,
      annotations: READ_ONLY,
    },
    handle(logger, (args: SearchAnalyticsInput, { signal }) => runSearchAnalytics(service, args, maxRowsPerCall, signal)),
  );
}
