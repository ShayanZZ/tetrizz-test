/**
 * The business dashboards (deploy/grafana/analytics): the JSON is well formed, and, when a PostgreSQL server
 * and `psql` are available (TEST_POSTGRES_URL, as for the repository contract), every panel's query runs as
 * the read-only role that deploy/postgres/init-analytics.sh makes, against rows the real repository wrote,
 * including events with garbage payloads (they come from players' browsers).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRepository, type Repository } from "../../apps/server/src/db";

const ROOT = join(__dirname, "../..");
const DASH_DIR = join(ROOT, "deploy/grafana/analytics/dashboards");
const SCRIPT = join(ROOT, "deploy/postgres/init-analytics.sh");
const URL_ENV = process.env.TEST_POSTGRES_URL;
const HAS_PSQL = spawnSync("psql", ["--version"]).status === 0;

interface Target {
  rawSql: string;
  format: string;
  refId: string;
  datasource: { uid: string };
}
interface Panel {
  id: number;
  title: string;
  type: string;
  datasource: { uid: string };
  targets: Target[];
  gridPos: { x: number; y: number; w: number; h: number };
}
interface Dashboard {
  uid: string;
  title: string;
  panels: Panel[];
  templating: { list: { name: string }[] };
}

const dashboards: Dashboard[] = readdirSync(DASH_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DASH_DIR, f), "utf8")) as Dashboard);

describe("analytics dashboards (static)", () => {
  it("has the two dashboards, with their own uids", () => {
    expect(dashboards.map((d) => d.uid)).toEqual(["tetrizz-player", "tetrizz-players"]);
  });

  for (const d of dashboards) {
    describe(d.title, () => {
      it("gives every panel a unique id and a place that overlaps no other panel", () => {
        expect(new Set(d.panels.map((p) => p.id)).size).toBe(d.panels.length);
        for (const a of d.panels) {
          for (const b of d.panels) {
            if (a.id >= b.id) continue;
            const apart =
              a.gridPos.x + a.gridPos.w <= b.gridPos.x ||
              b.gridPos.x + b.gridPos.w <= a.gridPos.x ||
              a.gridPos.y + a.gridPos.h <= b.gridPos.y ||
              b.gridPos.y + b.gridPos.h <= a.gridPos.y;
            expect(apart, `${a.title} overlaps ${b.title}`).toBe(true);
          }
          expect(a.gridPos.x + a.gridPos.w).toBeLessThanOrEqual(24);
        }
      });

      it("reads only the TetriZZ DB datasource, with raw SQL in a known format", () => {
        for (const p of d.panels) {
          expect(p.datasource.uid, p.title).toBe("tetrizz-db");
          expect(p.targets.length, p.title).toBeGreaterThan(0);
          for (const t of p.targets) {
            expect(t.datasource.uid, p.title).toBe("tetrizz-db");
            expect(["table", "time_series"], p.title).toContain(t.format);
            expect(t.rawSql.trim().length, p.title).toBeGreaterThan(0);
            if (t.format === "time_series") expect(t.rawSql, p.title).toMatch(/\bAS time\b/);
          }
        }
      });

      it("uses only macros that suit bigint time columns, and the quoted form of the player variable", () => {
        for (const p of d.panels) {
          for (const t of p.targets) {
            const macros = t.rawSql.match(/\$__\w+\(\)/g) ?? [];
            for (const m of macros)
              expect(["$__unixEpochFrom()", "$__unixEpochTo()"], p.title).toContain(m);
            expect(t.rawSql, p.title).not.toMatch(/\$player\b|\$\{player\}/);
            expect(t.rawSql, p.title).not.toMatch(
              /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i,
            );
          }
        }
      });
    });
  }
});

function expand(sql: string, player: string, fromS: number, toS: number): string {
  return sql
    .replaceAll("$__unixEpochFrom()", String(fromS))
    .replaceAll("$__unixEpochTo()", String(toS))
    .replaceAll("${player:sqlstring}", `'${player}'`);
}

// CI sets REQUIRE_ANALYTICS_TESTS so that a runner without psql or a database fails instead of skipping.
it.runIf(process.env.REQUIRE_ANALYTICS_TESTS === "1")(
  "has PostgreSQL and psql where the live tests are required",
  () => {
    expect(URL_ENV, "TEST_POSTGRES_URL").toBeTruthy();
    expect(HAS_PSQL, "psql on PATH").toBe(true);
  },
);

describe.skipIf(!URL_ENV || !HAS_PSQL)("analytics dashboards (PostgreSQL, read-only role)", () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const schema = `tz_an_${suffix}`;
  const role = `tz_ro_${suffix}`;
  const password = "abc123XYZ";
  const day = 86_400_000;
  const now = Date.parse("2026-11-21T12:00:00Z");
  let admin: pg.Client;
  let repo: Repository;
  let reader: pg.Client;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    admin = new pg.Client({ connectionString: URL_ENV });
    await admin.connect();
    repo = await openRepository({ driver: "postgres", url: URL_ENV!, schema, now: () => now });

    const player = "p".padEnd(32, "1");
    await repo.touchPlayer(player, now - 3 * day);
    await repo.recordDevice(
      player,
      { deviceClass: "mobile", os: "Android", osVersion: "8.0", browser: "Chrome" },
      now - day,
    );
    await repo.startSession({
      id: "session-0001",
      playerId: player,
      startedAt: now - day,
      appVersion: "1.2.0",
      deviceClass: "mobile",
    });
    await repo.recordGame({
      id: "game-00001",
      sessionId: "session-0001",
      mode: "sprint",
      startedAt: now - day,
      durationMs: 61_000,
      deviceClass: "mobile",
      players: [
        { playerId: player, result: "win", lines: 40, score: 1200, pieces: 100, pps: 1.6, apm: 40 },
      ],
    });
    const at = now - day + 5000;
    const e = (id: string, kind: string, payload: unknown) => ({
      id,
      playerId: player,
      sessionId: "session-0001",
      kind,
      occurredAt: at,
      receivedAt: at,
      payload,
    });
    await repo.insertEvents([
      e("event-0001", "perf_sample", {
        mode: "sprint",
        fps: 58,
        medianMs: 16.7,
        p95Ms: 21,
        thinkMs: 1.2,
        tier: 0,
      }),
      // What a hostile or broken page could send: none of it may break a panel.
      e("event-0002", "perf_sample", { fps: "fast", p95Ms: "slow", thinkMs: null, tier: { a: 1 } }),
      e("event-0003", "perf_sample", "not an object"),
      e("event-0004", "perf_sample", [1, 2, 3]),
      e("event-0005", "js_error", {
        name: "TypeError",
        message: "x",
        where: "a.js:1",
        hash: "0badf00d",
      }),
      e("event-0006", "js_error", 7),
      e("event-0007", "room_create", { backend: "server" }),
      e("event-0008", "room_join", { backend: 5 }),
      e("event-0009", "room_join", null),
    ]);
    // A number too large for a double cannot be written from JavaScript (1e400 is Infinity, and JSON makes it null).
    await admin.query(
      `INSERT INTO ${schema}.events (id, player_id, session_id, kind, occurred_at, received_at, payload)
       VALUES ('event-0010', $1, 'session-0001', 'perf_sample', $2, $2, '{"fps": 1e400, "p95Ms": 1e400, "thinkMs": 1e400, "tier": 1e400}'::jsonb)`,
      [player, at],
    );
    await repo.addHistory({
      id: "history-0001",
      playerId: player,
      kind: "personal_best",
      value: 61_000,
      detail: { mode: "sprint" },
      at: now - day,
    });
    await repo.addHistory({
      id: "history-0002",
      playerId: player,
      kind: "personal_best",
      value: 900,
      detail: "odd",
      at: now - day,
    });
    for (const d of [2, 1, 0])
      await repo.rollupDay(new Date(now - d * day).toISOString().slice(0, 10));

    const env = {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: url.pathname.slice(1),
      ANALYTICS_DB_PASSWORD: password,
      ANALYTICS_DB_USER: role,
      ANALYTICS_DB_SCHEMA: schema,
    };
    for (let i = 0; i < 2; i++) {
      // Twice: the script is run again at every `docker compose up`.
      const r = spawnSync("sh", [SCRIPT], { env, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
    }
    url.username = role;
    url.password = password;
    reader = new pg.Client({ connectionString: url.toString() });
    await reader.connect();
  }, 60_000);

  afterAll(async () => {
    await reader?.end();
    await repo?.close();
    await admin?.query(`DROP OWNED BY ${role}`);
    await admin?.query(`DROP ROLE IF EXISTS ${role}`);
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  for (const d of dashboards) {
    for (const p of d.panels) {
      it(`${d.title} / ${p.title}: every query runs and a time series has a time column`, async () => {
        for (const t of p.targets) {
          const sql = expand(t.rawSql, "p".padEnd(32, "1"), now / 1000 - 30 * 86400, now / 1000);
          const res = await reader.query(sql);
          if (t.format === "time_series") expect(res.fields.map((f) => f.name)).toContain("time");
        }
      });
    }
  }

  it("shows what was stored", async () => {
    const q = async (title: string, dash = "tetrizz-players") => {
      const p = dashboards.find((d) => d.uid === dash)!.panels.find((x) => x.title === title)!;
      return (
        await reader.query(
          expand(p.targets[0]!.rawSql, "p".padEnd(32, "1"), now / 1000 - 30 * 86400, now / 1000),
        )
      ).rows;
    };
    expect((await q("Players"))[0]).toEqual({ Players: "1" });
    expect((await q("Games, all time"))[0]).toEqual({ Games: "1" });
    expect((await q("Games by mode (selected range)"))[0]).toEqual({ Mode: "sprint", Games: "1" });
    // Only the well formed sample counts; the garbage ones are left out, not fatal.
    const perf = (await q("Performance by device class"))[0]!;
    expect(perf).toMatchObject({ Class: "mobile", Samples: "1", "Median fps": "58" });
    expect((await q("Script errors"))[0]).toMatchObject({ Hash: "0badf00d", Count: "1" });
    expect((await q("Profile", "tetrizz-player"))[0]).toMatchObject({
      Games: "1",
      "Opted out": "no",
    });
    expect((await q("Best by mode", "tetrizz-player"))[0]).toMatchObject({
      Mode: "sprint",
      Wins: "1",
      "Best score": "1200",
    });
  });

  it("the role can read but never write, even with its read-only setting switched off", async () => {
    await expect(reader.query("SHOW default_transaction_read_only")).resolves.toMatchObject({
      rows: [{ default_transaction_read_only: "on" }],
    });
    await expect(reader.query("SHOW statement_timeout")).resolves.toMatchObject({
      rows: [{ statement_timeout: "30s" }],
    });
    await reader.query("SET default_transaction_read_only = off");
    for (const sql of [
      "DELETE FROM players",
      "UPDATE players SET last_seen = 0",
      "TRUNCATE players",
      `CREATE TABLE ${schema}.x (i int)`,
      "DROP TABLE players",
    ]) {
      await expect(reader.query(sql), sql).rejects.toThrow(/permission denied|must be owner/);
    }
    await reader.query("SET default_transaction_read_only = on");
  });

  it("can read a table the server's user creates later, without running the script again", async () => {
    await admin.query(`CREATE TABLE ${schema}.later_table (i int)`);
    await expect(reader.query(`SELECT count(*) FROM ${schema}.later_table`)).resolves.toBeTruthy();
  });

  it("refuses a role or schema name that could break out of the script", () => {
    const r = spawnSync("sh", [SCRIPT], {
      env: {
        ...process.env,
        PGDATABASE: "x",
        ANALYTICS_DB_PASSWORD: "x",
        ANALYTICS_DB_USER: 'a"; DROP TABLE players; --',
      },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("letters, digits and _ only");
  });
});
