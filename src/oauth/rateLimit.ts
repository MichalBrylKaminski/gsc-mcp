/** Cap on tracked addresses, so a spread-out flood can't grow memory without bound. */
const MAX_KEYS = 10_000;

/**
 * A fixed-window counter per key (a client IP): at most `limit` hits per
 * `windowMs`. In memory; a restart resets it.
 */
export class RateLimit {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Counts a hit; false when the key is over its limit. */
  take(key: string): boolean {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || now >= h.resetAt) {
      if (!h && this.hits.size >= MAX_KEYS) {
        for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
        if (this.hits.size >= MAX_KEYS) this.hits.delete(this.hits.keys().next().value!);
      }
      h = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, h);
    }
    h.count++;
    return h.count <= this.limit;
  }
}
