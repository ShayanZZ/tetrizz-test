import { describe, expect, it } from "vitest";
import {
  createConnectionGate,
  createFloodGuard,
  createKeyedBuckets,
  createTokenBucket,
  ipKey,
} from "../../apps/server/src/limits";

const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("ipKey", () => {
  it("keeps IPv4 as it is and unwraps IPv4-mapped IPv6", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("limits IPv6 by its /64 so one household cannot hold millions of addresses", () => {
    const a = ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    const b = ipKey("2001:DB8:1:2::1");
    const c = ipKey("2001:db8:1:3::1");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("returns what it cannot read unchanged", () => {
    expect(ipKey("unknown")).toBe("unknown");
    expect(ipKey("")).toBe("");
  });
});

describe("token bucket", () => {
  it("spends its burst, refills over time, and never exceeds its capacity", () => {
    const c = clock();
    const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 2, now: c.now });
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    c.advance(500);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    c.advance(60_000);
    expect(bucket.tokens()).toBe(3);
    expect(bucket.take(3)).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it("keeps a bucket per key and forgets keys that are full again", () => {
    const c = clock();
    const buckets = createKeyedBuckets({ capacity: 2, refillPerSecond: 1, now: c.now });
    expect(buckets.take("a")).toBe(true);
    expect(buckets.take("a")).toBe(true);
    expect(buckets.take("a")).toBe(false);
    expect(buckets.take("b")).toBe(true);
    expect(buckets.size()).toBe(2);
    buckets.sweep();
    expect(buckets.size()).toBe(2);
    c.advance(10_000);
    buckets.sweep();
    expect(buckets.size()).toBe(0);
    expect(buckets.take("a")).toBe(true);
  });
});

describe("connection gate", () => {
  const make = (over = {}) => {
    const c = clock();
    const gate = createConnectionGate({
      maxTotal: 4,
      maxPerKey: 2,
      perMinutePerKey: 6,
      now: c.now,
      ...over,
    });
    return { c, gate };
  };

  it("caps connections per address, then in total", () => {
    const { gate } = make();
    expect(gate.admit("a")).toBe("ok");
    expect(gate.admit("a")).toBe("ok");
    expect(gate.admit("a")).toBe("per-ip");
    expect(gate.admit("b")).toBe("ok");
    expect(gate.admit("c")).toBe("ok");
    expect(gate.open()).toBe(4);
    expect(gate.admit("d")).toBe("total");
  });

  it("frees a place when a connection ends, and ignores a release it never admitted", () => {
    const { gate } = make();
    gate.admit("a");
    gate.admit("a");
    gate.release("a");
    expect(gate.open()).toBe(1);
    expect(gate.admit("a")).toBe("ok");
    gate.release("zzz");
    expect(gate.open()).toBe(2);
  });

  it("limits how fast one address may connect, whatever it holds open", () => {
    const { c, gate } = make({ maxPerKey: 100, maxTotal: 100 });
    for (let i = 0; i < 6; i++) {
      expect(gate.admit("a")).toBe("ok");
      gate.release("a");
    }
    expect(gate.admit("a")).toBe("rate");
    expect(gate.admit("b")).toBe("ok");
    c.advance(10_000);
    expect(gate.admit("a")).toBe("ok");
  });
});

describe("flood guard", () => {
  it("lets a burst through, drops the excess, and cuts a connection that keeps pushing", () => {
    const c = clock();
    const guard = createFloodGuard({ perSecond: 10, burst: 5, abuseAfter: 3, now: c.now });
    expect(Array.from({ length: 5 }, () => guard.check())).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect([guard.check(), guard.check(), guard.check(), guard.check()]).toEqual([
      "drop",
      "drop",
      "drop",
      "abuse",
    ]);
  });

  it("starts counting again after a quiet window", () => {
    const c = clock();
    const guard = createFloodGuard({ perSecond: 1, burst: 1, abuseAfter: 2, now: c.now });
    guard.check();
    expect([guard.check(), guard.check(), guard.check()]).toEqual(["drop", "drop", "abuse"]);
    c.advance(6000);
    expect(guard.check()).toBe("ok");
    expect(guard.check()).toBe("drop");
  });
});
