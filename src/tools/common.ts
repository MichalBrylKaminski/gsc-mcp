import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GscToolError } from '../errors.js';
import type { GscService } from '../google/service.js';
import type { Logger } from '../logger.js';

export interface ToolDeps {
  service: GscService;
  logger: Logger;
  maxRowsPerCall: number;
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const siteUrlSchema = z
  .string()
  .min(1)
  .describe('Search Console property, exactly as list_sites returns it: "https://www.example.com/" (URL-prefix) or "sc-domain:example.com" (domain).');

export const bypassCacheSchema = z.boolean().optional().describe('Skip the server cache and fetch fresh data from Google. This costs quota, so use it sparingly.');

export function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

export function fail(err: unknown, logger: Logger): CallToolResult {
  let e: GscToolError;
  if (err instanceof GscToolError) e = err;
  else {
    logger.error('unexpected tool error', { error: (err as Error)?.message });
    e = new GscToolError('INTERNAL', 'Internal server error.');
  }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: e.code, message: e.message, ...e.details } }) }] };
}

/** Wraps a tool body so every failure becomes an MCP tool error result. */
export function handle<A>(logger: Logger, fn: (args: A) => Promise<Record<string, unknown>>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err, logger);
    }
  };
}
