/**
 * The repository: every query the server makes, written once in SQL that SQLite and PostgreSQL
 * both accept (`?` placeholders, `ON CONFLICT`, `CAST`). Nothing here knows which database runs it.
 * Time never comes from the clock inside a query: callers pass it, so tests need no fake timers.
 */
import { createHash } from "node:crypto";
import { DAY_MS, dayStart } from "./days";
import type { Executor, Param, Row } from "./executor";
import type {
  Counts,
  DailyStat,
  DeleteResult,
  DeviceInfo,
  DriverName,
  EventInput,
  EventRecord,
  GameInput,
  GameJoinRules,
  GameResult,
  GameWrite,
  HistoryInput,
  HistoryRecord,
  PlayerDay,
  PlayerRecord,
  PurgeCutoffs,
  PurgeResult,
  Repository,
  SessionInput,
  SessionRecord,
} from "./types";

export interface RepositoryOptions {
  driver: DriverName;
  db: Executor;
  now: () => number;
  /** SQLite only: how many pages `compact` frees in one call. */
  vacuumPages?: number;
}

const DEFAULT_BATCH = 1000;
/** Used when a caller gives no rules: a report may join a game of the same mode that began within two minutes. */
const DEFAULT_JOIN: GameJoinRules = { windowMs: 120_000, maxPlayers: 16 };
const UNKNOWN = "unknown";

const num = (value: unknown): number => Number(value);
const orNull = (value: unknown): number | null => (value === null ? null : Number(value));
const text = (value: unknown): string | null => (value === null ? null : String(value));
const flag = (value: boolean | undefined): number => (value ? 1 : 0);
const json = (value: unknown): string => JSON.stringify(value ?? null);
/** SQLite hands JSON back as text, PostgreSQL as a value already parsed. */
const parseJson = (value: unknown): unknown =>
  typeof value === "string" ? (JSON.parse(value) as unknown) : value;

function fingerprintOf(device: DeviceInfo): string {
  const entries = Object.entries(device)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 16);
}

/** Whether a report for an id that is already stored describes that same game. */
async function belongsToGame(tx: Executor, game: GameInput, join: GameJoinRules): Promise<boolean> {
  const rows = await tx.all("SELECT mode, started_at FROM games WHERE id = ?", [game.id]);
  const stored = rows[0];
  if (!stored) return false;
  return (
    String(stored.mode) === game.mode &&
    Math.abs(num(stored.started_at) - game.startedAt) <= join.windowMs
  );
}

const toPlayer = (row: Row): PlayerRecord => ({
  id: String(row.id),
  firstSeen: num(row.first_seen),
  lastSeen: num(row.last_seen),
  accountId: text(row.account_id),
  telemetryOptOut: num(row.telemetry_opt_out) === 1,
});

const toSession = (row: Row): SessionRecord => ({
  id: String(row.id),
  playerId: String(row.player_id),
  startedAt: num(row.started_at),
  endedAt: orNull(row.ended_at),
  appVersion: text(row.app_version),
  displayMode: text(row.display_mode),
  deviceClass: text(row.device_class),
  offline: num(row.offline) === 1,
});

const toEvent = (row: Row): EventRecord => ({
  id: String(row.id),
  playerId: String(row.player_id),
  sessionId: text(row.session_id),
  kind: String(row.kind),
  occurredAt: num(row.occurred_at),
  receivedAt: num(row.received_at),
  offline: num(row.offline) === 1,
  payload: parseJson(row.payload),
});

const toHistory = (row: Row): HistoryRecord => ({
  id: String(row.id),
  playerId: String(row.player_id),
  kind: String(row.kind),
  value: orNull(row.value),
  detail: row.detail === null ? null : parseJson(row.detail),
  at: num(row.at),
});

/** A day's worth of rows, as the half-open range [from, to). */
const dayRange = (day: string): [number, number] => {
  const from = dayStart(day);
  return [from, from + DAY_MS];
};

const UPSERT_PLAYER = `INSERT INTO players (id, first_seen, last_seen) VALUES (?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    first_seen = CASE WHEN excluded.first_seen < players.first_seen THEN excluded.first_seen ELSE players.first_seen END,
    last_seen = CASE WHEN excluded.last_seen > players.last_seen THEN excluded.last_seen ELSE players.last_seen END`;

