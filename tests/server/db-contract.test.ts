/**
 * The repository contract: the same tests run against SQLite (in memory and in a file) and, when
 * `TEST_POSTGRES_URL` is set, against a real PostgreSQL server (each test in its own schema).
 * CI sets it; to run it locally:
 *   TEST_POSTGRES_URL=postgres://user:pass@127.0.0.1:5432/dbname npx vitest run tests/server/db-contract
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { DAY_MS } from "../../apps/server/src/db/days";
import { openRepository } from "../../apps/server/src/db";
import type { GameInput, Repository } from "../../apps/server/src/db";

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const D = Date.parse("2026-11-10T00:00:00Z");
const DAY = "2026-11-10";
const PREVIOUS = "2026-11-09";
const HOUR = 3_600_000;

interface Backend {
  name: string;
  open(now: () => number): Promise<Repository>;
  cleanup(): Promise<void>;
}

function sqliteMemory(): Backend {
  return {
    name: "sqlite (memory)",
    open: (now) => openRepository({ driver: "sqlite", path: ":memory:", now }),
    cleanup: async () => undefined,
  };
}

function sqliteFile(): Backend {
  const dir = mkdtempSync(join(tmpdir(), "tetrizz-db-"));
  return {
    name: "sqlite (file)",
    open: (now) => openRepository({ driver: "sqlite", path: join(dir, "nested", "t.db"), now }),
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  };
}

function postgres(url: string): Backend {
  const schema = `t_${Math.random().toString(36).slice(2, 10)}`;
  return {
    name: "postgres",
    open: (now) => openRepository({ driver: "postgres", url, schema, now }),
    cleanup: async () => {
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

const makers: Array<[string, () => Backend]> = [
  ["sqlite (memory)", sqliteMemory],
  ["sqlite (file)", sqliteFile],
  ...(POSTGRES_URL
    ? ([["postgres", () => postgres(POSTGRES_URL)]] as Array<[string, () => Backend]>)
    : []),
];

function game(id: string, startedAt: number, extra: Partial<GameInput> = {}): GameInput {
  return {
    id,
    mode: "sprint",
    startedAt,
    durationMs: 60_000,
    players: [{ playerId: "p1", result: "finished", lines: 40, score: 1000, pieces: 100 }],
    ...extra,
  };
}

describe.each(makers)("repository on %s", (_name, make) => {
  let backend: Backend;
  let repo: Repository;
  const clock = D + 12 * HOUR;
  let opened = false;

  const start = async () => {
    backend = make();
    repo = await backend.open(() => clock);
    opened = true;
    return repo;
  };

  afterEach(async () => {
    if (!opened) return;
    opened = false;
    await repo.close();
    await backend.cleanup();
  });

  /** Players p1 to p3, three games on DAY and one the day before, errors on both days. */
  async function fixture() {
    await start();
    await repo.startSession({
      id: "s1",
      playerId: "p1",
      startedAt: D + HOUR,
      deviceClass: "mobile",
    });
    await repo.startSession({
      id: "s2",
      playerId: "p2",
      startedAt: D + 2 * HOUR,
      deviceClass: "desktop",
    });
    await repo.startSession({ id: "s3", playerId: "p3", startedAt: D - HOUR });
    await repo.recordGame(game("g1", D + HOUR, { deviceClass: "mobile", sessionId: "s1" }));
    await repo.recordGame(
      game("g2", D + 2 * HOUR, {
        mode: "versus",
        durationMs: 120_000,
        deviceClass: "desktop",
        players: [
          { playerId: "p1", seat: 0, result: "win", lines: 10, score: 500, pieces: 50 },
          { playerId: "p2", seat: 1, result: "loss", lines: 8, score: 300, pieces: 40 },
        ],
      }),
    );
    await repo.recordGame(
      game("g3", D + 3 * HOUR, {
        durationMs: 30_000,
        players: [{ playerId: "p2", result: "quit", lines: 5, score: 9000, pieces: 20 }],
      }),
    );
    await repo.recordGame(
      game("g4", D - 2 * HOUR, {
        players: [{ playerId: "p3", result: "finished", lines: 1, score: 1, pieces: 1 }],
      }),
    );
    const event = (id: string, playerId: string, kind: string, at: number) => ({
      id,
      playerId,
      kind,
      occurredAt: at,
      receivedAt: at + 1000,
    });
    await repo.insertEvents([
      event("e1", "p1", "js_error", D + 5 * HOUR),
      event("e2", "p2", "js_error", D + 6 * HOUR),
      event("e3", "p2", "app_start", D + 6 * HOUR),
      event("e4", "p3", "js_error", D - HOUR),
    ]);
  }

  it("applies the schema and reports its version", async () => {
    await start();
    expect(await repo.schemaVersion()).toBe(1);
    await repo.ping();
    expect(repo.driver).toBe(_name.startsWith("sqlite") ? "sqlite" : "postgres");
  });

  it("reopening a database applies nothing and keeps the data", async () => {
    await start();
    await repo.touchPlayer("p1", 5);
    if (_name === "sqlite (memory)") return;
    await repo.close();
    repo = await backend.open(() => clock);
    expect(await repo.schemaVersion()).toBe(1);
    expect((await repo.getPlayer("p1"))?.firstSeen).toBe(5);
  });

  it("touchPlayer moves first_seen back and last_seen forward, never the other way", async () => {
    await start();
    const first = await repo.touchPlayer("p1", 1000);
    expect(first).toEqual({
      id: "p1",
      firstSeen: 1000,
      lastSeen: 1000,
      accountId: null,
      telemetryOptOut: false,
    });
    await repo.touchPlayer("p1", 3000);
    await repo.touchPlayer("p1", 500);
    await repo.touchPlayer("p1", 2000);
    expect(await repo.getPlayer("p1")).toMatchObject({ firstSeen: 500, lastSeen: 3000 });
    expect(await repo.getPlayer("nobody")).toBeNull();
  });

  it("stores the telemetry opt-out flag", async () => {
    await start();
    await repo.touchPlayer("p1", 1);
    await repo.setTelemetryOptOut("p1", true);
    expect((await repo.getPlayer("p1"))?.telemetryOptOut).toBe(true);
    await repo.setTelemetryOptOut("p1", false);
    expect((await repo.getPlayer("p1"))?.telemetryOptOut).toBe(false);
  });

  it("keeps one row per device and tells two devices apart", async () => {
    await start();
    const phone = {
      deviceClass: "mobile",
      os: "Android",
      osVersion: "14",
      browser: "Chrome",
    } as const;
    await repo.recordDevice("p1", phone, 100);
    await repo.recordDevice("p1", { ...phone }, 300);
    await repo.recordDevice("p1", { ...phone }, 200);
    await repo.recordDevice("p1", { deviceClass: "desktop", os: "Windows" }, 400);
    const devices = await repo.listDevices("p1");
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ device: phone, firstSeen: 100, lastSeen: 300 });
    expect(devices[1]?.device).toEqual({ deviceClass: "desktop", os: "Windows" });
    expect(devices[0]?.fingerprint).not.toBe(devices[1]?.fingerprint);
  });

  it("sessions are idempotent and end once at the latest time", async () => {
    await start();
    await repo.startSession({
      id: "s1",
      playerId: "p1",
      startedAt: 10,
      appVersion: "1.5.0",
      offline: true,
    });
    await repo.startSession({ id: "s1", playerId: "p1", startedAt: 99, appVersion: "other" });
    await repo.endSession("s1", 50);
    await repo.endSession("s1", 40);
    expect(await repo.getSession("s1")).toEqual({
      id: "s1",
      playerId: "p1",
      startedAt: 10,
      endedAt: 50,
      appVersion: "1.5.0",
      displayMode: null,
      deviceClass: null,
      offline: true,
    });
    expect(await repo.getSession("missing")).toBeNull();
  });

  it("stores a game once, with its players, and makes unknown players", async () => {
    await start();
    const versus = game("g1", 1000, {
      mode: "versus",
      bots: 2,
      botLevel: 7,
      players: [
        {
          playerId: "a",
          seat: 0,
          result: "win",
          lines: 3,
          score: 30,
          pieces: 9,
          pps: 1.5,
          apm: 40.25,
        },
        { playerId: "b", seat: 1, result: "loss", lines: 1, score: 10, pieces: 8 },
      ],
    });
    expect(await repo.recordGame(versus)).toBe("created");
    expect(await repo.recordGame(versus)).toBe("duplicate");
    const stored = await repo.getGame("g1");
    expect(stored).toMatchObject({
      mode: "versus",
      bots: 2,
      botLevel: 7,
      durationMs: 60_000,
      offline: false,
    });
    expect(stored?.players).toEqual([
      {
        playerId: "a",
        seat: 0,
        result: "win",
        lines: 3,
        score: 30,
        pieces: 9,
        pps: 1.5,
        apm: 40.25,
      },
      {
        playerId: "b",
        seat: 1,
        result: "loss",
        lines: 1,
        score: 10,
        pieces: 8,
        pps: null,
        apm: null,
      },
    ]);
    expect(await repo.counts()).toMatchObject({ players: 2, games: 1 });
    expect(await repo.getGame("none")).toBeNull();
  });

  it("undoes a whole game when one part is refused", async () => {
    await start();
    const bad = game("g1", 1000, {
      players: [
        { playerId: "a", result: "win", lines: 3, score: 30, pieces: 9 },
        { playerId: "b", result: "loss", lines: -1, score: 10, pieces: 8 },
      ],
    });
    await expect(repo.recordGame(bad)).rejects.toThrow();
    expect(await repo.counts()).toEqual({ players: 0, sessions: 0, games: 0, events: 0 });
    expect(await repo.recordGame(game("g1", 1000))).toBe("created");
  });

  describe("one game reported by several players", () => {
    const row = (playerId: string, score: number) => ({
      playerId,
      result: "win" as const,
      lines: 10,
      score,
      pieces: 50,
    });
    const report = (playerId: string, extra: Partial<GameInput> = {}) =>
      game("match-1", 100_000, { mode: "versus", players: [row(playerId, 7)], ...extra });

    it("adds a later player's row to the game and keeps what the first report said", async () => {
      await start();
      expect(
        await repo.recordGame(report("a", { durationMs: 60_000, deviceClass: "mobile" })),
      ).toBe("created");
      expect(
        await repo.recordGame(report("b", { durationMs: 59_000, deviceClass: "desktop", bots: 3 })),
      ).toBe("joined");
      const stored = await repo.getGame("match-1");
      expect(stored).toMatchObject({ durationMs: 60_000, deviceClass: "mobile", bots: 0 });
      expect(stored?.players.map((p) => p.playerId)).toEqual(["a", "b"]);
      expect(await repo.counts()).toMatchObject({ players: 2, games: 1 });
      expect(await repo.recordGame(report("b"))).toBe("duplicate");
      expect(await repo.recordGame(report("a"))).toBe("duplicate");
      expect((await repo.getGame("match-1"))?.players).toHaveLength(2);
    });

    it("keeps the first row of a player when the same player reports again with other numbers", async () => {
      await start();
      await repo.recordGame(report("a"));
      await repo.recordGame(report("a", { players: [row("a", 999)] }));
      expect((await repo.getGame("match-1"))?.players[0]?.score).toBe(7);
    });

    it("refuses a report that does not belong to the game and writes nothing", async () => {
      await start();
      await repo.recordGame(report("a"));
      const before = await repo.counts();
      expect(await repo.recordGame(report("b", { mode: "sprint" }))).toBe("refused");
      expect(await repo.recordGame(report("c", { startedAt: 100_000 + 3 * 60_000 }))).toBe(
        "refused",
      );
      expect(await repo.recordGame(report("d", { startedAt: 100_000 - 3 * 60_000 }))).toBe(
        "refused",
      );
      expect(await repo.counts()).toEqual(before);
      expect((await repo.getGame("match-1"))?.players).toHaveLength(1);
      expect(await repo.recordGame(report("e", { startedAt: 100_000 + 90_000 }))).toBe("joined");
    });

    it("follows the window and the row limit it is given", async () => {
      await start();
      const rules = { windowMs: 1000, maxPlayers: 2 };
      expect(await repo.recordGame(report("a"), rules)).toBe("created");
      expect(await repo.recordGame(report("b", { startedAt: 100_900 }), rules)).toBe("joined");
      expect(await repo.recordGame(report("c", { startedAt: 100_500 }), rules)).toBe("refused");
      expect(await repo.recordGame(report("b", { startedAt: 100_900 }), rules)).toBe("duplicate");
      expect(await repo.recordGame(report("d", { startedAt: 105_000 }), rules)).toBe("refused");
      expect((await repo.getGame("match-1"))?.players.map((p) => p.playerId)).toEqual(["a", "b"]);
      expect((await repo.counts()).players).toBe(2);
    });

    it("rolls a joined row into the day's numbers when the day is rolled up again", async () => {
      await start();
      await repo.recordGame(report("a", { startedAt: D + HOUR }));
      await repo.rollupDay(DAY);
      await repo.recordGame(report("b", { startedAt: D + HOUR + 5000 }));
      await repo.rollupDay(DAY);
      const stats = await repo.dailyStats(DAY, DAY);
      expect(stats.find((x) => x.metric === "games" && x.dim === "all")?.value).toBe(1);
      expect(stats.find((x) => x.metric === "players_active" && x.dim === "all")?.value).toBe(2);
      expect((await repo.playerDays("b", DAY, DAY))[0]).toMatchObject({ games: 1 });
    });

    it("deleting one player keeps the game for the others, and the last one takes it away", async () => {
      await start();
      await repo.recordGame(report("a"));
      await repo.recordGame(report("b"));
      expect(await repo.deletePlayer("b")).toMatchObject({ player: true, games: 0 });
      expect((await repo.getGame("match-1"))?.players.map((p) => p.playerId)).toEqual(["a"]);
      expect(await repo.deletePlayer("a")).toMatchObject({ player: true, games: 1 });
      expect(await repo.getGame("match-1")).toBeNull();
    });
  });

  it("stores events once, keeps the payload and the offline flag, and counts only new ones", async () => {
    await start();
    const e = (id: string, at: number) => ({
      id,
      playerId: "p1",
      sessionId: "not-yet-known",
      kind: "game_end",
      occurredAt: at,
      receivedAt: at + 5,
      offline: true,
      payload: { mode: "sprint", nested: { lines: [1, 2] } },
    });
    expect(await repo.insertEvents([])).toBe(0);
    expect(await repo.insertEvents([e("a", 30), e("b", 10)])).toBe(2);
    expect(await repo.insertEvents([e("b", 10), e("c", 20)])).toBe(1);
    const events = await repo.listEvents("p1", 10);
    expect(events.map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(events[0]).toEqual({
      ...e("b", 10),
      payload: { mode: "sprint", nested: { lines: [1, 2] } },
    });
    expect(await repo.listEvents("p1", 2)).toHaveLength(2);
    expect(await repo.getPlayer("p1")).toMatchObject({ firstSeen: 10, lastSeen: 30 });
  });

  it("history is append-only, idempotent and newest first", async () => {
    await start();
    expect(
      await repo.addHistory({ id: "h1", playerId: "p1", kind: "best_score", value: 100, at: 10 }),
    ).toBe(true);
    expect(
      await repo.addHistory({ id: "h1", playerId: "p1", kind: "best_score", value: 999, at: 10 }),
    ).toBe(false);
    await repo.addHistory({
      id: "h2",
      playerId: "p1",
      kind: "best_score",
      value: 200,
      detail: { mode: "sprint" },
      at: 20,
    });
    const list = await repo.listHistory("p1", 10);
    expect(list.map((x) => x.id)).toEqual(["h2", "h1"]);
    expect(list[0]).toMatchObject({ value: 200, detail: { mode: "sprint" } });
    expect(list[1]).toMatchObject({ value: 100, detail: null });
    expect(await repo.listHistory("p1", 1)).toHaveLength(1);
  });

  it("rolls a day up from the raw rows", async () => {
    await fixture();
    await repo.rollupDay(DAY);
    const stats = await repo.dailyStats(DAY, DAY);
    const value = (metric: string, dim = "all") =>
      stats.find((s) => s.metric === metric && s.dim === dim)?.value;
    expect(value("games")).toBe(3);
    expect(value("play_ms")).toBe(210_000);
    expect(value("games", "mode:sprint")).toBe(2);
    expect(value("games", "mode:versus")).toBe(1);
    expect(value("games", "device:mobile")).toBe(1);
    expect(value("games", "device:desktop")).toBe(1);
    expect(value("games", "device:unknown")).toBe(1);
    expect(value("sessions")).toBe(2);
    expect(value("players_active")).toBe(2);
    expect(value("players_new")).toBe(2);
    expect(value("errors")).toBe(2);
    expect(await repo.playerDays("p1", DAY, DAY)).toEqual([
      { playerId: "p1", day: DAY, games: 2, playMs: 180_000, lines: 50, bestScore: 1000 },
    ]);
    expect(await repo.playerDays("p2", DAY, DAY)).toEqual([
      { playerId: "p2", day: DAY, games: 2, playMs: 150_000, lines: 13, bestScore: 9000 },
    ]);
    expect(await repo.playerDays("p3", DAY, DAY)).toEqual([]);
    expect(await repo.dailyStats(PREVIOUS, PREVIOUS)).toEqual([]);
  });

  it("rolling a day up again gives the same numbers, and picks up what arrived late", async () => {
    await fixture();
    await repo.rollupDay(DAY);
    const once = await repo.dailyStats(DAY, DAY);
    await repo.rollupDay(DAY);
    expect(await repo.dailyStats(DAY, DAY)).toEqual(once);
    await repo.recordGame(
      game("late", D + 20 * HOUR, {
        players: [{ playerId: "p1", result: "win", lines: 4, score: 5000, pieces: 9 }],
      }),
    );
    await repo.rollupDay(DAY);
    const stats = await repo.dailyStats(DAY, DAY);
    expect(stats.find((s) => s.metric === "games" && s.dim === "all")?.value).toBe(4);
    expect((await repo.playerDays("p1", DAY, DAY))[0]).toMatchObject({ games: 3, bestScore: 5000 });
  });

  it("refuses a day that is not a date", async () => {
    await start();
    await expect(repo.rollupDay("2026-13-40")).rejects.toThrow(RangeError);
    await expect(repo.rollupDay("yesterday")).rejects.toThrow(RangeError);
  });

  it("purges old rows only from days that were rolled up", async () => {
    await fixture();
    const endOfDay = D + DAY_MS;
    await repo.rollupDay(DAY);
    const first = await repo.purge({
      eventsBefore: endOfDay,
      gamesBefore: endOfDay,
      sessionsBefore: endOfDay,
    });
    expect(first).toEqual({ events: 3, games: 3, sessions: 2 });
    expect(await repo.counts()).toEqual({ players: 3, sessions: 1, games: 1, events: 1 });
    expect(await repo.getGame("g4")).not.toBeNull();
    expect(await repo.getGame("g2")).toBeNull();
    expect((await repo.dailyStats(DAY, DAY)).length).toBeGreaterThan(0);
    expect(await repo.playerDays("p1", DAY, DAY)).toHaveLength(1);

    await repo.rollupDay(PREVIOUS);
    expect(
      await repo.purge({ eventsBefore: endOfDay, gamesBefore: endOfDay, sessionsBefore: endOfDay }),
    ).toEqual({
      events: 1,
      games: 1,
      sessions: 1,
    });
    expect(await repo.counts()).toEqual({ players: 3, sessions: 0, games: 0, events: 0 });
    expect(await repo.purge({})).toEqual({ events: 0, games: 0, sessions: 0 });
  });

  it("keeps rows newer than the cutoff", async () => {
    await fixture();
    await repo.rollupDay(DAY);
    const result = await repo.purge({ eventsBefore: D + 5.5 * HOUR });
    expect(result.events).toBe(1);
    expect((await repo.listEvents("p2", 10)).map((e) => e.id)).toEqual(["e2", "e3"]);
  });

  it("purges in small batches until nothing is left", async () => {
    await start();
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `e${i}`,
      playerId: "p1",
      kind: "perf_sample",
      occurredAt: D + i * HOUR,
      receivedAt: D + i * HOUR,
    }));
    await repo.insertEvents(many);
    await repo.rollupDay(DAY);
    expect(await repo.purge({ eventsBefore: D + DAY_MS, batch: 2 })).toMatchObject({ events: 7 });
    expect((await repo.counts()).events).toBe(0);
  });

  it("deletes everything about one player and leaves other players and the rollups alone", async () => {
    await fixture();
    await repo.recordDevice("p2", { deviceClass: "desktop" }, D);
    await repo.addHistory({ id: "h1", playerId: "p2", kind: "best_score", value: 9000, at: D });
    await repo.rollupDay(DAY);
    const rollups = await repo.dailyStats(DAY, DAY);
    const result = await repo.deletePlayer("p2");
    expect(result).toEqual({
      player: true,
      games: 1,
      gamePlayers: 2,
      events: 2,
      sessions: 1,
      devices: 1,
      history: 1,
      playerDays: 1,
    });
    expect(await repo.getPlayer("p2")).toBeNull();
    expect(await repo.getGame("g3")).toBeNull();
    expect((await repo.getGame("g2"))?.players.map((p) => p.playerId)).toEqual(["p1"]);
    expect(await repo.getPlayer("p1")).not.toBeNull();
    expect(await repo.dailyStats(DAY, DAY)).toEqual(rollups);
    expect(await repo.deletePlayer("p2")).toMatchObject({ player: false, games: 0, events: 0 });
  });

  it("reports counts and a size, and compacts without harm", async () => {
    await fixture();
    expect(await repo.counts()).toEqual({ players: 3, sessions: 3, games: 4, events: 4 });
    expect(await repo.sizeBytes()).toBeGreaterThan(0);
    await repo.compact();
    expect((await repo.counts()).games).toBe(4);
  });

  it("takes many writes at once without mixing them up", async () => {
    await start();
    const games = Array.from({ length: 20 }, (_, i) =>
      repo.recordGame(
        game(`g${i}`, D + i, {
          players: [{ playerId: `p${i % 4}`, result: "finished", lines: i, score: i, pieces: i }],
        }),
      ),
    );
    const events = Array.from({ length: 20 }, (_, i) =>
      repo.insertEvents([
        { id: `e${i}`, playerId: `p${i % 4}`, kind: "k", occurredAt: D + i, receivedAt: D + i },
      ]),
    );
    const sessions = Array.from({ length: 20 }, (_, i) =>
      repo.startSession({ id: `s${i}`, playerId: `p${i % 4}`, startedAt: D + i }),
    );
    expect((await Promise.all(games)).every(Boolean)).toBe(true);
    expect((await Promise.all(events)).reduce((a, b) => a + b, 0)).toBe(20);
    await Promise.all(sessions);
    expect(await repo.counts()).toEqual({ players: 4, sessions: 20, games: 20, events: 20 });
  });
});

describe.skipIf(!POSTGRES_URL)("postgres only", () => {
  it("two servers starting together migrate once", async () => {
    const schema = `t_${Math.random().toString(36).slice(2, 10)}`;
    const open = () => openRepository({ driver: "postgres", url: POSTGRES_URL ?? "", schema });
    const [a, b] = await Promise.all([open(), open()]);
    try {
      expect(await a.schemaVersion()).toBe(1);
      expect(await b.schemaVersion()).toBe(1);
    } finally {
      await a.close();
      await b.close();
      const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 1 });
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

  it("refuses a schema name that could break out of its quotes", async () => {
    await expect(
      openRepository({
        driver: "postgres",
        url: POSTGRES_URL ?? "",
        schema: 'x"; drop table players; --',
      }),
    ).rejects.toThrow(/not allowed/);
  });
});
