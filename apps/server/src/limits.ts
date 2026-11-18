/**
 * Small in-memory limiters. Addresses are used only as keys in these maps while a connection or a
 * recent request exists; nothing here writes an address anywhere.
 */
import { isIP } from "node:net";

/** The key to limit by: an IPv4 address as is, an IPv6 address by its /64 (one household or host). */
export function ipKey(ip: string): string {
  const v = ip.trim().toLowerCase().split("%")[0] ?? "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped?.[1]) return mapped[1];
  if (isIP(v) !== 6) return v;
  const [head = "", tail] = v.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"),
          ...right,
        ];
  const first = groups.slice(0, 4).map((g) => Number.parseInt(g, 16));
  if (groups.length !== 8 || first.some((n) => Number.isNaN(n))) return v;
  return `${first.map((n) => n.toString(16)).join(":")}::/64`;
}

export interface TokenBucket {
  /** Takes `cost` tokens if there are that many; false when there are not. */
  take(cost?: number): boolean;
  tokens(): number;
}

export interface BucketOptions {
  capacity: number;
  refillPerSecond: number;
  /** Milliseconds, monotonic. */
  now: () => number;
}

export function createTokenBucket({ capacity, refillPerSecond, now }: BucketOptions): TokenBucket {
  let tokens = capacity;
  let last = now();
  const refill = (): void => {
    const t = now();
    tokens = Math.min(capacity, tokens + ((t - last) * refillPerSecond) / 1000);
    last = t;
  };
  return {
    take(cost = 1) {
      refill();
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    },
    tokens() {
      refill();
      return tokens;
    },
  };
}

export interface KeyedBuckets {
  take(key: string, cost?: number): boolean;
  /** Forgets keys whose bucket is full again: a new bucket would look the same. */
  sweep(): void;
  size(): number;
}

export function createKeyedBuckets(options: BucketOptions): KeyedBuckets {
  const buckets = new Map<string, TokenBucket>();
  return {
    take(key, cost) {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = createTokenBucket(options);
        buckets.set(key, bucket);
      }
      return bucket.take(cost);
    },
    sweep() {
      for (const [key, bucket] of buckets)
        if (bucket.tokens() >= options.capacity) buckets.delete(key);
    },
    size: () => buckets.size,
  };
}

export type GateVerdict = "ok" | "total" | "per-ip" | "rate";

export interface ConnectionGate {
  /** Counts a new connection from `key`, or says why it is refused. */
  admit(key: string): GateVerdict;
  /** Call once for every connection that `admit` let in. */
  release(key: string): void;
  sweep(): void;
  open(): number;
}

export interface ConnectionGateOptions {
  maxTotal: number;
  maxPerKey: number;
  perMinutePerKey: number;
  now: () => number;
}

export function createConnectionGate(options: ConnectionGateOptions): ConnectionGate {
  const open = new Map<string, number>();
  let total = 0;
  const rate = createKeyedBuckets({
    capacity: options.perMinutePerKey,
    refillPerSecond: options.perMinutePerKey / 60,
    now: options.now,
  });
  return {
    admit(key) {
      if (total >= options.maxTotal) return "total";
      if ((open.get(key) ?? 0) >= options.maxPerKey) return "per-ip";
      if (!rate.take(key)) return "rate";
      open.set(key, (open.get(key) ?? 0) + 1);
      total++;
      return "ok";
    },
    release(key) {
      const n = open.get(key) ?? 0;
      if (n <= 0) return;
      if (n === 1) open.delete(key);
      else open.set(key, n - 1);
      total--;
    },
    sweep: () => rate.sweep(),
    open: () => total,
  };
}

export type FloodVerdict = "ok" | "drop" | "abuse";

export interface FloodGuardOptions {
  perSecond: number;
  burst: number;
  /** Dropped messages within one window after which the connection is closed. */
  abuseAfter: number;
  now: () => number;
}

const FLOOD_WINDOW_MS = 5000;

/** One connection's message budget: over it messages are dropped, far over it the page is cut off. */
export function createFloodGuard(options: FloodGuardOptions): { check(): FloodVerdict } {
  const bucket = createTokenBucket({
    capacity: options.burst,
    refillPerSecond: options.perSecond,
    now: options.now,
  });
  let windowStart = options.now();
  let drops = 0;
  return {
    check() {
      const t = options.now();
      if (t - windowStart >= FLOOD_WINDOW_MS) {
        windowStart = t;
        drops = 0;
      }
      if (bucket.take()) return "ok";
      drops++;
      return drops > options.abuseAfter ? "abuse" : "drop";
    },
  };
}
