import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GOOGLE_LIMITS } from '../limits/quotas.js';
import { handle, READ_ONLY, type ToolDeps } from './common.js';

export function registerQuotaTools(server: McpServer, { service, logger }: ToolDeps): void {
  server.registerTool(
    'get_quota_status',
    {
      title: 'Quota status',
      description:
        "Shows this server's own quota counters: URL inspections used and left today per property, current per-minute usage, any " +
        'Search Analytics cooldown, and when daily quotas reset (midnight Pacific). Makes no Google call unless siteUrls is omitted, ' +
        'in which case it lists sites (usually from cache).',
      inputSchema: {
        siteUrls: z.array(z.string().min(1)).max(100).optional().describe('Properties to report on. Default: every property from list_sites.'),
      },
      annotations: READ_ONLY,
    },
    handle(logger, async ({ siteUrls }: { siteUrls?: string[] }) => {
      // Values from Google are reported as-is; only user input is validated.
      const sites = siteUrls ? siteUrls.map((s) => service.site(s)) : (await service.listSites()).value.map((s) => s.siteUrl!).filter(Boolean);
      return {
        ...service.quotaStatus(sites),
        googlePublishedLimits: GOOGLE_LIMITS,
        note: 'Counts are local to this server. Search Analytics also has an unpublished load quota; long ranges and query/page grouping use more of it.',
      };
    }),
  );
}
