import { describe, expect, it } from "vitest";
import { matchGameId, telemetryBase } from "../../apps/web/src/telemetry/address";
import { createPageTelemetry, watchPage, type PageEnv } from "../../apps/web/src/telemetry/page";
import type { TelemetryClient } from "../../apps/web/src/telemetry/client";

const ORIGIN = "https://tz.example";

describe("telemetryBase: where the API is", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    ["/", ORIGIN],
    ["/tetrizz/", `${ORIGIN}/tetrizz`],
    ["https://srv.example", "https://srv.example"],
    ["https://srv.example/", "https://srv.example"],
    ["http://10.0.0.5:8080/", "http://10.0.0.5:8080"],
    ["wss://srv.example/base?x=1#y", "https://srv.example/base"],
    ["ws://srv.example:3000", "http://srv.example:3000"],
    ["ftp://srv.example", null],
    ["not a url", null],
  ])("%j gives %j", (configured, expected) => {
    expect(telemetryBase(configured, ORIGIN)).toBe(expected);
  });
});

describe("matchGameId: one id for everyone in a match", () => {
  const parts = {
    room: "ROOM42",
    stamp: 1_800_000_123_456,
    order: ["a".repeat(32), "b".repeat(32)],
  };

  it("is valid for the server's id format and the same every time", () => {
    const id = matchGameId(parts);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(matchGameId({ ...parts })).toBe(id);
  });

  it("differs for the next match of a room, another room, or another line-up", () => {
    const id = matchGameId(parts);
    expect(matchGameId({ ...parts, stamp: parts.stamp + 1 })).not.toBe(id);
    expect(matchGameId({ ...parts, room: "ROOM43" })).not.toBe(id);
    expect(matchGameId({ ...parts, order: [...parts.order].reverse() })).not.toBe(id);
    expect(matchGameId({ ...parts, order: parts.order.slice(0, 1) })).not.toBe(id);
  });

  it("copes with odd room names", () => {
    expect(matchGameId({ ...parts, room: "zażółć gęślą" })).toMatch(/^m[0-9a-f]{31}$/);
    expect(matchGameId({ ...parts, room: "zażółć" })).not.toBe(
      matchGameId({ ...parts, room: "zażółd" }),
    );
  });

  it("gives nothing when a part is missing, so the page reports under its own id", () => {
    expect(matchGameId({ ...parts, room: "" })).toBeNull();
    expect(matchGameId({ ...parts, stamp: 0 })).toBeNull();
    expect(matchGameId({ ...parts, stamp: Number.NaN })).toBeNull();
    expect(matchGameId({ ...parts, order: [] })).toBeNull();
  });
});

function env(over: Partial<PageEnv> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const warnings: string[] = [];
  const timers: Array<{ task: () => void; live: boolean; ms: number }> = [];
  const base: PageEnv = {
    identity: { id: "i".repeat(32), key: "k".repeat(64) },
    configuredServer: () => "https://srv.example",
    origin: ORIGIN,
    appVersion: "1.3.0",
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "retry-after": "7" },
        }),
      );
    }) as unknown as typeof fetch,
    storage: { get: () => null, set: () => {}, remove: () => {} },
    now: () => 1_800_000_000_000,
    randomBytes: (n) => new Uint8Array(n).fill(255),
    later(task, ms) {
      const timer = { task, live: true, ms };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    online: () => true,
    warn: (scope) => warnings.push(scope),
    device: () => Promise.resolve({ deviceClass: "desktop", displayMode: "browser" }),
    ...over,
  };
  return { env: base, calls, warnings, timers };
}

