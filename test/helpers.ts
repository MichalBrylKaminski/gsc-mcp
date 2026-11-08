import type { GscApi } from '../src/google/client.js';
import { GscService, type GscServiceOptions } from '../src/google/service.js';
import { silentLogger } from '../src/logger.js';

export function fakeApi(overrides: Partial<GscApi> = {}): GscApi {
  return {
    listSites: async () => [
      { siteUrl: 'https://www.example.com/', permissionLevel: 'siteRestrictedUser' },
      { siteUrl: 'sc-domain:example.org', permissionLevel: 'siteFullUser' },
    ],
    getSite: async (siteUrl) => ({ siteUrl, permissionLevel: 'siteFullUser' }),
    listSitemaps: async () => [],
    getSitemap: async (_siteUrl, feedpath) => ({ path: feedpath }),
    querySearchAnalytics: async () => ({ rows: [] }),
    inspectUrl: async () => ({ indexStatusResult: { verdict: 'PASS' } }),
    ...overrides,
  };
}

export function makeService(api: GscApi, opts: Partial<GscServiceOptions> = {}): GscService {
  return new GscService(api, {
    serviceAccountEmail: 'bot@project.iam.gserviceaccount.com',
    safetyFactor: 1,
    maxQueueWaitMs: 0,
    maxConcurrency: 4,
    cacheEnabled: true,
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
    logger: silentLogger,
    ...opts,
  });
}

/** Mimics a gaxios error from the googleapis client. */
export function googleError(status: number, reason?: string, message = 'error', headers: Record<string, string> = {}) {
  return Object.assign(new Error(message), {
    status,
    response: { status, headers: new Headers(headers), data: { error: { code: status, message, errors: reason ? [{ reason, message }] : [] } } },
  });
}
