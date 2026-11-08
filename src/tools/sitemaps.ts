import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WmxSitemap } from '../google/client.js';
import { bypassCacheSchema, handle, READ_ONLY, siteUrlSchema, type ToolDeps } from './common.js';

/** Google returns int64 counts as strings; numbers are easier for models. */
export function formatSitemap(s: WmxSitemap) {
  const num = (v: string | null | undefined) => (v == null ? undefined : Number(v));
  return {
    path: s.path,
    type: s.type,
    isSitemapsIndex: s.isSitemapsIndex,
    isPending: s.isPending,
    lastSubmitted: s.lastSubmitted,
    lastDownloaded: s.lastDownloaded,
    errors: num(s.errors),
    warnings: num(s.warnings),
    contents: s.contents?.map((c) => ({ type: c.type, submitted: num(c.submitted), indexed: num(c.indexed) })),
  };
}

export function registerSitemapTools(server: McpServer, { service, logger }: ToolDeps): void {
  server.registerTool(
    'list_sitemaps',
    {
      title: 'List sitemaps',
      description:
        'Lists the sitemaps submitted for a property (or the children of one sitemap index), with type, last submit/download times, ' +
        'error and warning counts, and submitted URL counts per content type.',
      inputSchema: {
        siteUrl: siteUrlSchema,
        sitemapIndex: z.string().url().optional().describe("A sitemap index URL. If set, lists only that index's child sitemaps."),
        bypassCache: bypassCacheSchema,
      },
      annotations: READ_ONLY,
    },
    handle(logger, async ({ siteUrl, sitemapIndex, bypassCache }: { siteUrl: string; sitemapIndex?: string; bypassCache?: boolean }) => {
      const { value, cached } = await service.listSitemaps(siteUrl, sitemapIndex, bypassCache);
      return { sitemaps: value.map(formatSitemap), count: value.length, cached };
    }),
  );

  server.registerTool(
    'get_sitemap',
    {
      title: 'Get a sitemap',
      description: 'Returns the details of one submitted sitemap: status, last submit/download times, errors, warnings and URL counts.',
      inputSchema: {
        siteUrl: siteUrlSchema,
        feedpath: z.string().url().describe('Full URL of the sitemap, e.g. "https://www.example.com/sitemap.xml".'),
        bypassCache: bypassCacheSchema,
      },
      annotations: READ_ONLY,
    },
    handle(logger, async ({ siteUrl, feedpath, bypassCache }: { siteUrl: string; feedpath: string; bypassCache?: boolean }) => {
      const { value, cached } = await service.getSitemap(siteUrl, feedpath, bypassCache);
      return { sitemap: formatSitemap(value), cached };
    }),
  );
}
