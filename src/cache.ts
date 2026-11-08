import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';

/** Cache lifetimes. Google asks clients not to re-query the same data. */
export const TTL = {
  analyticsFinal: 6 * 3_600_000,
  analyticsFresh: 5 * 60_000,
  sites: 15 * 60_000,
  sitemaps: 15 * 60_000,
  inspection: 3_600_000,
} as const;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export function cacheKey(method: string, params: unknown): string {
  return `${method}:${createHash('sha256').update(JSON.stringify(stable(params))).digest('hex')}`;
}

/** LRU+TTL cache that also shares one in-flight load between identical callers. */
export class ResponseCache {
  private lru: LRUCache<string, { value: unknown }>;
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly enabled: boolean,
    maxBytes = 64 * 1024 * 1024,
  ) {
    this.lru = new LRUCache({
      maxSize: maxBytes,
      sizeCalculation: (entry) => Math.max(1, JSON.stringify(entry.value)?.length ?? 1),
      ttlAutopurge: false,
    });
  }

  async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>, bypass = false): Promise<{ value: T; hit: boolean }> {
    if (!this.enabled) return { value: await load(), hit: false };
    if (!bypass) {
      const hit = this.lru.get(key);
      if (hit) return { value: hit.value as T, hit: true };
      const pending = this.inflight.get(key);
      if (pending) return { value: (await pending) as T, hit: true };
    }
    const promise = load();
    this.inflight.set(key, promise);
    try {
      const value = await promise;
      this.lru.set(key, { value }, { ttl: ttlMs });
      return { value, hit: false };
    } finally {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    }
  }
}
