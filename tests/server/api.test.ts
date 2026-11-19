/**
 * `/api/v1` on a real port: raw HTTP requests (so a test chooses the Origin and the body exactly)
 * against the real server with an in-memory SQLite database and a clock that stands still.
 */
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { playerIdFromKey, sha256Hex } from "@tetrizz/protocol";
import { createServerApp, type ServerApp } from "../../apps/server/src/app";
import { loadConfig, type ServerConfig } from "../../apps/server/src/config";
import { openRepository, type Repository } from "../../apps/server/src/db";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Every player in these tests is a secret key and the id derived from it, as the page makes them. */
const KEYS = new Map<string, string>();
function person(seed: string): string {
  const key = sha256Hex(`api-test:${seed}`);
  const id = playerIdFromKey(key);
  KEYS.set(id, key);
  return id;
}
const A = person("a");
const B = person("b");

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: Record<string, unknown>;
}

function call(
  port: number,
  method: string,
  path: string,
  options: {
    body?: unknown;
    type?: string;
    origin?: string | null;
    raw?: string;
    /** Sent as `Authorization: Bearer`; defaults to the key of the player in the path. */
    key?: string | null;
  } = {},
): Promise<Reply> {
  const origin = options.origin === undefined ? `http://127.0.0.1:${port}` : options.origin;
  const owner = /\/api\/v1\/players\/([^/]+)/.exec(path)?.[1];
  const key = options.key === undefined ? (owner ? KEYS.get(owner) : undefined) : options.key;
  const payload =
    options.raw !== undefined
      ? options.raw
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(origin === null ? {} : { origin }),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(payload !== undefined
            ? {
                "content-type": options.type ?? "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
          "user-agent":
            "Mozilla/5.0 (Linux; Android 8.0.0; SM-G955F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const apps: ServerApp[] = [];
const repos: Repository[] = [];
let clockNow = NOW;

async function start(
  over: Partial<ServerConfig> = {},
  wrap?: (repo: Repository) => Repository,
  errors: Array<[string, unknown]> = [],
): Promise<{ app: ServerApp; port: number; repo: Repository }> {
  clockNow = NOW;
  const repo = await openRepository({ driver: "sqlite", path: ":memory:", now: () => clockNow });
  repos.push(repo);
  const config: ServerConfig = {
    ...loadConfig({ LOG_LEVEL: "silent", PORT: "0" }).config,
    statsLogMs: 0,
    heartbeatMs: 60_000,
    ...over,
  };
  const app = await createServerApp(config, {
    repository: wrap ? wrap(repo) : repo,
    clock: () => clockNow,
    onDbError: (scope, error) => errors.push([scope, error]),
  });
  apps.push(app);
  return { app, port: await app.listen(), repo };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.shutdown().catch(() => {});
  for (const repo of repos.splice(0)) await repo.close().catch(() => {});
});

const batch = (extra: Record<string, unknown> = {}) => {
  const playerId = (extra.playerId as string | undefined) ?? A;
  return { v: 1, playerId, key: KEYS.get(playerId), sentAt: NOW, ...extra };
};
const ev = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `evt-${String(n).padStart(8, "0")}`,
  kind: "game_start",
  at: NOW - 1000,
  ...extra,
});
const game = (extra: Record<string, unknown> = {}) => ({
  id: "game-00000001",
  mode: "sprint",
  startedAt: NOW - 60_000,
  durationMs: 45_000,
  players: [{ playerId: A, result: "finished", lines: 40, score: 12_000, pieces: 100 }],
  ...extra,
});