describe("createPageTelemetry: the real dependencies", () => {
  it("sends a batch with fetch (no cookies, no cache) and reads the answer and Retry-After", async () => {
    const t = env();
    const client = createPageTelemetry(t.env);
    await client.start();
    client.record("game_start", { mode: "sprint" });
    await client.flush();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toBe("https://srv.example/api/v1/telemetry");
    expect(t.calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
    });
    expect(client.status()).toMatchObject({ queued: 0, serverHasNone: false });
  });

  it("is off when no server is configured: nothing is sent", async () => {
    const t = env({ configuredServer: () => null });
    const client = createPageTelemetry(t.env);
    await client.start();
    client.record("game_start", {});
    await client.flush();
    expect(t.calls).toHaveLength(0);
    expect(client.status().available).toBe(false);
  });

  it("is off when there is no identity", async () => {
    const t = env({ identity: null });
    const client = createPageTelemetry(t.env);
    await client.start();
    client.record("game_start", {});
    await client.flush();
    expect(t.calls).toHaveLength(0);
  });

  it("gives up on a request that gets no answer and keeps the queue", async () => {
    const t = env({
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    const client = createPageTelemetry(t.env);
    await client.start();
    client.record("game_start", {});
    const flushing = client.flush();
    const timeout = t.timers.find((timer) => timer.ms === 10_000 && timer.live);
    expect(timeout).toBeDefined();
    timeout?.task();
    await flushing;
    expect(client.status().queued).toBeGreaterThan(0);
    expect(client.status().failures).toBeGreaterThan(0);
  });

  it("answers with an undefined body when the server's answer is not JSON", async () => {
    const t = env({
      fetch: (() =>
        Promise.resolve(new Response("<html>", { status: 502 }))) as unknown as typeof fetch,
    });
    const client = createPageTelemetry(t.env);
    await client.start();
    client.record("game_start", {});
    await client.flush();
    expect(client.status().failures).toBeGreaterThan(0);
  });

  it("passes the browser's beacon the string body", async () => {
    const beacons: Array<[string, string]> = [];
    const t = env({ sendBeacon: (url, data) => (beacons.push([url, data]), true) });
    const client = createPageTelemetry(t.env);
    await client.start();
    client.record("game_end", { mode: "sprint" });
    client.flushOnHide();
    expect(beacons).toHaveLength(1);
    expect(beacons[0]?.[0]).toBe("https://srv.example/api/v1/telemetry");
    expect(JSON.parse(beacons[0]?.[1] ?? "{}")).toMatchObject({ key: "k".repeat(64) });
  });

  it("keeps playing when storage throws", async () => {
    const t = env({
      storage: {
        get: () => {
          throw new Error("blocked");
        },
        set: () => {
          throw new Error("blocked");
        },
        remove: () => {
          throw new Error("blocked");
        },
      },
    });
    const client = createPageTelemetry(t.env);
    await client.start();
    client.record("game_start", {});
    await client.setEnabled(false);
    expect(t.warnings).toContain("telemetry/page.storage");
  });

  it("makes ids of the server's format from random bytes, and still some without them", async () => {
    const withBytes = env();
    const a = createPageTelemetry(withBytes.env);
    await a.start();
    a.recordGame({ mode: "sprint", startedAt: 1_799_999_000_000, durationMs: 1000, players: [] });
    const without = env({ randomBytes: () => null });
    const b = createPageTelemetry(without.env);
    await b.start();
    b.record("game_start", {});
    await b.flush();
    const body = JSON.parse(String(without.calls[0]?.init.body)) as {
      events: Array<{ id: string }>;
    };
    for (const event of body.events) expect(event.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe("watchPage", () => {
  function target() {
    const handlers = new Map<string, () => void>();
    return {
      handlers,
      addEventListener: (type: string, listener: () => void) => void handlers.set(type, listener),
    };
  }

  it("retries when back online and sends what is queued when the page is hidden or closing", () => {
    const seen: string[] = [];
    const client = {
      online: () => seen.push("online"),
      flushOnHide: () => seen.push("hide"),
    } as unknown as TelemetryClient;
    const win = target();
    const doc = { ...target(), visibilityState: "visible" };
    watchPage(client, win, doc);
    win.handlers.get("online")?.();
    win.handlers.get("pagehide")?.();
    doc.handlers.get("visibilitychange")?.();
    expect(seen).toEqual(["online", "hide"]);
    (doc as { visibilityState: string }).visibilityState = "hidden";
    doc.handlers.get("visibilitychange")?.();
    expect(seen).toEqual(["online", "hide", "hide"]);
  });
});
