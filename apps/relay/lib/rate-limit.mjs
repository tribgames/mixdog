export const MAX_RATE_KEYS = 10_000;

export class RateLimiter {
  constructor(limit, windowMs, maxKeys = MAX_RATE_KEYS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = Math.max(1, Number(maxKeys) || MAX_RATE_KEYS);
    this.hits = new Map();
  }

  allow(key) {
    const id = String(key || 'unknown');
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const prior = this.hits.get(id);
    if (prior) this.hits.delete(id);
    if (!prior && this.hits.size >= this.maxKeys) {
      for (const [existing, stamps] of this.hits) {
        const live = stamps.filter((stamp) => stamp > cutoff);
        if (live.length) this.hits.set(existing, live);
        else this.hits.delete(existing);
      }
      // An attacker can keep every key live. Enforce the cap after the expiry
      // sweep as an LRU: bounded memory outranks retaining an old bucket.
      while (this.hits.size >= this.maxKeys) {
        const oldest = this.hits.keys().next().value;
        if (oldest === undefined) break;
        this.hits.delete(oldest);
      }
    }
    const stamps = (prior || []).filter((stamp) => stamp > cutoff);
    if (stamps.length >= this.limit) {
      this.hits.set(id, stamps);
      return false;
    }
    stamps.push(now);
    this.hits.set(id, stamps);
    return true;
  }
}
