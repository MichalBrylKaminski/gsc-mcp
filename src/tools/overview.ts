import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiDataRow } from '../google/client.js';
import type { GscService } from '../google/service.js';
import { addDays, ptDay } from '../time.js';
import { bypassCacheSchema, handle, READ_ONLY, siteUrlSchema, type ToolDeps } from './common.js';
import { formatSitemap } from './sitemaps.js';

export const MAX_OVERVIEW_DAYS = 240;

interface Totals {
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  days: number;
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
    days: rows.length,
  };
}

const pct = (cur: number, prev: number) => (prev ? Number((((cur - prev) / prev) * 100).toFixed(1)) : null);

/**
 * Splits daily rows into the last `days` days of available data and the
 * `days` before that. Fresh days without final data are left out, so both
 * periods cover the same number of calendar days.
 */
export function comparePeriods(rows: ApiDataRow[], days: number) {
  const dated = rows.filter((r) => r.keys?.[0]).sort((a, b) => a.keys![0]!.localeCompare(b.keys![0]!));
  const dataThrough = dated.at(-1)?.keys?.[0];
  if (!dataThrough) return { dataThrough: null, current: null, previous: null, change: null };
  const currentStart = addDays(dataThrough, -(days - 1));
  const previousStart = addDays(currentStart, -days);
  const current = totals(dated.filter((r) => r.keys![0]! >= currentStart));
  const previous = totals(dated.filter((r) => r.keys![0]! >= previousStart && r.keys![0]! < currentStart));
  return {
    dataThrough,
    current: { startDate: currentStart, endDate: dataThrough, ...current },
    previous: { startDate: previousStart, endDate: addDays(currentStart, -1), ...previous },
    change: {
      clicksPct: pct(current.clicks, previous.clicks),
      impressionsPct: pct(current.impressions, previous.impressions),
      ctrPoints: current.ctr != null && previous.ctr != null ? Number(((current.ctr - previous.ctr) * 100).toFixed(2)) : null,
      position: current.position != null && previous.position != null ? Number((current.position - previous.position).toFixed(2)) : null,
    },
  };
}

export async function runSiteOverview(service: GscService, args: { siteUrl: string; days?: number; type?: string; bypassCache?: boolean }) {
  const days = args.days ?? 28;
  const today = ptDay(Date.now());
  // Extra days cover the 2-3 day lag before data is final.
  const startDate = addDays(today, -(2 * days + 4));
  const [site, sitemaps, analytics] = await Promise.all([
    service.getSite(args.siteUrl, args.bypassCache),
    service.listSitemaps(args.siteUrl, undefined, args.bypassCache),
    service.querySearchAnalytics(
      args.siteUrl,
      { startDate, endDate: today, dimensions: ['date'], type: args.type, dataState: 'final', rowLimit: 1_000 },
      args.bypassCache,
    ),
  ]);
  const maps = sitemaps.value.map(formatSitemap);
  return {
    site: { siteUrl: site.value.siteUrl, permissionLevel: site.value.permissionLevel },
    performance: { type: args.type ?? 'web', days, ...comparePeriods(analytics.value.rows ?? [], days) },
    sitemaps: {
      count: maps.length,
      withErrors: maps.filter((m) => (m.errors ?? 0) > 0).length,
      withWarnings: maps.filter((m) => (m.warnings ?? 0) > 0).length,
      pending: maps.filter((m) => m.isPending).length,
      items: maps,
    },
    cached: site.cached && sitemaps.cached && analytics.cached,
  };
}

export function registerOverviewTools(server: McpServer, { service, logger }: ToolDeps): void {
  server.registerTool(
    'get_site_overview',
    {
      title: 'Site overview',
      description:
        "One-call summary of a property: the service account's permission level, sitemap health, and total clicks, impressions, CTR and " +
        'average position for the last N days of final data compared with the N days before. Uses one cheap date-grouped analytics query.',
      inputSchema: {
        siteUrl: siteUrlSchema,
        days: z.number().int().min(1).max(MAX_OVERVIEW_DAYS).optional().describe('Length of each period in days (default 28).'),
        type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional().describe('Search type (default web).'),
        bypassCache: bypassCacheSchema,
      },
      annotations: READ_ONLY,
    },
    handle(logger, (args: { siteUrl: string; days?: number; type?: string; bypassCache?: boolean }) => runSiteOverview(service, args)),
  );
}
