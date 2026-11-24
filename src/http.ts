import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ClientInfo, TokenRegistry } from './auth.js';
import type { Logger } from './logger.js';
import type { OAuthStore } from './oauth/store.js';
import { buildServer } from './server.js';
import type { ToolDeps } from './tools/common.js';

/** OAuth sign-in, when configured. */
export interface HttpOAuth {
  store: Pick<OAuthStore, 'verifyAccess'>;
  /** Sent in WWW-Authenticate on every 401, so clients can find the authorization server. */
  resourceMetadataUrl: string;
  /** The OAuth endpoints and pages, mounted at the app root. */
  router?: RequestHandler;
}

export interface HttpOptions {
  /** Accepted fixed bearer tokens; each one's name shows in the request logs. */
  tokens: TokenRegistry;
  oauth?: HttpOAuth;
  /** Express "trust proxy": how many reverse proxies sit in front of the app. */
  trustProxy?: number;
  allowedHosts?: string[];
  /** Where the MCP endpoint is served, e.g. "/mcp" (default) or "/gsc-mcp". */
  mcpPath?: string;
  deps: ToolDeps;
  logger: Logger;
}

/**
 * Bearer token check: a fixed token, or (with OAuth) an access token. The
 * client's name goes in `res.locals.client`, and in `req.auth`, which the MCP
 * SDK hands to tool handlers as `authInfo`.
 */
export function bearerAuth(tokens: TokenRegistry, logger: Logger, oauth?: Pick<HttpOAuth, 'store' | 'resourceMetadataUrl'>) {
  const challenge = (error?: string, description?: string) =>
    [
      error ? `error="${error}"` : undefined,
      description ? `error_description="${description}"` : undefined,
      oauth ? `resource_metadata="${oauth.resourceMetadataUrl}"` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
  const unauthorized = (res: Response, header: string, message: string) => {
    res
      .set('WWW-Authenticate', header ? `Bearer ${header}` : 'Bearer')
      .status(401)
      .json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
  };
  return (req: Request & { auth?: AuthInfo }, res: Response, next: NextFunction) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const given = match?.[1]!.trim();
    const result = given !== undefined ? tokens.check(given) : undefined;
    const client: ClientInfo | undefined = result?.kind === 'ok' ? result.client : given !== undefined && result?.kind === 'unknown' ? oauth?.store.verifyAccess(given) : undefined;
    if (client) {
      res.locals.client = client.name;
      req.auth = {
        token: '', // tools never need the token itself
        clientId: client.name,
        scopes: [],
        ...(client.expiresAt ? { expiresAt: Math.floor(Date.parse(client.expiresAt) / 1000) } : {}),
        extra: { client },
      };
      return next();
    }
    // Never log what was sent; a typo'd token is still mostly a secret.
    if (result?.kind === 'expired') {
      logger.warn('unauthorized request', { reason: 'expired token', client: result.name });
      unauthorized(res, challenge('invalid_token', 'The token has expired'), 'Unauthorized: the token has expired. Ask the server owner for a new one.');
      return;
    }
    logger.warn('unauthorized request', { reason: match ? 'unknown token' : 'no bearer token' });
    unauthorized(res, match ? (oauth ? challenge('invalid_token') : '') : challenge(), 'Unauthorized');
  };
}

/** What a request asks for, for the request log: the JSON-RPC method and, for tool calls, the tool. */
function describeRequest(body: unknown): { method?: string; tool?: string } {
  const one = (Array.isArray(body) ? body[0] : body) as { method?: unknown; params?: { name?: unknown } } | undefined;
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 64) : undefined);
  return { method: Array.isArray(body) ? 'batch' : text(one?.method), tool: one?.method === 'tools/call' ? text(one.params?.name) : undefined };
}

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' }, id: null });
};

export function createApp({ tokens, oauth, trustProxy, allowedHosts, mcpPath = '/mcp', deps, logger }: HttpOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (oauth?.router) app.use(oauth.router);

  const mcp = express.Router();
  if (allowedHosts?.length) mcp.use(hostHeaderValidation(allowedHosts));
  mcp.use(bearerAuth(tokens, logger, oauth));
  mcp.use(express.json({ limit: '1mb' }));

  // Stateless Streamable HTTP: a fresh server and transport per request.
  mcp.post('/', async (req, res) => {
    logger.info('mcp request', { client: res.locals.client, ...describeRequest(req.body) });
    const server = buildServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('mcp request failed', { error: (err as Error).message });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  mcp.get('/', methodNotAllowed);
  mcp.delete('/', methodNotAllowed);

  app.use(mcpPath, mcp);
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  // Body-parser failures (bad JSON, too large) as JSON-RPC errors instead of Express's HTML page.
  app.use((err: { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    const message = err.type === 'entity.parse.failed' ? 'Parse error' : status === 413 ? 'Request body too large' : 'Invalid request';
    const code = err.type === 'entity.parse.failed' ? -32700 : status === 500 ? -32603 : -32600;
    if (status === 500) logger.error('http error', { type: err.type });
    res.status(status).json({ jsonrpc: '2.0', error: { code, message: status === 500 ? 'Internal server error' : message }, id: null });
  });
  return app;
}
