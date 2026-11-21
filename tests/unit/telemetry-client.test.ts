import { describe, expect, it } from "vitest";
import { playerIdFromKey, TELEMETRY_MAX_EVENTS, type TelemetryBatch } from "@tetrizz/protocol";
import {
  createTelemetryClient,
  TELEMETRY_ENABLED_KEY,
  TELEMETRY_TODO_KEY,
  type HttpRequest,
  type HttpResponse,
  type TelemetryDeps,
} from "../../apps/web/src/telemetry/client";
import { createMemoryStore } from "../../apps/web/src/telemetry/queue";

const KEY = "k".repeat(64);
const ID = playerIdFromKey(KEY);
const ACK = {
  v: 1,
  ok: true,
  stored: { events: 0, games: 0, history: 0 },
  duplicates: { events: 0, games: 0, history: 0 },
  rejected: 0,
  stale: 0,
};
const ok = (extra: Record<string, unknown> = {}): HttpResponse => ({
  status: 200,
  body: { ...ACK, ...extra },
});

type Reply = HttpResponse | Error | ((request: HttpRequest) => HttpResponse | Error);

function setup(options: { base?: string | null; online?: boolean; replies?: Reply[] } = {}) {
  const requests: HttpRequest[] = [];
  const beacons: Array<{ url: string; body: string }> = [];
  const warnings: string[] = [];
  const kv = new Map<string, string>();
  const timers: Array<{ at: number; task: () => void; live: boolean }> = [];
  const replies = [...(options.replies ?? [])];
  const state = { now: 1_800_000_000_000, online: options.online ?? true, ids: 0 };

  const deps: TelemetryDeps = {
    identity: { id: ID, key: KEY },
    base: () => (options.base === undefined ? "https://tz.example" : options.base),
    store: createMemoryStore(),
    kv: {
      get: (key) => kv.get(key) ?? null,
      set: (key, value) => void kv.set(key, value),
      remove: (key) => void kv.delete(key),
    },
    http(request) {
      requests.push(request);
      const next = replies.shift() ?? ok();
      const reply = typeof next === "function" ? next(request) : next;
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
    beacon(url, body) {
      beacons.push({ url, body });
      return true;
    },
    now: () => state.now,
    random: () => 0.5,
    newId: () => `id-${String(++state.ids).padStart(6, "0")}`,
    later(task, ms) {
      const timer = { at: state.now + ms, task, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    online: () => state.online,
    warn: (scope) => warnings.push(scope),
    appVersion: "1.3.0",
    device: () => Promise.resolve({ deviceClass: "mobile", displayMode: "pwa" }),
  };
  const client = createTelemetryClient(deps);

  /** Moves the clock and runs every timer that has come due, with what they start. */
  const advance = async (ms: number) => {
    state.now += ms;
    for (const timer of timers.splice(0)) {
      if (timer.live && timer.at <= state.now) {
        timer.live = false;
        timer.task();
      } else if (timer.live) timers.push(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const posts = () => requests.filter((r) => r.method === "POST");
  const batch = (i: number) =>
    JSON.parse(posts()[i]?.body ?? "null") as TelemetryBatch & { key: string };
  return { client, deps, requests, beacons, warnings, kv, state, advance, posts, batch };
}

describe("telemetry client: noting and sending", () => {
  it("sends a first batch with the session, device, app_start and the key in the body only", async () => {
    const t = setup();
    await t.client.start();
    t.client.record("game_start", { mode: "sprint" });
    await t.advance(5_000);
    expect(t.posts()).toHaveLength(1);
    const first = t.batch(0);
    expect(first.playerId).toBe(ID);
    expect(first.key).toBe(KEY);
    expect(first.v).toBe(1);
    expect(first.device).toEqual({ deviceClass: "mobile", displayMode: "pwa" });
    expect(first.session).toMatchObject({
      appVersion: "1.3.0",
      displayMode: "pwa",
      deviceClass: "mobile",
    });
    expect(first.events.map((e) => e.kind)).toEqual(["app_start", "game_start"]);
    expect(first.events[1]?.payload).toEqual({ mode: "sprint" });
    expect(first.events.every((e) => e.sessionId === first.session?.id)).toBe(true);
    expect(t.posts()[0]?.url).toBe("https://tz.example/api/v1/telemetry");
    expect(t.posts()[0]?.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(t.requests.map((r) => r.url))).not.toContain(KEY);
    expect(t.client.status().queued).toBe(0);
  });

  it("sends the device only until the server has had it", async () => {
    const t = setup();
    await t.client.start();
    await t.advance(5_000);
    t.client.record("game_start");
    await t.advance(25_000);
    expect(t.posts()).toHaveLength(2);
    expect(t.batch(0).device).toBeDefined();
    expect(t.batch(1).device).toBeUndefined();
  });

  it("sends games and history and fills in the session, version and device class", async () => {
    const t = setup();
    await t.client.start();
    t.client.recordGame({
      mode: "sprint",
      startedAt: t.state.now - 40_000,
      durationMs: 40_000,
      players: [{ playerId: ID, result: "finished", lines: 40, score: 4000, pieces: 100 }],
    });
    t.client.recordHistory("personal_best", 40_000, { mode: "sprint" });
    await t.advance(25_000);
    const sent = t.batch(0);
    expect(sent.games[0]).toMatchObject({
      mode: "sprint",
      appVersion: "1.3.0",
      deviceClass: "mobile",
    });
    expect(sent.games[0]?.sessionId).toBe(sent.session?.id);
    expect(sent.history[0]).toMatchObject({ kind: "personal_best", value: 40_000 });
  });

  it("marks what was noted while offline, keeps it, and sends it when the connection is back", async () => {
    const t = setup({ online: false });
    await t.client.start();
    t.client.record("game_start");
    await t.advance(60_000);
    expect(t.requests).toHaveLength(0);
    expect(t.client.status().queued).toBe(2);
    t.state.online = true;
    t.client.online();
    await t.advance(2_000);
    expect(t.posts()).toHaveLength(1);
    expect(t.batch(0).events.every((e) => e.offline === true)).toBe(true);
    expect(t.batch(0).session?.offline).toBe(true);
    expect(t.client.status().queued).toBe(0);
  });

  it("does nothing without a server address, an identity or after switching off", async () => {
    const none = setup({ base: null });
    await none.client.start();
    none.client.record("game_start");
    await none.advance(60_000);
    expect(none.requests).toHaveLength(0);
    expect(none.client.status()).toMatchObject({ available: false, queued: 0 });

    const noId = createTelemetryClient({ ...setup().deps, identity: null });
    await noId.start();
    noId.record("game_start");
    expect(noId.status().queued).toBe(0);
  });

  it("refuses odd event names and drops payloads that are too large, keeping the event", async () => {
    const t = setup();
    await t.client.start();
    t.client.record("Not Valid");
    t.client.record("big_one", { pad: "x".repeat(3000) });
    await t.advance(25_000);
    const events = t.batch(0).events;
    expect(events.map((e) => e.kind)).toEqual(["app_start", "big_one"]);
    expect(events[1]?.payload).toBeUndefined();
  });

  it("sends in batches within the server's limits", async () => {
    const t = setup();
    await t.client.start();
    for (let i = 0; i < 450; i++) t.client.record("game_start");
    await t.advance(5_000);
    await t.advance(1_100);
    await t.advance(1_100);
    expect(t.posts().length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < t.posts().length; i++) {
      expect(t.batch(i).events.length).toBeLessThanOrEqual(TELEMETRY_MAX_EVENTS);
    }
    expect(t.client.status().queued).toBe(0);
  });
});

describe("telemetry client: when the server does not take a batch", () => {
  it("keeps the items and tries again later after a lost connection, with growing waits", async () => {
    const t = setup({ replies: [new Error("offline"), new Error("offline")] });
    await t.client.start();
    await t.advance(5_000);
    expect(t.posts()).toHaveLength(1);
    expect(t.client.status().queued).toBe(1);
    await t.advance(10_000);
    expect(t.posts()).toHaveLength(1);
    await t.advance(60_000);
    expect(t.posts()).toHaveLength(2);
    expect(t.batch(1).events[0]?.id).toBe(t.batch(0).events[0]?.id);
    await t.advance(40_000);
    expect(t.posts()).toHaveLength(2);
    await t.advance(60_000);
    expect(t.posts()).toHaveLength(3);
    expect(t.client.status()).toMatchObject({ queued: 0, failures: 0 });
  });

  it("waits as long as the server asks when it says too many requests", async () => {
    const t = setup({ replies: [{ status: 429, body: { ok: false }, retryAfterSeconds: 600 }] });
    await t.client.start();
    await t.advance(5_000);
    await t.advance(300_000);
    expect(t.posts()).toHaveLength(1);
    await t.advance(310_000);
    expect(t.posts()).toHaveLength(2);
  });

  it("retries after a server error", async () => {
    const t = setup({ replies: [{ status: 503, body: { ok: false } }] });
    await t.client.start();
    await t.advance(5_000);
    expect(t.client.status().queued).toBe(1);
    await t.advance(60_000);
    expect(t.client.status().queued).toBe(0);
  });

  it("halves a batch the server calls invalid and drops a single bad item", async () => {
    const replies: Reply[] = [
      { status: 400, body: { ok: false } },
      { status: 400, body: { ok: false } },
      { status: 400, body: { ok: false } },
    ];
    const t = setup({ replies });
    await t.client.start();
    t.client.record("a_b");
    t.client.record("c_d");
    t.client.record("e_f");
    await t.advance(5_000);
    expect(t.posts().length).toBeGreaterThanOrEqual(4);
    expect(t.batch(0).events).toHaveLength(4);
    expect(t.batch(1).events).toHaveLength(2);
    expect(t.batch(2).events).toHaveLength(1);
    expect(t.client.status().queued).toBeLessThan(4);
  });

  it("stops and forgets when the server refuses the key", async () => {
    const t = setup({ replies: [{ status: 403, body: { ok: false, error: "identity" } }] });
    await t.client.start();
    await t.advance(5_000);
    expect(t.client.status()).toMatchObject({ refused: true, queued: 0 });
    t.client.record("game_start");
    await t.advance(60_000);
    expect(t.posts()).toHaveLength(1);
    expect(t.warnings).toContain("telemetry/client.identity");
  });

  it("stops and forgets when the server has no telemetry", async () => {
    const t = setup({ replies: [{ status: 404, body: undefined }] });
    await t.client.start();
    await t.advance(5_000);
    expect(t.client.status()).toMatchObject({ serverHasNone: true, queued: 0 });
    t.client.record("game_start");
    await t.advance(60_000);
    expect(t.posts()).toHaveLength(1);
    expect(t.client.status().queued).toBe(0);
  });

  it("follows the server when it says the player opted out elsewhere", async () => {
    const t = setup({ replies: [ok({ optedOut: true })] });
    await t.client.start();
    await t.advance(5_000);
    expect(t.kv.get(TELEMETRY_ENABLED_KEY)).toBe("off");
    t.client.record("game_start");
    expect(t.client.status().queued).toBe(0);
  });
});

describe("telemetry client: the player's choices", () => {
  it("switching off clears the queue, notes nothing more and tells the server with the key", async () => {
    const t = setup();
    await t.client.start();
    t.client.record("game_start");
    await t.client.setEnabled(false);
    expect(t.client.status()).toMatchObject({ enabled: false, queued: 0, pendingSync: false });
    const put = t.requests.find((r) => r.method === "PUT");
    expect(put?.url).toBe(`https://tz.example/api/v1/players/${ID}/telemetry`);
    expect(put?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(put?.body ?? "")).toEqual({ optOut: true });
    t.client.record("game_start");
    t.client.recordGame({
      mode: "sprint",
      startedAt: 1_800_000_000_000,
      durationMs: 1,
      players: [],
    });
    await t.advance(60_000);
    expect(t.posts()).toHaveLength(0);
    expect(t.client.status().queued).toBe(0);
  });

  it("remembers a choice made offline and tells the server when it can", async () => {
    const t = setup({ replies: [new Error("offline")] });
    await t.client.start();
    await t.client.setEnabled(false);
    expect(t.client.status().pendingSync).toBe(true);
    expect(JSON.parse(t.kv.get(TELEMETRY_TODO_KEY) ?? "{}")).toEqual({ optOut: true });
    await t.advance(60_000);
    t.client.online();
    await t.advance(60_000);
    expect(t.client.status().pendingSync).toBe(false);
    expect(t.requests.filter((r) => r.method === "PUT").length).toBeGreaterThanOrEqual(2);
  });

  it("a choice made in an earlier page load is told to the server at the next start", async () => {
    const t = setup();
    t.kv.set(TELEMETRY_ENABLED_KEY, "off");
    t.kv.set(TELEMETRY_TODO_KEY, JSON.stringify({ optOut: true }));
    await t.client.start();
    await t.advance(5_000);
    expect(t.requests.map((r) => r.method)).toEqual(["PUT"]);
    expect(t.client.status().pendingSync).toBe(false);
  });

  it("switching on again tells the server and sends what is noted from then on", async () => {
    const t = setup();
    await t.client.start();
    await t.client.setEnabled(false);
    await t.client.setEnabled(true);
    const puts = t.requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => JSON.parse(r.body ?? ""))).toEqual([
      { optOut: true },
      { optOut: false },
    ]);
    t.client.record("game_start");
    await t.advance(25_000);
    expect(t.posts()).toHaveLength(1);
  });

  it("erasing deletes on the server with the key, and repeats the opt-out when telemetry is off", async () => {
    const t = setup();
    await t.client.start();
    await t.client.setEnabled(false);
    t.requests.length = 0;
    expect(await t.client.eraseMyData()).toBe(true);
    expect(t.requests.map((r) => r.method)).toEqual(["DELETE", "PUT"]);
    expect(t.requests[0]?.url).toBe(`https://tz.example/api/v1/players/${ID}`);
    expect(t.requests[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(t.requests[1]?.body ?? "")).toEqual({ optOut: true });
  });

  it("erasing while telemetry is on only deletes", async () => {
    const t = setup();
    await t.client.start();
    t.client.record("game_start");
    expect(await t.client.eraseMyData()).toBe(true);
    expect(t.requests.map((r) => r.method)).toEqual(["DELETE"]);
    expect(t.client.status().queued).toBe(0);
  });

  it("keeps an erase request until it reaches the server", async () => {
    const t = setup({ replies: [{ status: 503, body: undefined }] });
    await t.client.start();
    expect(await t.client.eraseMyData()).toBe(false);
    expect(t.client.status().pendingSync).toBe(true);
    await t.advance(60_000);
    t.client.online();
    await t.advance(60_000);
    expect(t.client.status().pendingSync).toBe(false);
    expect(t.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
  });
});

describe("telemetry client: leaving the page", () => {
  it("hands the queue and the session end to the browser's beacon, once", async () => {
    const t = setup({ replies: [new Error("offline")] });
    await t.client.start();
    await t.advance(5_000);
    t.client.record("game_end");
    t.client.flushOnHide();
    expect(t.beacons).toHaveLength(1);
    const sent = JSON.parse(t.beacons[0]?.body ?? "") as TelemetryBatch & { key: string };
    expect(t.beacons[0]?.url).toBe("https://tz.example/api/v1/telemetry");
    expect(sent.key).toBe(KEY);
    expect(sent.events.map((e) => e.kind)).toEqual(["app_start", "game_end"]);
    expect(sent.session?.endedAt).toBeGreaterThanOrEqual(sent.session?.startedAt ?? 0);
    t.client.flushOnHide();
    const again = JSON.parse(t.beacons[1]?.body ?? "") as TelemetryBatch;
    expect(again.events).toHaveLength(0);
    expect(t.client.status().queued).toBe(2);
  });

  it("sends nothing on hide when switched off", async () => {
    const t = setup();
    await t.client.start();
    await t.client.setEnabled(false);
    t.client.flushOnHide();
    expect(t.beacons).toHaveLength(0);
  });
});
