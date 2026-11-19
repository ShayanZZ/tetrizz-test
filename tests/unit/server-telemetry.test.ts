import { describe, expect, it } from "vitest";
import {
  isPlayerId,
  parseTelemetryBatch,
  TELEMETRY_MAX_EVENTS,
  TELEMETRY_MAX_PAYLOAD_BYTES,
} from "@tetrizz/protocol";
import { loadConfig } from "../../apps/server/src/config";
import {
  clockSkew,
  correctTime,
  deviceFromUserAgent,
  mergeDevice,
} from "../../apps/server/src/telemetry";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const PID = "11111111-2222-4333-8444-555555555555";
const KEY = "0123456789abcdef".repeat(4);

const valid = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  playerId: PID,
  key: KEY,
  sentAt: NOW,
  ...extra,
});
const event = (n: number, extra: Record<string, unknown> = {}) => ({
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
  players: [{ playerId: PID, result: "finished", lines: 40, score: 12_000, pieces: 100 }],
  ...extra,
});

describe("telemetry batch format", () => {
  it("hands the key over separately from the batch, and refuses a batch without one", () => {
    const parsed = parseTelemetryBatch(valid());
    expect(parsed.ok && parsed.value.key).toBe(KEY);
    expect(parsed.ok && JSON.stringify(parsed.value.batch)).not.toContain(KEY);
    for (const key of [undefined, 7, "k".repeat(129)]) {
      expect(parseTelemetryBatch(valid({ key })).ok).toBe(false);
    }
  });

  it("reads a minimal batch", () => {
    const parsed = parseTelemetryBatch(valid());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.rejected).toBe(0);
    expect(parsed.value.batch).toMatchObject({ playerId: PID, events: [], games: [], history: [] });
  });

  it("refuses a request that is not shaped right", () => {
    for (const body of [
      null,
      "text",
      [],
      {},
      valid({ v: undefined }),
      valid({ v: 2 }),
      valid({ playerId: "short" }),
      valid({ playerId: "has spaces in it!" }),
      valid({ sentAt: 5 }),
      valid({ sentAt: "now" }),
      valid({ events: "no" }),
      valid({ games: {} }),
    ]) {
      expect(parseTelemetryBatch(body).ok).toBe(false);
    }
  });

  it("refuses a list that is too long and leaves single bad items out", () => {
    const tooMany = Array.from({ length: TELEMETRY_MAX_EVENTS + 1 }, (_, i) => event(i));
    expect(parseTelemetryBatch(valid({ events: tooMany })).ok).toBe(false);

    const mixed = parseTelemetryBatch(
      valid({
        events: [event(1), { id: "x", kind: "Bad Kind", at: NOW }, event(2), 7, null],
        games: [game(), game({ mode: "NOT OK" })],
        history: [{ id: "hist-0001", kind: "personal_best", at: NOW, value: "high" }],
      }),
    );
    expect(mixed.ok).toBe(true);
    if (!mixed.ok) return;
    expect(mixed.value.batch.events.map((e) => e.id)).toEqual(["evt-00000001", "evt-00000002"]);
    expect(mixed.value.batch.games).toHaveLength(1);
    expect(mixed.value.batch.history).toHaveLength(0);
    expect(mixed.value.rejected).toBe(3 + 1 + 1);
  });

  it("limits the size of an event payload and ignores unknown fields", () => {
    const big = { text: "x".repeat(TELEMETRY_MAX_PAYLOAD_BYTES) };
    const parsed = parseTelemetryBatch(
      valid({
        events: [event(1, { payload: big }), event(2, { payload: { ok: 1 }, extra: "dropped" })],
        surprise: true,
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.batch.events).toHaveLength(1);
    expect(parsed.value.batch.events[0]).toEqual({
      id: "evt-00000002",
      kind: "game_start",
      at: NOW - 1000,
      payload: { ok: 1 },
    });
    expect(parsed.value.rejected).toBe(1);
  });

  it("keeps the valid fields of a device and drops the rest", () => {
    const parsed = parseTelemetryBatch(
      valid({
        device: {
          deviceClass: "mobile",
          os: "Android",
          osVersion: "8.0.0",
          screen: "360x800",
          dpr: 4,
          cores: 8,
          language: "pt-BR",
          displayMode: "pwa",
          model: "Not allowed: \u0000 control",
          memoryGb: -1,
          engine: 42,
        },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.batch.device).toEqual({
      deviceClass: "mobile",
      os: "Android",
      osVersion: "8.0.0",
      screen: "360x800",
      dpr: 4,
      cores: 8,
      language: "pt-BR",
      displayMode: "pwa",
    });
  });

  it("checks sessions: an end before the start is ignored, a broken one is counted", () => {
    const ended = parseTelemetryBatch(
      valid({ session: { id: "sess-0001", startedAt: NOW - 1000, endedAt: NOW - 5000 } }),
    );
    expect(ended.ok && ended.value.batch.session).toEqual({
      id: "sess-0001",
      startedAt: NOW - 1000,
    });
    const broken = parseTelemetryBatch(valid({ session: { id: "s" } }));
    expect(broken.ok && broken.value.batch.session).toBeUndefined();
    expect(broken.ok && broken.value.rejected).toBe(1);
  });

  it("checks games: numbers in range, at least one player", () => {
    const bad = [
      game({ durationMs: -1 }),
      game({ durationMs: DAY + 1 }),
      game({ players: [] }),
      game({ players: [{ playerId: PID, result: "cheated", lines: 1, score: 1, pieces: 1 }] }),
      game({ players: [{ playerId: PID, result: "win", lines: 1e9, score: 1, pieces: 1 }] }),
    ];
    const parsed = parseTelemetryBatch(valid({ games: [...bad, game({ bots: 3, botLevel: 10 })] }));
    expect(parsed.ok && parsed.value.batch.games).toHaveLength(1);
    expect(parsed.ok && parsed.value.rejected).toBe(5);
  });

  it("recognises player ids", () => {
    expect(isPlayerId(PID)).toBe(true);
    expect(isPlayerId("../etc/passwd")).toBe(false);
    expect(isPlayerId("a".repeat(65))).toBe(false);
    expect(isPlayerId(5)).toBe(false);
  });
});

describe("clock correction", () => {
  it("moves a time by how far the page's clock is off", () => {
    const sentAt = NOW - 2 * HOUR; // the page's clock is two hours behind
    expect(clockSkew(sentAt, NOW)).toBe(2 * HOUR);
    expect(correctTime(sentAt - 600_000, clockSkew(sentAt, NOW), NOW, DAY)).toBe(NOW - 600_000);
  });

  it("handles a page whose clock runs ahead", () => {
    const sentAt = NOW + 3 * HOUR;
    expect(correctTime(sentAt - 5000, clockSkew(sentAt, NOW), NOW, DAY)).toBe(NOW - 5000);
  });

  it("never puts a time in the future and drops what is older than the limit", () => {
    expect(correctTime(NOW + 5000, 0, NOW, DAY)).toBe(NOW);
    expect(correctTime(NOW - DAY - 1, 0, NOW, DAY)).toBeNull();
    expect(correctTime(NOW - DAY, 0, NOW, DAY)).toBe(NOW - DAY);
  });

  it("lands a retry where the first try landed, give or take the delay", () => {
    const at = NOW - 30_000;
    const first = correctTime(at, clockSkew(NOW, NOW + 40), NOW + 40, DAY);
    // The retry is sent 90 s later by the page's clock and arrives 90.05 s later by the server's.
    const retry = correctTime(at, clockSkew(NOW + 90_000, NOW + 90_050), NOW + 90_050, DAY);
    expect(Math.abs((first ?? 0) - (retry ?? 0))).toBeLessThan(100);
  });
});

describe("device description", () => {
  const S8 =
    "Mozilla/5.0 (Linux; Android 8.0.0; SM-G955F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36";

  it("reads a phone", () => {
    expect(deviceFromUserAgent(S8)).toEqual({
      deviceClass: "mobile",
      os: "Android",
      osVersion: "8.0",
      browser: "Chrome",
      browserVersion: "126",
      engine: "Blink",
    });
  });

  it("reads a desktop browser and gives up on nonsense", () => {
    const desktop = deviceFromUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    );
    expect(desktop?.deviceClass).toBe("desktop");
    expect(desktop?.os).toBe("Windows");
    expect(deviceFromUserAgent(undefined)).toBeNull();
    expect(deviceFromUserAgent("x".repeat(600))).toBeNull();
    expect(deviceFromUserAgent("curl/8")?.deviceClass).toBe("unknown");
  });

  it("lets the page's own description win", () => {
    const merged = mergeDevice(deviceFromUserAgent(S8), { osVersion: "8.1.0", cores: 8 });
    expect(merged).toMatchObject({
      os: "Android",
      osVersion: "8.1.0",
      cores: 8,
      browser: "Chrome",
    });
    expect(mergeDevice(null, undefined)).toBeNull();
    expect(mergeDevice(null, { cores: 4 })).toEqual({ deviceClass: "unknown", cores: 4 });
  });
});

describe("database and retention settings", () => {
  it("keeps no database unless asked", () => {
    const { config, problems } = loadConfig({});
    expect(problems).toEqual([]);
    expect(config.database).toEqual({ driver: "off" });
    expect(config.retention).toEqual({ eventsDays: 30, gamesDays: 180, sessionsDays: 180 });
    expect(config.dbMaxMb).toBe(0);
    expect(config.telemetry).toMatchObject({ requestsPerMinute: 30, newPlayersPerHour: 60 });
  });

  it("reads SQLite and PostgreSQL", () => {
    expect(loadConfig({ DB_DRIVER: "sqlite" }).config.database).toEqual({
      driver: "sqlite",
      path: "./data/sqlite/tetrizz.db",
    });
    expect(loadConfig({ DB_DRIVER: "SQLITE", SQLITE_PATH: "/data/t.db" }).config.database).toEqual({
      driver: "sqlite",
      path: "/data/t.db",
    });
    const pg = loadConfig({
      DB_DRIVER: "postgres",
      DATABASE_URL: "postgresql://u:p@db:5432/tz",
      DB_SCHEMA: "tetrizz",
      DB_POOL_MAX: "9",
    });
    expect(pg.problems).toEqual([]);
    expect(pg.config.database).toEqual({
      driver: "postgres",
      url: "postgresql://u:p@db:5432/tz",
      schema: "tetrizz",
      poolMax: 9,
    });
  });

  it("lists what is wrong and never repeats a database address", () => {
    const missing = loadConfig({ DB_DRIVER: "postgres" });
    expect(missing.problems.join("\n")).toContain("DATABASE_URL");
    const bad = loadConfig({
      DB_DRIVER: "postgres",
      DATABASE_URL: "mysql://user:secret@host/db",
      DB_SCHEMA: 'x"; DROP',
      RETENTION_EVENTS_DAYS: "0",
      DB_MAX_MB: "-5",
    });
    expect(bad.problems).toHaveLength(4);
    expect(bad.problems.join("\n")).not.toContain("secret");
    expect(loadConfig({ DB_DRIVER: "mongo" }).problems[0]).toContain("DB_DRIVER");
  });
});
