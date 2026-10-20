/** Per-key token buckets. Each request class has its own capacity and refill rate. */

export interface BucketSpec {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export type RateClass = 'read' | 'write' | 'heartbeat' | 'register' | 'publish' | 'report';

export const DEFAULT_RATE_LIMITS: Record<RateClass, BucketSpec> = {
  read: { capacity: 240, refillPerSecond: 4 },
  write: { capacity: 60, refillPerSecond: 1 },
  // One IP may run many servers, each heartbeating every 30 s.
  heartbeat: { capacity: 240, refillPerSecond: 4 },
  register: { capacity: 10, refillPerSecond: 10 / 3600 },
  publish: { capacity: 20, refillPerSecond: 20 / 3600 },
  // Abuse reports: at most 5 per IP per hour.
  report: { capacity: 5, refillPerSecond: 5 / 3600 },
};

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly specs: Record<RateClass, BucketSpec>,
    private readonly now: () => number,
  ) {}

  /** Takes one token. Returns 0 when allowed, otherwise the seconds until a token is available. */
  take(cls: RateClass, key: string): number {
    const spec = this.specs[cls];
    const id = `${cls}|${key}`;
    const t = this.now();
    let b = this.buckets.get(id);
    if (!b) {
      if (this.buckets.size > 50_000) this.sweep(t);
      b = { tokens: spec.capacity, updated: t };
      this.buckets.set(id, b);
    }
    b.tokens = Math.min(spec.capacity, b.tokens + ((t - b.updated) / 1000) * spec.refillPerSecond);
    b.updated = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / spec.refillPerSecond));
  }

  /** Drops buckets that have refilled completely; they carry no state. */
  private sweep(t: number): void {
    for (const [id, b] of this.buckets) {
      const spec = this.specs[id.slice(0, id.indexOf('|')) as RateClass];
      if (b.tokens + ((t - b.updated) / 1000) * spec.refillPerSecond >= spec.capacity) this.buckets.delete(id);
    }
  }
}
