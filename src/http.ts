import { createHash, timingSafeEqual } from 'node:crypto';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Logger } from './logger.js';
import { buildServer } from './server.js';
import type { ToolDeps } from './tools/common.js';

export interface HttpOptions {
  authToken: string;
  allowedHosts?: string[];
  /** Where the MCP endpoint is served, e.g. "/mcp" (default) or "/gsc-mcp". */
  mcpPath?: string;
  deps: ToolDeps;
  logger: Logger;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time bearer token check (hashing first makes lengths equal). */
export function bearerAuth(token: string) {
  const expected = digest(token);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match && timingSafeEqual(digest(match[1]!.trim()), expected)) return next();
    res.set('WWW-Authenticate', 'Bearer').status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  };
}

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' }, id: null });
};

export function createApp({ authToken, allowedHosts, mcpPath = '/mcp', deps, logger }: HttpOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const mcp = express.Router();
  if (allowedHosts?.length) mcp.use(hostHeaderValidation(allowedHosts));
  mcp.use(bearerAuth(authToken));
  mcp.use(express.json({ limit: '1mb' }));

  // Stateless Streamable HTTP: a fresh server and transport per request.
  mcp.post('/', async (req, res) => {
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
