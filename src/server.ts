import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './tools/common.js';
import { registerOverviewTools } from './tools/overview.js';
import { registerQuotaTools } from './tools/quota.js';
import { registerSearchAnalyticsTools } from './tools/searchAnalytics.js';
import { registerSitemapTools } from './tools/sitemaps.js';
import { registerSiteTools } from './tools/sites.js';
import { registerUrlInspectionTools } from './tools/urlInspection.js';

export const SERVER_NAME = 'gsc-mcp';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `Read-only access to Google Search Console.
Start with list_sites to get valid siteUrl values, or get_site_overview for a quick summary of one property.
search_analytics_query returns performance data (clicks, impressions, CTR, position). Keep date ranges short and dimensions few where you can; query+page grouping over long ranges is expensive.
inspect_url / batch_inspect_urls show how Google indexed specific URLs; each property has about 2,000 inspections per day.
Dates are Pacific Time. Final data usually lags 2-3 days; use dataState "all" for fresher, incomplete data.
Errors come back as JSON with a code; LOCAL_RATE_LIMIT, LOAD_QUOTA_COOLDOWN and DAILY_QUOTA_EXHAUSTED include when to retry.`;

export function buildServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerSiteTools(server, deps);
  registerSitemapTools(server, deps);
  registerSearchAnalyticsTools(server, deps);
  registerUrlInspectionTools(server, deps);
  registerOverviewTools(server, deps);
  registerQuotaTools(server, deps);
  return server;
}