describe("telemetry upload", () => {
  it("stores events, a game, history, the session and the device", async () => {
    const { port, repo, app } = await start();
    const res = await call(port, "POST", "/api/v1/telemetry", {
      body: batch({
        device: { deviceClass: "mobile", cores: 8, osVersion: "8.0.0" },
        session: { id: "sess-0001", startedAt: NOW - 120_000, appVersion: "1.2.0" },
        events: [ev(1, { payload: { mode: "sprint" } }), ev(2, { kind: "js_error" })],
        games: [game()],
        history: [{ id: "hist-0001", kind: "personal_best", value: 12_000, at: NOW - 30_000 }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ok: true,
      stored: { events: 2, games: 1, history: 1 },
      duplicates: { events: 0, games: 0, history: 0 },
      rejected: 0,
      stale: 0,
    });
    expect(res.headers["cache-control"]).toBe("no-store");

    expect((await repo.getPlayer(A))?.lastSeen).toBe(NOW);
    const events = await repo.listEvents(A, 10);
    expect(events.map((e) => e.kind).sort()).toEqual(["game_start", "js_error"]);
    expect(events[0]?.sessionId).toBe("sess-0001");
    expect(events.every((e) => e.receivedAt === NOW && !e.offline)).toBe(true);
    expect((await repo.getGame("game-00000001"))?.players[0]).toMatchObject({
      playerId: A,
      lines: 40,
    });
    expect((await repo.getSession("sess-0001"))?.appVersion).toBe("1.2.0");
    expect(await repo.listHistory(A, 10)).toHaveLength(1);
    const devices = await repo.listDevices(A);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.device).toMatchObject({
      deviceClass: "mobile",
      os: "Android",
      osVersion: "8.0.0",
      browser: "Chrome",
      browserVersion: "126",
      cores: 8,
    });

    const stats = app.apiStats();
    expect(stats?.telemetry).toMatchObject({ batches: 1, eventsStored: 2, gamesStored: 1 });
  });

  it("changes nothing when the same batch arrives again", async () => {
    const { port, repo, app } = await start();
    const body = batch({ events: [ev(1), ev(2)], games: [game()] });
    await call(port, "POST", "/api/v1/telemetry", { body });
    const again = await call(port, "POST", "/api/v1/telemetry", { body });
    expect(again.json).toMatchObject({
      stored: { events: 0, games: 0, history: 0 },
      duplicates: { events: 2, games: 1, history: 0 },
    });
    expect(await repo.counts()).toMatchObject({ events: 2, games: 1, players: 1 });
    expect(app.apiStats()?.telemetry).toMatchObject({ eventsDuplicate: 2, gamesDuplicate: 1 });
  });

  it("puts events on the server's clock when the page's clock is wrong", async () => {
    const { port, repo } = await start();
    const sentAt = NOW - 2 * HOUR; // the phone thinks it is two hours earlier than it is
    await call(port, "POST", "/api/v1/telemetry", {
      body: batch({ sentAt, events: [ev(1, { at: sentAt - 600_000 })] }),
    });
    const [stored] = await repo.listEvents(A, 1);
    expect(stored?.occurredAt).toBe(NOW - 600_000);
  });

  it("marks events that waited offline and drops events older than the retention", async () => {
    const { port, repo } = await start({
      retention: { eventsDays: 30, gamesDays: 180, sessionsDays: 180 },
    });
    const res = await call(port, "POST", "/api/v1/telemetry", {
      body: batch({
        events: [
          ev(1, { at: NOW - 2 * HOUR }),
          ev(2, { at: NOW - 10_000 }),
          ev(3, { at: NOW - 40 * DAY }),
          ev(4, { at: NOW - 20_000, offline: true }),
        ],
      }),
    });
    expect(res.json).toMatchObject({ stored: { events: 3 }, stale: 1 });
    const byId = new Map((await repo.listEvents(A, 10)).map((e) => [e.id, e]));
    expect(byId.get("evt-00000001")?.offline).toBe(true);
    expect(byId.get("evt-00000002")?.offline).toBe(false);
    expect(byId.get("evt-00000004")?.offline).toBe(true);
    expect(byId.has("evt-00000003")).toBe(false);
  });

  it("stores only the sender's own row of a game", async () => {
    const { port, repo } = await start();
    const res = await call(port, "POST", "/api/v1/telemetry", {
      body: batch({
        games: [
          game({
            players: [
              { playerId: A, result: "win", lines: 10, score: 100, pieces: 30 },
              { playerId: B, result: "loss", lines: 99, score: 999_999, pieces: 300 },
            ],
          }),
          game({
            id: "game-00000002",
            players: [{ playerId: B, result: "win", lines: 5, score: 5, pieces: 5 }],
          }),
        ],
      }),
    });
    expect(res.json).toMatchObject({ stored: { games: 1 }, rejected: 2 });
    expect((await repo.getGame("game-00000001"))?.players.map((p) => p.playerId)).toEqual([A]);
    expect(await repo.getGame("game-00000002")).toBeNull();
    expect(await repo.getPlayer(B)).toBeNull();
  });

  it("accepts a plain-text body, which is what sendBeacon sends without a preflight", async () => {
    const { port, repo } = await start();
    const res = await call(port, "POST", "/api/v1/telemetry", {
      raw: JSON.stringify(batch({ events: [ev(1)] })),
      type: "text/plain;charset=UTF-8",
    });
    expect(res.status).toBe(200);
    expect(await repo.counts()).toMatchObject({ events: 1 });
    const broken = await call(port, "POST", "/api/v1/telemetry", {
      raw: "{not json",
      type: "text/plain",
    });
    expect(broken.status).toBe(400);
  });

  it("answers bad requests with a plain error", async () => {
    const { port, app } = await start();
    const post = (o: Parameters<typeof call>[3]) => call(port, "POST", "/api/v1/telemetry", o);
    expect((await post({ body: { v: 1 } })).status).toBe(400);
    expect((await post({ raw: "{nope", type: "application/json" })).status).toBe(400);
    expect((await post({ raw: "x", type: "application/xml" })).status).toBe(415);
    const huge = await post({ raw: JSON.stringify({ pad: "x".repeat(300_000) }) });
    expect(huge.status).toBe(413);
    expect(huge.json).toEqual({ ok: false, error: "too-large" });
    expect((await call(port, "GET", "/api/v1/telemetry")).status).toBe(404);
    expect((await call(port, "POST", "/api/v1/nothing", { body: {} })).json.error).toBe(
      "not-found",
    );
    expect(app.apiStats()?.invalid).toBeGreaterThanOrEqual(4);
  });
});

describe("opt-out and deletion", () => {
  it("stores nothing for a player who opted out, and starts again when they opt in", async () => {
    const { port, repo, app } = await start();
    await call(port, "POST", "/api/v1/telemetry", { body: batch({ events: [ev(1)] }) });
    clockNow = NOW + HOUR;

    const off = await call(port, "PUT", `/api/v1/players/${A}/telemetry`, {
      body: { optOut: true },
    });
    expect(off.json).toEqual({ ok: true, optOut: true });

    const sent = await call(port, "POST", "/api/v1/telemetry", {
      body: batch({ sentAt: clockNow, events: [ev(2, { at: clockNow - 1000 })], games: [game()] }),
    });
    expect(sent.json).toMatchObject({
      optedOut: true,
      stored: { events: 0, games: 0, history: 0 },
    });
    expect(await repo.counts()).toMatchObject({ events: 1, games: 0 });
    // An opted-out player is not followed: the last-seen time stays where the opt-out put it.
    expect((await repo.getPlayer(A))?.lastSeen).toBe(NOW + HOUR);
    clockNow = NOW + 2 * HOUR;
    await call(port, "POST", "/api/v1/telemetry", { body: batch({ sentAt: clockNow }) });
    expect((await repo.getPlayer(A))?.lastSeen).toBe(NOW + HOUR);

    await call(port, "PUT", `/api/v1/players/${A}/telemetry`, { body: { optOut: false } });
    const on = await call(port, "POST", "/api/v1/telemetry", {
      body: batch({ sentAt: clockNow, events: [ev(3, { at: clockNow - 1000 })] }),
    });
    expect(on.json).toMatchObject({ stored: { events: 1 } });
    expect(app.apiStats()).toMatchObject({ optOutChanges: 2, telemetry: { optedOut: 2 } });
  });

  it("checks the id and the body of an opt-out", async () => {
    const { port } = await start();
    const put = (id: string, body: unknown) =>
      call(port, "PUT", `/api/v1/players/${id}/telemetry`, { body });
    expect((await put("short", { optOut: true })).status).toBe(400);
    expect((await put(A, { optOut: "yes" })).status).toBe(400);
    expect((await put(A, {})).status).toBe(400);
  });

  it("erases a player on request and says the same whether or not they existed", async () => {
    const { port, repo, app } = await start();
    await call(port, "POST", "/api/v1/telemetry", {
      body: batch({
        events: [ev(1)],
        games: [game()],
        session: { id: "sess-0001", startedAt: NOW - 1000 },
        history: [{ id: "hist-0001", kind: "personal_best", at: NOW - 500 }],
        device: { deviceClass: "desktop" },
      }),
    });
    await call(port, "POST", "/api/v1/telemetry", {
      body: batch({ playerId: B, events: [ev(9)] }),
    });
    expect(await repo.counts()).toMatchObject({ players: 2, events: 2, games: 1, sessions: 1 });

    const gone = await call(port, "DELETE", `/api/v1/players/${A}`);
    expect(gone).toMatchObject({ status: 200, json: { ok: true } });
    expect(await repo.getPlayer(A)).toBeNull();
    expect(await repo.counts()).toMatchObject({ players: 1, events: 1, games: 0, sessions: 0 });
    expect(await repo.listDevices(A)).toEqual([]);
    expect(await repo.getPlayer(B)).not.toBeNull();

    const again = await call(port, "DELETE", `/api/v1/players/${A}`);
    expect(again.json).toEqual(gone.json);
    expect((await call(port, "DELETE", "/api/v1/players/short")).status).toBe(400);
    expect(app.apiStats()?.playersDeleted).toBe(2);
  });
});

describe("who may call, and how often", () => {
  it("refuses other sites and calls without an origin, and answers a preflight", async () => {
    const { port, app } = await start({
      origins: {
        allowed: new Set(["https://play.example"]),
        allowSameOrigin: true,
        allowFile: false,
        allowMissing: false,
      },
    });
    const body = batch();
    const evil = await call(port, "POST", "/api/v1/telemetry", {
      body,
      origin: "https://evil.example",
    });
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await call(port, "POST", "/api/v1/telemetry", { body, origin: null })).status).toBe(
      403,
    );
    expect((await call(port, "POST", "/api/v1/telemetry", { body, origin: "null" })).status).toBe(
      403,
    );

    const ok = await call(port, "POST", "/api/v1/telemetry", {
      body,
      origin: "https://play.example",
    });
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://play.example");
    expect(ok.headers.vary).toContain("Origin");

    const pre = await call(port, "OPTIONS", "/api/v1/telemetry", {
      origin: "https://play.example",
    });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(pre.headers["access-control-allow-headers"]).toBe("Content-Type, Authorization");
    const badPre = await call(port, "OPTIONS", "/api/v1/telemetry", {
      origin: "https://evil.example",
    });
    expect(badPre.status).toBe(403);
    expect(app.apiStats()?.refusedOrigin).toBe(4);
  });

  it("lets the single-file build in only when the operator allows it", async () => {
    const { port } = await start({
      origins: { allowed: new Set(), allowSameOrigin: true, allowFile: true, allowMissing: false },
    });
    const res = await call(port, "POST", "/api/v1/telemetry", { body: batch(), origin: "null" });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("null");
  });

  it("limits requests per address and tells the page when to come back", async () => {
    const { port, app } = await start({
      telemetry: { requestsPerMinute: 1, requestBurst: 3, newPlayersPerHour: 100 },
    });
    const statuses: number[] = [];
    let last: Reply | undefined;
    for (let i = 0; i < 5; i++) {
      last = await call(port, "POST", "/api/v1/telemetry", { body: batch() });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect(last?.headers["retry-after"]).toBe("30");
    expect(app.apiStats()?.rateLimited).toBe(2);
  });

  it("limits how many new ids one address brings in, but not ids it has seen", async () => {
    const { port, app } = await start({
      telemetry: { requestsPerMinute: 600, requestBurst: 50, newPlayersPerHour: 2 },
    });
    const id = (n: number) => person(`new-${n}`);
    const send = (n: number) =>
      call(port, "POST", "/api/v1/telemetry", { body: batch({ playerId: id(n) }) });
    expect((await send(1)).status).toBe(200);
    expect((await send(2)).status).toBe(200);
    const third = await send(3);
    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBe("600");
    expect((await send(1)).status).toBe(200);
    expect(app.apiStats()?.newPlayerLimited).toBe(1);
  });
});

describe("when the database fails or is missing", () => {
  it("answers 503, reports the error and keeps the server up", async () => {
    const errors: Array<[string, unknown]> = [];
    const { port, app } = await start(
      {},
      (repo) => ({
        ...repo,
        insertEvents: async () => {
          throw new Error("disk is full");
        },
      }),
      errors,
    );
    const res = await call(port, "POST", "/api/v1/telemetry", { body: batch({ events: [ev(1)] }) });
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ ok: false, error: "unavailable" });
    expect(errors.map(([scope]) => scope)).toEqual(["telemetry"]);
    expect(String(errors[0]?.[1])).toContain("disk is full");
    expect(app.apiStats()?.dbErrors).toBe(1);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect(res.text).not.toContain("disk");
  });

  it("reports the database in /readyz without failing when it is down", async () => {
    const { port } = await start();
    const ok = await (await fetch(`http://127.0.0.1:${port}/readyz`)).json();
    expect(ok).toEqual({ status: "ready", database: "ok" });
    const down = await start({}, (repo) => ({
      ...repo,
      ping: async () => {
        throw new Error("gone");
      },
    }));
    const res = await fetch(`http://127.0.0.1:${down.port}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", database: "down" });
  });

  it("has no /api/v1 and an unchanged /readyz when no database is configured", async () => {
    const app = await createServerApp({
      ...loadConfig({ LOG_LEVEL: "silent", PORT: "0" }).config,
      statsLogMs: 0,
    });
    apps.push(app);
    const port = await app.listen();
    expect(app.repository).toBeNull();
    expect(app.apiStats()).toBeNull();
    expect((await call(port, "POST", "/api/v1/telemetry", { body: batch() })).status).toBe(404);
    expect(await (await fetch(`http://127.0.0.1:${port}/readyz`)).json()).toEqual({
      status: "ready",
    });
  });

  it("opens and closes a database of its own from the settings", async () => {
    const app = await createServerApp({
      ...loadConfig({
        LOG_LEVEL: "silent",
        PORT: "0",
        DB_DRIVER: "sqlite",
        SQLITE_PATH: ":memory:",
      }).config,
      statsLogMs: 0,
    });
    apps.push(app);
    const port = await app.listen();
    expect(app.repository?.driver).toBe("sqlite");
    expect((await call(port, "POST", "/api/v1/telemetry", { body: batch() })).status).toBe(200);
    const repo = app.repository;
    await app.shutdown();
    await expect(repo?.ping()).rejects.toThrow();
  });
});

