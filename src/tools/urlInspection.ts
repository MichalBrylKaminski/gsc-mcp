import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GscToolError } from '../errors.js';
import type { UrlInspectionResult } from '../google/client.js';
import type { GscService } from '../google/service.js';
import { bypassCacheSchema, handle, READ_ONLY, siteUrlSchema, type ToolDeps } from './common.js';

export const MAX_BATCH_URLS = 25;
/** Stop a batch after this many Google outage errors in a row. */
export const MAX_CONSECUTIVE_UPSTREAM_ERRORS = 3;
/** Stop a batch before reverse proxies give up on it (Cloudflare drops proxied requests after 100 s). */
export const BATCH_DEADLINE_MS = 90_000;

/** Errors that mean the rest of a batch would fail too. */
const STOP_CODES = new Set(['CANCELLED', 'DAILY_QUOTA_EXHAUSTED', 'LOCAL_RATE_LIMIT', 'GOOGLE_RATE_LIMIT', 'GOOGLE_QUOTA_EXCEEDED', 'PERMISSION_DENIED', 'AUTH_ERROR', 'SITE_NOT_ALLOWED']);

export function summarizeInspection(r: UrlInspectionResult) {
  const i = r.indexStatusResult ?? {};
  return {
    verdict: i.verdict,
    coverageState: i.coverageState,
    indexingState: i.indexingState,
    robotsTxtState: i.robotsTxtState,
    pageFetchState: i.pageFetchState,
    lastCrawlTime: i.lastCrawlTime,
    crawledAs: i.crawledAs,
    googleCanonical: i.googleCanonical,
    userCanonical: i.userCanonical,
    sitemaps: i.sitemap,
    referringUrlCount: i.referringUrls?.length ?? 0,
    richResults: r.richResultsResult
      ? { verdict: r.richResultsResult.verdict, types: r.richResultsResult.detectedItems?.map((d) => d.richResultType) }
      : undefined,
    amp: r.ampResult ? { verdict: r.ampResult.verdict, ampUrl: r.ampResult.ampUrl } : undefined,
    inspectionResultLink: r.inspectionResultLink,
  };
}

const inspectionUrlSchema = z.string().url().describe('Full URL to inspect. It must belong to the property in siteUrl.');
const languageCodeSchema = z.string().optional().describe('BCP-47 language for translated issue messages, e.g. "en-US" (default) or "de-CH".');

export async function runBatchInspection(
  service: GscService,
  args: { siteUrl: string; inspectionUrls: string[]; languageCode?: string; summaryOnly?: boolean; bypassCache?: boolean },
  { signal, deadlineMs = BATCH_DEADLINE_MS }: { signal?: AbortSignal; deadlineMs?: number } = {},
) {
  const siteUrl = service.site(args.siteUrl);
  const urls = [...new Set(args.inspectionUrls)];
  if (urls.length > MAX_BATCH_URLS) throw new GscToolError('INVALID_ARGUMENT', `At most ${MAX_BATCH_URLS} URLs per batch.`);
  const deadline = Date.now() + deadlineMs;
  const results: Record<string, unknown>[] = [];
  let stopped: { code: string; message: string } | undefined;
  let upstreamErrors = 0;
  for (const url of urls) {
    if (!stopped && signal?.aborted) stopped = { code: 'CANCELLED', message: 'The client disconnected.' };
    if (!stopped && Date.now() >= deadline) {
      stopped = { code: 'LOCAL_RATE_LIMIT', message: 'Batch time limit reached; inspect the skipped URLs in another call.' };
    }
    if (stopped) {
      results.push({ inspectionUrl: url, skipped: true });
      continue;
    }
    try {
      // The deadline and signal also bound the wait for quota and the Google request itself.
      const { value, cached } = await service.inspectUrl(siteUrl, url, args.languageCode, args.bypassCache, { signal, deadline });
      upstreamErrors = 0;
      results.push({ inspectionUrl: url, cached, ...(args.summaryOnly === false ? { result: value } : summarizeInspection(value)) });
    } catch (err) {
      const e = err instanceof GscToolError ? err : new GscToolError('INTERNAL', 'Internal server error.');
      results.push({ inspectionUrl: url, error: { code: e.code, message: e.message } });
      upstreamErrors = e.code === 'UPSTREAM_ERROR' ? upstreamErrors + 1 : 0;
      if (STOP_CODES.has(e.code)) stopped = { code: e.code, message: e.message };
      else if (upstreamErrors >= MAX_CONSECUTIVE_UPSTREAM_ERRORS) {
        stopped = { code: e.code, message: `Google failed ${upstreamErrors} times in a row; try the skipped URLs later.` };
      }
    }
  }
  return {
    siteUrl,
    results,
    inspected: results.filter((r) => !r.error && !r.skipped).length,
    failed: results.filter((r) => r.error).length,
    skipped: results.filter((r) => r.skipped).length,
    ...(stopped ? { stoppedReason: stopped } : {}),
    quota: service.quotaStatus([siteUrl]).sites[0]?.urlInspectionToday,
  };
}

export function registerUrlInspectionTools(server: McpServer, { service, logger }: ToolDeps): void {
  server.registerTool(
    'inspect_url',
    {
      title: 'Inspect a URL in the Google index',
      description:
        "Returns Google's indexed view of one URL: index verdict, coverage state, robots.txt and indexing state, fetch status, last crawl, " +
        'Google vs. user canonical, sitemaps and referring URLs, plus rich-result and AMP results. It inspects the indexed version, not the live page. ' +
        'Quota is scarce: about 2,000 inspections per property per day, so results are cached for an hour.',
      inputSchema: { siteUrl: siteUrlSchema, inspectionUrl: inspectionUrlSchema, languageCode: languageCodeSchema, bypassCache: bypassCacheSchema },
      annotations: READ_ONLY,
    },
    handle(logger, async (args: { siteUrl: string; inspectionUrl: string; languageCode?: string; bypassCache?: boolean }, { signal }) => {
      const { value, cached } = await service.inspectUrl(args.siteUrl, args.inspectionUrl, args.languageCode, args.bypassCache, { signal });
      return { inspectionUrl: args.inspectionUrl, result: value, cached };
    }),
  );

  server.registerTool(
    'batch_inspect_urls',
    {
      title: 'Inspect several URLs',
      description:
        `Inspects up to ${MAX_BATCH_URLS} URLs of one property, one after another within the rate limits, and returns a compact summary per URL ` +
        '(set summaryOnly=false for full results). Stops early, marking the rest as skipped, if a quota or permission error makes further calls pointless. ' +
        "Each URL uses one of the property's ~2,000 daily inspections unless cached.",
      inputSchema: {
        siteUrl: siteUrlSchema,
        inspectionUrls: z.array(z.string().url()).min(1).max(MAX_BATCH_URLS).describe('URLs to inspect, all within siteUrl.'),
        languageCode: languageCodeSchema,
        summaryOnly: z.boolean().optional().describe('Default true. false returns the full inspection result for each URL.'),
        bypassCache: bypassCacheSchema,
      },
      annotations: READ_ONLY,
    },
    handle(logger, (args: { siteUrl: string; inspectionUrls: string[]; languageCode?: string; summaryOnly?: boolean; bypassCache?: boolean }, { signal }) =>
      runBatchInspection(service, args, { signal }),
    ),
  );
}
