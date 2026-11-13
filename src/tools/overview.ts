import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GscToolError } from '../errors.js';
import type { ApiDataRow } from '../google/client.js';
import type { GscService } from '../google/service.js';
import { addDays, ptDay } from '../time.js';
import { bypassCacheSchema, handle, READ_ONLY, siteUrlSchema, type ToolDeps } from './common.js';
import { formatSitemap } from './sitemaps.js';

/** Two periods plus the lag padding must fit in Search Console's ~16 months of data. */
export const MAX_OVERVIEW_DAYS = 230;
/** Extra days fetched so a long delay in final data doesn't cut the previous period short. */
export const LAG_PADDING_DAYS = 14;

interface Totals {
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  /** Days with at least one impression; days without data have no row. */
  daysWithData: number;
}

/** Sums daily rows. Position is impression-weighted, as Search Console averages it. */
export function totals(rows: ApiDataRow[]): Totals {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  for (const r of rows) {
    clicks += r.clicks ?? 0;
    impressions += r.impressions ?? 0;
    weighted += (r.position ?? 0) * (r.impressions ?? 0);
  }
  return {
    clicks,
    impressions,
    ctr: impressions ? Number((clicks / impressions).toFixed(4)) : null,
    position: impressions ? Number((weighted / impressions).toFixed(2)) : null,
    daysWithData: rows.length,
  };
}

const pct = (cur: number, prev: number) => (prev ? Number((((cur - prev) / prev) * 100).toFixed(1)) : null);

type PeriodMetrics = Pick<Totals, 'clicks' | 'impressions' | 'ctr' | 'position'>;

/** Relative change of the current period against the previous one. A negative position change is an improvement. */
export function periodChange(current: PeriodMetrics, previous: PeriodMetrics) {
  return {
    clicksPct: pct(current.clicks, previous.clicks),
    impressionsPct: pct(current.impressions, previous.impressions),
    ctrPoints: current.ctr != null && previous.ctr != null ? Number(((current.ctr - previous.ctr) * 100).toFixed(2)) : null,
    position: current.position != null && previous.position != null ? Number((current.position - previous.position).toFixed(2)) : null,
  };
}

/**
 * Final data normally lags 2-3 days. The current period never ends before
 * this many days ago, so a site that stopped getting impressions shows the
 * drop instead of an older window that ends on its last day with data.
 */
export const FINAL_DATA_LAG_DAYS = 4;

/**
 * Splits daily rows into the last `days` calendar days and the `days` before
 * that. The current period ends on the latest day with data, or
 * `today - FINAL_DATA_LAG_DAYS` if that is later. `fetchedFrom` is the first
 * date queried: a previous period starting before it would be silently
 * short, so that case is flagged.
 */
export function comparePeriods(rows: ApiDataRow[], days: number, opts: { today: string; fetchedFrom?: string }) {
  const dated = rows.filter((r) => r.keys?.[0]).sort((a, b) => a.keys![0]!.localeCompare(b.keys![0]!));
  const latestDataDate = dated.at(-1)?.keys?.[0] ?? null;
  const expectedThrough = addDays(opts.today, -FINAL_DATA_LAG_DAYS);
  const noRecentData = latestDataDate === null || latestDataDate < expectedThrough;
  const endDate = noRecentData ? expectedThrough : latestDataDate;
  const currentStart = addDays(endDate, -(days - 1));
  const previousStart = addDays(currentStart, -days);
  const inRange = (from: string, to: string) => dated.filter((r) => r.keys![0]! >= from && r.keys![0]! <= to);
  const current = totals(inRange(currentStart, endDate));
  const previous = totals(inRange(previousStart, addDays(currentStart, -1)));
  return {
    latestDataDate,
    noRecentData,
    ...(noRecentData
      ? {
          note:
            `No final data after ${latestDataDate ?? 'the fetched window'}; expected data through about ${expectedThrough}. ` +
            'The site may have lost impressions, or Google is late publishing final data.',
        }
      : {}),
    current: { startDate: currentStart, endDate, ...current },
    previous: { startDate: previousStart, endDate: addDays(currentStart, -1), ...previous },
    previousPeriodComplete: opts.fetchedFrom === undefined || previousStart >= opts.fetchedFrom,
    change: periodChange(current, previous),
  };
}

