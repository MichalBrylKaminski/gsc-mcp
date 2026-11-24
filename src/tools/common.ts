import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GscToolError } from '../errors.js';
import { EXPIRY_WARNING_DAYS, type ClientInfo } from '../auth.js';
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

/** What a tool body gets besides its arguments. `signal` aborts when the client goes away. */
export interface ToolContext {
  signal: AbortSignal;
  /** The client behind the request's token (set by the HTTP layer). */
  client?: ClientInfo;
}

/** A line the agent will see in every result while its token is close to expiring. */
export function tokenNotice(client: ClientInfo | undefined): string | undefined {
  if (client?.daysLeft === undefined || client.daysLeft > EXPIRY_WARNING_DAYS) return undefined;
  const when = client.daysLeft <= 1 ? 'within a day' : `in ${client.daysLeft} days`;
  return `This client's token (${client.name}) expires ${when}, at ${client.expiresAt}. Tell the server owner so they can issue a new one.`;
}

/** Wraps a tool body so every failure becomes an MCP tool error result. */
export function handle<A>(
  logger: Logger,
  fn: (args: A, ctx: ToolContext) => Promise<Record<string, unknown>>,
): (args: A, extra: { signal: AbortSignal; authInfo?: AuthInfo }) => Promise<CallToolResult> {
  return async (args, extra) => {
    const client = extra.authInfo?.extra?.client as ClientInfo | undefined;
    try {
      const data = await fn(args, { signal: extra.signal, client });
      const notice = tokenNotice(client);
      return ok(notice ? { ...data, tokenNotice: notice } : data);
    } catch (err) {
      return fail(err, logger);
    }
  };
}
