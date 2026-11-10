import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { bypassCacheSchema, handle, READ_ONLY, siteUrlSchema, type ToolDeps } from './common.js';

export function registerSiteTools(server: McpServer, { service, logger }: ToolDeps): void {
  server.registerTool(
    'list_sites',
    {
      title: 'List Search Console properties',
      description:
        'Lists every Search Console property this server can read, with its permission level. ' +
        'Start here: the siteUrl values it returns are what the other tools expect.',
      inputSchema: { bypassCache: bypassCacheSchema },
      annotations: READ_ONLY,
    },
    handle(logger, async ({ bypassCache }, { signal }) => {
      const { value, cached } = await service.listSites(bypassCache, { signal });
      return { sites: value.map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel })), count: value.length, cached };
    }),
  );

  server.registerTool(
    'get_site',
    {
      title: 'Get a Search Console property',
      description: "Returns one property's details: its siteUrl and the service account's permission level on it.",
      inputSchema: { siteUrl: siteUrlSchema, bypassCache: bypassCacheSchema },
      annotations: READ_ONLY,
    },
    handle(logger, async ({ siteUrl, bypassCache }: { siteUrl: string; bypassCache?: boolean }, { signal }) => {
      const { value, cached } = await service.getSite(siteUrl, bypassCache, { signal });
      return { site: { siteUrl: value.siteUrl, permissionLevel: value.permissionLevel }, cached };
    }),
  );
}