/** A section that failed: the bot still gets the other sections. */
function sectionError(reason: unknown) {
  const e = reason instanceof GscToolError ? reason : new GscToolError('INTERNAL', 'Internal server error.');
  return { error: { code: e.code, message: e.message, ...e.details } };
}

export async function runSiteOverview(
  service: GscService,
  args: { siteUrl: string; days?: number; type?: string; bypassCache?: boolean },
  signal?: AbortSignal,
) {
  const siteUrl = service.site(args.siteUrl); // bad input fails the whole call
  const days = args.days ?? 28;
  const today = ptDay(Date.now());
  const startDate = addDays(today, -(2 * days + LAG_PADDING_DAYS));
  const results = await Promise.allSettled([
    service.getSite(siteUrl, args.bypassCache, { signal }),
    service.listSitemaps(siteUrl, undefined, args.bypassCache, { signal }),
    service.querySearchAnalytics(
      siteUrl,
      { startDate, endDate: today, dimensions: ['date'], type: args.type, dataState: 'final', rowLimit: 1_000 },
      args.bypassCache,
      { signal },
    ),
  ]);
  const [site, sitemaps, analytics] = results;
  // Nothing worked (e.g. no permission, or the client left): report it as an error.
  if (site.status === 'rejected' && sitemaps.status === 'rejected' && analytics.status === 'rejected') throw site.reason;
  const maps = sitemaps.status === 'fulfilled' ? sitemaps.value.value.map(formatSitemap) : undefined;
  return {
    site:
      site.status === 'fulfilled'
        ? { siteUrl: site.value.value.siteUrl, permissionLevel: site.value.value.permissionLevel }
        : { siteUrl, ...sectionError(site.reason) },
    performance:
      analytics.status === 'fulfilled'
        ? { type: args.type ?? 'web', days, ...comparePeriods(analytics.value.value.rows ?? [], days, { today, fetchedFrom: startDate }) }
        : { type: args.type ?? 'web', days, ...sectionError(analytics.reason) },
    sitemaps: maps
      ? {
          count: maps.length,
          withErrors: maps.filter((m) => (m.errors ?? 0) > 0).length,
          withWarnings: maps.filter((m) => (m.warnings ?? 0) > 0).length,
          pending: maps.filter((m) => m.isPending).length,
          items: maps,
        }
      : sectionError(sitemaps.status === 'rejected' ? sitemaps.reason : undefined),
    cached: results.every((r) => r.status === 'fulfilled' && r.value.cached),
  };
}

export function registerOverviewTools(server: McpServer, { service, logger }: ToolDeps): void {
  server.registerTool(
    'get_site_overview',
    {
      title: 'Site overview',
      description:
        "One-call summary of a property: the service account's permission level, sitemap health, and total clicks, impressions, CTR and " +
        'average position for the last N days of final data compared with the N days before. Uses one cheap date-grouped analytics query. ' +
        'The current period ends on the latest day with final data (normally 2-3 days ago); "noRecentData" flags a site whose data stops ' +
        'earlier, which may mean it lost its search traffic. "daysWithData" counts days that had impressions. ' +
        'If one part fails (e.g. a Search Analytics cooldown), that section holds an "error" and the others are still returned.',
      inputSchema: {
        siteUrl: siteUrlSchema,
        days: z.number().int().min(1).max(MAX_OVERVIEW_DAYS).optional().describe('Length of each period in days (default 28).'),
        type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional().describe('Search type (default web).'),
        bypassCache: bypassCacheSchema,
      },
      annotations: READ_ONLY,
    },
    handle(logger, (args: { siteUrl: string; days?: number; type?: string; bypassCache?: boolean }, { signal }) => runSiteOverview(service, args, signal)),
  );
}
