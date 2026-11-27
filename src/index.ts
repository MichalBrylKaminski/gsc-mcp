import { join } from 'node:path';
import { TokenRegistry } from './auth.js';
import { loadConfig } from './config.js';
import { createGscApi, readServiceAccountKey } from './google/client.js';
import { GscService } from './google/service.js';
import { createApp, type HttpOAuth } from './http.js';
import { ensureWritableDir } from './limits/limiter.js';
import { createLogger } from './logger.js';
import { googleSignIn } from './oauth/google.js';
import { GscOAuthProvider } from './oauth/provider.js';
import { oauthRouter, resourceMetadataUrl } from './oauth/routes.js';
import { OAuthStore } from './oauth/store.js';
import { SERVER_VERSION } from './server.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const key = readServiceAccountKey(config.GOOGLE_APPLICATION_CREDENTIALS);
  ensureWritableDir(config.DATA_DIR);
  const serviceAccountEmail = key.client_email;

  const service = new GscService(createGscApi(key), {
    serviceAccountEmail,
    allowedSites: config.GSC_ALLOWED_SITES,
    safetyFactor: config.QUOTA_SAFETY_FACTOR,
    maxQueueWaitMs: config.MAX_QUEUE_WAIT_MS,
    maxConcurrency: config.MAX_CONCURRENCY,
    cacheEnabled: config.CACHE_ENABLED,
    quotaStateFile: join(config.DATA_DIR, 'quota-state.json'),
    pauseStateFile: join(config.DATA_DIR, 'pause-state.json'),
    logger,
  });

  const tokens = new TokenRegistry(config.authTokens, { autoExpire: config.MCP_AUTH_AUTO_EXPIRE, logger });

  let oauth: HttpOAuth | undefined;
  let oauthStore: OAuthStore | undefined;
  if (config.oauth) {
    const { publicUrl, googleClientId, googleClientSecret, allowedEmails } = config.oauth;
    const store = new OAuthStore({ file: join(config.DATA_DIR, 'oauth-state.json'), ttlDays: config.MCP_AUTH_TOKEN_TTL_DAYS, logger });
    const google = googleSignIn({ clientId: googleClientId, clientSecret: googleClientSecret, redirectUri: new URL('/oauth/google/callback', publicUrl).href });
    const provider = new GscOAuthProvider({ store, google, allowedEmails, ttlDays: config.MCP_AUTH_TOKEN_TTL_DAYS, logger });
    oauth = {
      store,
      resourceMetadataUrl: resourceMetadataUrl(publicUrl, config.MCP_PATH),
      router: oauthRouter({ provider, publicUrl, mcpPath: config.MCP_PATH, store, fixedClients: () => tokens.clients(), logger }),
    };
    oauthStore = store;
    if (config.TRUST_PROXY === undefined) logger.warn('TRUST_PROXY is not set; rate limits will see the proxy as the client');
  }

  const app = createApp({
    tokens,
    oauth,
    trustProxy: config.TRUST_PROXY,
    allowedHosts: config.ALLOWED_HOSTS,
    mcpPath: config.MCP_PATH,
    deps: { service, logger, maxRowsPerCall: config.GSC_MAX_ROWS_PER_CALL },
    logger,
  });

  const httpServer = app.listen(config.PORT, config.HOST, (err?: Error) => {
    if (err) {
      logger.error('cannot listen', { host: config.HOST, port: config.PORT, error: err.message });
      process.exit(1);
    }
    logger.info('gsc-mcp listening', {
      version: SERVER_VERSION,
      host: config.HOST,
      port: config.PORT,
      serviceAccount: serviceAccountEmail,
      allowedSites: config.GSC_ALLOWED_SITES?.length ?? 'all',
      clients: tokens.clients(),
      tokenAutoExpire: config.MCP_AUTH_AUTO_EXPIRE,
      oauth: config.oauth
        ? { publicUrl: config.oauth.publicUrl.href, allowedEmails: config.oauth.allowedEmails.length, grants: oauthStore!.grants().length }
        : 'off',
      safetyFactor: config.QUOTA_SAFETY_FACTOR,
    });
  });

  // Outlive reverse-proxy idle connections (Caddy keeps them 2 min, nginx 60 s
  // by default), so the proxy never reuses a socket Node is closing.
  httpServer.keepAliveTimeout = 125_000;
  httpServer.headersTimeout = 130_000;

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    httpServer.close(() => {
      void Promise.allSettled([service.flush(), oauthStore?.flush()]).finally(() => {
        oauthStore?.close();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