describe("the API: whose data a request may touch", () => {
  it("refuses a batch whose key is missing or does not belong to its player, and stores nothing", async () => {
    const { port, repo, app } = await start();
    const keyOfB = KEYS.get(B);
    const post = (body: unknown) => call(port, "POST", "/api/v1/telemetry", { body });

    const stolen = await post(batch({ key: keyOfB, events: [ev(1)] }));
    expect(stolen).toMatchObject({ status: 403, json: { ok: false, error: "identity" } });
    expect((await post(batch({ key: "short", events: [ev(2)] }))).status).toBe(403);
    expect((await post(batch({ key: undefined, events: [ev(3)] }))).status).toBe(400);
    expect(await repo.counts()).toMatchObject({ players: 0, events: 0, games: 0 });
    expect(app.apiStats()).toMatchObject({ identityRefused: 2, invalid: 1 });
  });

  it("lets only the holder of the key silence or erase a player", async () => {
    const { port, repo, app } = await start();
    await call(port, "POST", "/api/v1/telemetry", { body: batch({ events: [ev(1)] }) });
    const path = `/api/v1/players/${A}`;
    const strangers = [KEYS.get(B), null, "nonsense"];

    for (const key of strangers) {
      const silence = await call(port, "PUT", `${path}/telemetry`, { body: { optOut: true }, key });
      expect(silence).toMatchObject({ status: 403, json: { error: "identity" } });
      const erase = await call(port, "DELETE", path, { key });
      expect(erase).toMatchObject({ status: 403, json: { error: "identity" } });
    }
    expect(await repo.getPlayer(A)).not.toBeNull();
    const still = await call(port, "POST", "/api/v1/telemetry", {
      body: batch({ events: [ev(2)] }),
    });
    expect(still.json.optedOut).toBeFalsy();
    expect(still.json).toMatchObject({ stored: { events: 1 } });
    expect(app.apiStats()).toMatchObject({ identityRefused: 6, playersDeleted: 0 });

    expect((await call(port, "DELETE", path)).status).toBe(200);
    expect(await repo.getPlayer(A)).toBeNull();
  });

  it("never stores the key", async () => {
    const { port, repo } = await start();
    await call(port, "POST", "/api/v1/telemetry", {
      body: batch({
        events: [ev(1)],
        games: [game()],
        session: { id: "sess-0001", startedAt: NOW - 1000 },
        device: { deviceClass: "desktop" },
      }),
    });
    const stored = JSON.stringify([
      await repo.getPlayer(A),
      await repo.listEvents(A, 10),
      await repo.listDevices(A),
      await repo.getGame("game-00000001"),
      await repo.getSession("sess-0001"),
    ]);
    expect(stored).not.toContain(KEYS.get(A));
  });
});