const PURGEABLE_DAY = "(%c - %c % 86400000) IN (SELECT day_start FROM rollup_days)";
const purgeable = (column: string): string => PURGEABLE_DAY.replaceAll("%c", column);

export function createRepository(options: RepositoryOptions): Repository {
  const { db, now } = options;
  const vacuumPages = options.vacuumPages ?? 2000;

  const upsertPlayer = (tx: Executor, id: string, first: number, last: number) =>
    tx.run(UPSERT_PLAYER, [id, first, last]);

  const one = async (sql: string, params: readonly Param[]): Promise<Row | null> =>
    (await db.all(sql, params))[0] ?? null;

  const batchDelete = async (
    table: string,
    column: string,
    cutoff: number,
    batch: number,
  ): Promise<number> => {
    let total = 0;
    for (;;) {
      const removed = await db.run(
        `DELETE FROM ${table} WHERE id IN (
           SELECT id FROM ${table} WHERE ${column} < ? AND ${purgeable(column)} LIMIT ?)`,
        [cutoff, batch],
      );
      total += removed;
      if (removed < batch) return total;
    }
  };

  const repository: Repository = {
    driver: options.driver,

    async schemaVersion() {
      const row = await one("SELECT MAX(version) AS version FROM schema_migrations", []);
      return row ? num(row.version) : 0;
    },
    async ping() {
      await db.all("SELECT 1 AS ok");
    },
    close: () => db.close(),

    async touchPlayer(id, at) {
      await upsertPlayer(db, id, at, at);
      const player = await repository.getPlayer(id);
      if (!player) throw new Error("player vanished after it was written");
      return player;
    },
    async getPlayer(id) {
      const row = await one("SELECT * FROM players WHERE id = ?", [id]);
      return row ? toPlayer(row) : null;
    },
    async setTelemetryOptOut(id, optOut) {
      await db.run("UPDATE players SET telemetry_opt_out = ? WHERE id = ?", [flag(optOut), id]);
    },
    async recordDevice(playerId, device, at) {
      const fingerprint = fingerprintOf(device);
      await db.transaction(async (tx) => {
        await upsertPlayer(tx, playerId, at, at);
        await tx.run(
          `INSERT INTO player_devices (player_id, fingerprint, device_class, device, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (player_id, fingerprint) DO UPDATE SET
             first_seen = CASE WHEN excluded.first_seen < player_devices.first_seen THEN excluded.first_seen ELSE player_devices.first_seen END,
             last_seen = CASE WHEN excluded.last_seen > player_devices.last_seen THEN excluded.last_seen ELSE player_devices.last_seen END`,
          [playerId, fingerprint, device.deviceClass, json(device), at, at],
        );
      });
    },
    async listDevices(playerId) {
      const rows = await db.all(
        "SELECT * FROM player_devices WHERE player_id = ? ORDER BY first_seen, fingerprint",
        [playerId],
      );
      return rows.map((row) => ({
        fingerprint: String(row.fingerprint),
        device: parseJson(row.device) as DeviceInfo,
        firstSeen: num(row.first_seen),
        lastSeen: num(row.last_seen),
      }));
    },

    async startSession(session: SessionInput) {
      await db.transaction(async (tx) => {
        await upsertPlayer(tx, session.playerId, session.startedAt, session.startedAt);
        await tx.run(
          `INSERT INTO sessions (id, player_id, started_at, app_version, display_mode, device_class, offline)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          [
            session.id,
            session.playerId,
            session.startedAt,
            session.appVersion ?? null,
            session.displayMode ?? null,
            session.deviceClass ?? null,
            flag(session.offline),
          ],
        );
      });
    },
    async endSession(id, at) {
      await db.run(
        "UPDATE sessions SET ended_at = ? WHERE id = ? AND (ended_at IS NULL OR ended_at < ?)",
        [at, id, at],
      );
    },
    async getSession(id) {
      const row = await one("SELECT * FROM sessions WHERE id = ?", [id]);
      return row ? toSession(row) : null;
    },

    async recordGame(game: GameInput, join: GameJoinRules = DEFAULT_JOIN): Promise<GameWrite> {
      return db.transaction(async (tx): Promise<GameWrite> => {
        const created = await tx.run(
          `INSERT INTO games (id, session_id, mode, started_at, duration_ms, bots, bot_level, app_version, device_class, offline)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          [
            game.id,
            game.sessionId ?? null,
            game.mode,
            game.startedAt,
            game.durationMs,
            game.bots ?? 0,
            game.botLevel ?? null,
            game.appVersion ?? null,
            game.deviceClass ?? null,
            flag(game.offline),
          ],
        );
        if (created === 0 && !(await belongsToGame(tx, game, join))) return "refused";

        let room = join.maxPlayers;
        if (created === 0) {
          const held = await tx.all(
            "SELECT COUNT(*) AS value FROM game_players WHERE game_id = ?",
            [game.id],
          );
          room = join.maxPlayers - num(held[0]?.value);
        }
        let added = 0;
        let turnedAway = 0;
        for (const player of game.players) {
          if (created === 0 && room - added <= 0) {
            const known = await tx.all(
              "SELECT 1 AS value FROM game_players WHERE game_id = ? AND player_id = ?",
              [game.id, player.playerId],
            );
            if (known.length === 0) turnedAway++;
            continue;
          }
          await upsertPlayer(tx, player.playerId, game.startedAt, game.startedAt);
          added += await tx.run(
            `INSERT INTO game_players (game_id, player_id, seat, result, lines, score, pieces, pps, apm)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (game_id, player_id) DO NOTHING`,
            [
              game.id,
              player.playerId,
              player.seat ?? null,
              player.result,
              player.lines,
              player.score,
              player.pieces,
              player.pps ?? null,
              player.apm ?? null,
            ],
          );
        }
        if (created > 0) return "created";
        if (added > 0) return "joined";
        return turnedAway > 0 ? "refused" : "duplicate";
      });
    },
    async getGame(id) {
      const row = await one("SELECT * FROM games WHERE id = ?", [id]);
      if (!row) return null;
      const players = await db.all(
        "SELECT * FROM game_players WHERE game_id = ? ORDER BY seat, player_id",
        [id],
      );
      return {
        id: String(row.id),
        sessionId: text(row.session_id),
        mode: String(row.mode),
        startedAt: num(row.started_at),
        durationMs: num(row.duration_ms),
        bots: num(row.bots),
        botLevel: orNull(row.bot_level),
        appVersion: text(row.app_version),
        deviceClass: text(row.device_class),
        offline: num(row.offline) === 1,
        players: players.map((p) => ({
          playerId: String(p.player_id),
          seat: orNull(p.seat),
          result: String(p.result) as GameResult,
          lines: num(p.lines),
          score: num(p.score),
          pieces: num(p.pieces),
          pps: orNull(p.pps),
          apm: orNull(p.apm),
        })),
      };
    },

    async insertEvents(events: readonly EventInput[]) {
      if (events.length === 0) return 0;
      return db.transaction(async (tx) => {
        const span = new Map<string, [number, number]>();
        for (const event of events) {
          const known = span.get(event.playerId);
          span.set(
            event.playerId,
            known
              ? [Math.min(known[0], event.occurredAt), Math.max(known[1], event.occurredAt)]
              : [event.occurredAt, event.occurredAt],
          );
        }
        for (const [playerId, [first, last]] of span) await upsertPlayer(tx, playerId, first, last);
        let added = 0;
        for (const event of events) {
          added += await tx.run(
            `INSERT INTO events (id, player_id, session_id, kind, occurred_at, received_at, offline, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
            [
              event.id,
              event.playerId,
              event.sessionId ?? null,
              event.kind,
              event.occurredAt,
              event.receivedAt,
              flag(event.offline),
              json(event.payload ?? {}),
            ],
          );
        }
        return added;
      });
    },
    async listEvents(playerId, limit) {
      const rows = await db.all(
        "SELECT * FROM events WHERE player_id = ? ORDER BY occurred_at, id LIMIT ?",
        [playerId, limit],
      );
      return rows.map(toEvent);
    },

    async addHistory(entry: HistoryInput) {
      return db.transaction(async (tx) => {
        await upsertPlayer(tx, entry.playerId, entry.at, entry.at);
        const added = await tx.run(
          `INSERT INTO player_history (id, player_id, kind, value, detail, at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          [
            entry.id,
            entry.playerId,
            entry.kind,
            entry.value ?? null,
            entry.detail === undefined ? null : json(entry.detail),
            entry.at,
          ],
        );
        return added === 1;
      });
    },
    async listHistory(playerId, limit) {
      const rows = await db.all(
        "SELECT * FROM player_history WHERE player_id = ? ORDER BY at DESC, id DESC LIMIT ?",
        [playerId, limit],
      );
      return rows.map(toHistory);
    },

    async rollupDay(day) {
      const [from, to] = dayRange(day);
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM daily_stats WHERE day = ?", [day]);
        await tx.run("DELETE FROM player_daily WHERE day = ?", [day]);
        const stats: Array<[string, string, number]> = [];

        const totals = await tx.all(
          `SELECT COUNT(*) AS games, CAST(COALESCE(SUM(duration_ms), 0) AS BIGINT) AS play_ms
           FROM games WHERE started_at >= ? AND started_at < ?`,
          [from, to],
        );
        stats.push(["games", "all", num(totals[0]?.games)]);
        stats.push(["play_ms", "all", num(totals[0]?.play_ms)]);

        const byMode = await tx.all(
          `SELECT mode AS dim, COUNT(*) AS value FROM games
           WHERE started_at >= ? AND started_at < ? GROUP BY mode`,
          [from, to],
        );
        for (const row of byMode) stats.push(["games", `mode:${String(row.dim)}`, num(row.value)]);

        const byDevice = await tx.all(
          `SELECT COALESCE(device_class, '${UNKNOWN}') AS dim, COUNT(*) AS value FROM games
           WHERE started_at >= ? AND started_at < ? GROUP BY COALESCE(device_class, '${UNKNOWN}')`,
          [from, to],
        );
        for (const row of byDevice) {
          stats.push(["games", `device:${String(row.dim)}`, num(row.value)]);
        }

        const sessions = await tx.all(
          "SELECT COUNT(*) AS value FROM sessions WHERE started_at >= ? AND started_at < ?",
          [from, to],
        );
        stats.push(["sessions", "all", num(sessions[0]?.value)]);

        const active = await tx.all(
          `SELECT COUNT(*) AS value FROM (
             SELECT player_id FROM sessions WHERE started_at >= ? AND started_at < ?
             UNION
             SELECT gp.player_id FROM game_players gp JOIN games g ON g.id = gp.game_id
             WHERE g.started_at >= ? AND g.started_at < ?) active`,
          [from, to, from, to],
        );
        stats.push(["players_active", "all", num(active[0]?.value)]);

        const fresh = await tx.all(
          "SELECT COUNT(*) AS value FROM players WHERE first_seen >= ? AND first_seen < ?",
          [from, to],
        );
        stats.push(["players_new", "all", num(fresh[0]?.value)]);

        const errors = await tx.all(
          "SELECT COUNT(*) AS value FROM events WHERE kind = 'js_error' AND occurred_at >= ? AND occurred_at < ?",
          [from, to],
        );
        stats.push(["errors", "all", num(errors[0]?.value)]);

        for (const [metric, dim, value] of stats) {
          await tx.run("INSERT INTO daily_stats (day, metric, dim, value) VALUES (?, ?, ?, ?)", [
            day,
            metric,
            dim,
            value,
          ]);
        }

        await tx.run(
          `INSERT INTO player_daily (player_id, day, games, play_ms, lines, best_score)
           SELECT gp.player_id, CAST(? AS TEXT), COUNT(*),
                  CAST(COALESCE(SUM(g.duration_ms), 0) AS BIGINT),
                  CAST(COALESCE(SUM(gp.lines), 0) AS BIGINT),
                  COALESCE(MAX(gp.score), 0)
           FROM game_players gp JOIN games g ON g.id = gp.game_id
           WHERE g.started_at >= ? AND g.started_at < ?
           GROUP BY gp.player_id`,
          [day, from, to],
        );

        await tx.run(
          `INSERT INTO rollup_days (day, day_start, rolled_at) VALUES (?, ?, ?)
           ON CONFLICT (day) DO UPDATE SET rolled_at = excluded.rolled_at`,
          [day, from, now()],
        );
      });
    },
    async dailyStats(fromDay, toDay) {
      const rows = await db.all(
        "SELECT * FROM daily_stats WHERE day >= ? AND day <= ? ORDER BY day, metric, dim",
        [fromDay, toDay],
      );
      return rows.map((row): DailyStat => ({
        day: String(row.day),
        metric: String(row.metric),
        dim: String(row.dim),
        value: num(row.value),
      }));
    },
    async playerDays(playerId, fromDay, toDay) {
      const rows = await db.all(
        "SELECT * FROM player_daily WHERE player_id = ? AND day >= ? AND day <= ? ORDER BY day",
        [playerId, fromDay, toDay],
      );
      return rows.map((row): PlayerDay => ({
        playerId: String(row.player_id),
        day: String(row.day),
        games: num(row.games),
        playMs: num(row.play_ms),
        lines: num(row.lines),
        bestScore: num(row.best_score),
      }));
    },

    async purge(cutoffs: PurgeCutoffs): Promise<PurgeResult> {
      const batch = cutoffs.batch ?? DEFAULT_BATCH;
      const result: PurgeResult = { events: 0, games: 0, sessions: 0 };
      if (cutoffs.eventsBefore !== undefined) {
        result.events = await batchDelete("events", "occurred_at", cutoffs.eventsBefore, batch);
      }
      if (cutoffs.gamesBefore !== undefined) {
        result.games = await batchDelete("games", "started_at", cutoffs.gamesBefore, batch);
      }
      if (cutoffs.sessionsBefore !== undefined) {
        result.sessions = await batchDelete(
          "sessions",
          "started_at",
          cutoffs.sessionsBefore,
          batch,
        );
      }
      return result;
    },
    async deletePlayer(id) {
      return db.transaction(async (tx) => {
        const rows = await tx.all(
          "SELECT COUNT(*) AS value FROM game_players WHERE player_id = ?",
          [id],
        );
        const games = await tx.run(
          `DELETE FROM games
           WHERE id IN (SELECT game_id FROM game_players WHERE player_id = ?)
             AND NOT EXISTS (
               SELECT 1 FROM game_players other
               WHERE other.game_id = games.id AND other.player_id <> ?)`,
          [id, id],
        );
        await tx.run("DELETE FROM game_players WHERE player_id = ?", [id]);
        const events = await tx.run("DELETE FROM events WHERE player_id = ?", [id]);
        const sessions = await tx.run("DELETE FROM sessions WHERE player_id = ?", [id]);
        const devices = await tx.run("DELETE FROM player_devices WHERE player_id = ?", [id]);
        const history = await tx.run("DELETE FROM player_history WHERE player_id = ?", [id]);
        const playerDays = await tx.run("DELETE FROM player_daily WHERE player_id = ?", [id]);
        const player = await tx.run("DELETE FROM players WHERE id = ?", [id]);
        return {
          player: player === 1,
          games,
          gamePlayers: num(rows[0]?.value),
          events,
          sessions,
          devices,
          history,
          playerDays,
        } satisfies DeleteResult;
      });
    },

    async counts(): Promise<Counts> {
      const count = async (table: string) =>
        num((await one(`SELECT COUNT(*) AS value FROM ${table}`, []))?.value);
      return {
        players: await count("players"),
        sessions: await count("sessions"),
        games: await count("games"),
        events: await count("events"),
      };
    },
    async sizeBytes() {
      if (options.driver === "postgres") {
        return num((await one("SELECT pg_database_size(current_database()) AS value", []))?.value);
      }
      const pages = num(Object.values((await one("PRAGMA page_count", [])) ?? {})[0]);
      const size = num(Object.values((await one("PRAGMA page_size", [])) ?? {})[0]);
      return pages * size;
    },
    async compact() {
      if (options.driver !== "sqlite") return;
      await db.all(`PRAGMA incremental_vacuum(${vacuumPages})`);
      await db.all("PRAGMA wal_checkpoint(TRUNCATE)");
    },
  };
  return repository;
}
