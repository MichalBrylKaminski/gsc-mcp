import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createGscApi, readServiceAccountKey } from './google/client.js';
import { GscService } from './google/service.js';
import { createApp } from './http.js';
import { createLogger } from './logger.js';
import { SERVER_VERSION } from './server.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const key = readServiceAccountKey(config.GOOGLE_APPLICATION_CREDENTIALS);
  const serviceAccountEmail = key.client_email;

  const service = new GscService(createGscApi(key), {
    serviceAccountEmail,
    allowedSites: config.GSC_ALLOWED_SITES,
    safetyFactor: config.QUOTA_SAFETY_FACTOR,
    maxQueueWaitMs: config.MAX_QUEUE_WAIT_MS,
    maxConcurrency: config.MAX_CONCURRENCY,
    cacheEnabled: config.CACHE_ENABLED,
    quotaStateFile: join(config.DATA_DIR, 'quota-state.json'),
    logger,
  });

  const app = createApp({
    authToken: config.MCP_AUTH_TOKEN,
    allowedHosts: config.ALLOWED_HOSTS,
    deps: { service, logger, maxRowsPerCall: config.GSC_MAX_ROWS_PER_CALL },
    logger,
  });

  const httpServer = app.listen(config.PORT, config.HOST, () => {
    logger.info('gsc-mcp listening', {
      version: SERVER_VERSION,
      host: config.HOST,
      port: config.PORT,
      serviceAccount: serviceAccountEmail,
      allowedSites: config.GSC_ALLOWED_SITES?.length ?? 'all',
      safetyFactor: config.QUOTA_SAFETY_FACTOR,
    });
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    httpServer.close(() => {
      void service.flush().finally(() => process.exit(0));
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
