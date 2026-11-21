/**
 * Turns what the page knows about a game into telemetry items. The page reads its own state and
 * hands snapshots to the tracker at the moments a game starts, ends or is left; the tracker decides
 * what is worth reporting and in which shape. It touches no DOM, no storage and no network, so
 * every rule here is checked by unit tests.
 *
 * What is reported, and what is not:
 * - A game that was started and ended (or was left through the menu) is one game row with the
 *   player's own row. Several humans of one online match share one game id, so the server keeps
 *   one game with one row per player.
 * - A game left through the menu with no piece played is not reported at all.
 * - A game whose tab was closed or reloaded is not reported: there is no safe moment to read it.
 */
import type { GameReport, TelemetryClient } from "./client";

export type TrackerSink = Pick<TelemetryClient, "record" | "recordGame" | "recordHistory">;

export interface SoloStats {
  /** `endless`, `sprint`, `ultra` or `practice`. */
  mode: string;
  score: number;
  lines: number;
  pieces: number;
  playMs: number;
  /** Sprint only: the line target was reached. */
  cleared: boolean;
}

/** The best entry the saved scores held before this game: `s` is a score, `t` a sprint time. */
export interface BestEntry {
  s: number;
  t: number;
}

export interface VersusStats {
  /** Local versus (with bots or friends on one device) or an online room. */
  kind: "vs" | "online";
  submode: string;
  /** The player's own slot, 0 to 3. */
  seat: number;
  bots: number;
  botLevel: number | undefined;
  lines: number;
  score: number;
  pieces: number;
  /** The player's own play time summed over the rounds, in milliseconds; the base of PPS and APM. */
  ms: number;
  /** The longest play time of any player in the match, in milliseconds; the game's duration. */
  matchMs: number;
  /** Garbage lines sent, for APM. */
  attack: number;
  /** The shared id of an online match, or null (the page then uses its own id). */
  matchId: string | null;
}

const MODE_CHARS = /[^a-z0-9_-]/g;

/** A mode name in the server's format: lower case letters, digits, `_` and `-`, at most 24 long. */
export function modeName(...parts: string[]): string {
  const name = parts.join("-").toLowerCase().replace(MODE_CHARS, "").slice(0, 24);
  return name === "" ? "unknown" : name;
}

function whole(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function round(value: number, digits: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Pieces per second over `ms` of play, or undefined when no time was played. */
export function piecesPerSecond(pieces: number, ms: number): number | undefined {
  return ms > 0 ? round(pieces / (ms / 1000), 2) : undefined;
}

/** Garbage lines per minute over `ms` of play, or undefined when no time was played. */
export function attackPerMinute(attack: number, ms: number): number | undefined {
  return ms > 0 ? round((attack * 60_000) / ms, 1) : undefined;
}

/**
 * The page's own rule for a new personal best: a sprint is a best when it was cleared faster than
 * the saved best (or none was saved), any other mode when the score is above the saved best.
 */
export function isNewBest(stats: SoloStats, previous: BestEntry | null): boolean {
  if (stats.mode === "sprint") {
    return stats.cleared && (previous === null || Math.round(stats.playMs) < previous.t);
  }
  if (stats.mode === "practice" || stats.mode === "vsbot") return false;
  return stats.score > 0 && (previous === null || stats.score > previous.s);
}

export type OpenGame = "solo" | "versus" | null;

export interface GameTracker {
  soloStarted(mode: string): void;
  soloEnded(stats: SoloStats, previousBest: BestEntry | null): void;
  /** The player left through the menu. Pass the stats as they stand. */
  soloQuit(stats: SoloStats): void;
  versusStarted(kind: VersusStats["kind"], submode: string): void;
  versusEnded(stats: VersusStats, won: boolean): void;
  versusQuit(stats: VersusStats): void;
  open(): OpenGame;
}

export function createGameTracker(
  sink: TrackerSink,
  playerId: () => string | null,
  now: () => number,
): GameTracker {
  let solo: { mode: string; startedAt: number } | null = null;
  let versus: { startedAt: number } | null = null;

  function soloRow(
    startedAt: number,
    stats: SoloStats,
    result: "win" | "loss" | "finished" | "quit",
  ): void {
    const id = playerId();
    if (id === null) return;
    const durationMs = whole(stats.playMs);
    const row: GameReport["players"][number] = {
      playerId: id,
      seat: 0,
      result,
      lines: whole(stats.lines),
      score: whole(stats.score),
      pieces: whole(stats.pieces),
    };
    const pps = piecesPerSecond(stats.pieces, stats.playMs);
    if (pps !== undefined) row.pps = pps;
    sink.recordGame({ mode: modeName(stats.mode), startedAt, durationMs, players: [row] });
  }

  function versusRow(startedAt: number, stats: VersusStats, result: "win" | "loss" | "quit"): void {
    const id = playerId();
    if (id === null) return;
    const row: GameReport["players"][number] = {
      playerId: id,
      seat: Math.min(3, Math.max(0, Math.trunc(stats.seat))),
      result,
      lines: whole(stats.lines),
      score: whole(stats.score),
      pieces: whole(stats.pieces),
    };
    const pps = piecesPerSecond(stats.pieces, stats.ms);
    if (pps !== undefined) row.pps = pps;
    const apm = attackPerMinute(stats.attack, stats.ms);
    if (apm !== undefined) row.apm = apm;
    const game: GameReport = {
      mode: modeName(stats.kind, stats.submode),
      startedAt,
      durationMs: whole(stats.matchMs),
      players: [row],
    };
    if (stats.matchId !== null) game.id = stats.matchId;
    if (stats.bots > 0) {
      game.bots = Math.min(3, stats.bots);
      if (stats.botLevel !== undefined) game.botLevel = stats.botLevel;
    }
    sink.recordGame(game);
  }

  return {
    soloStarted(mode) {
      solo = { mode, startedAt: now() };
      sink.record("game_start", { mode: modeName(mode) });
    },

    soloEnded(stats, previousBest) {
      const startedAt = solo !== null ? solo.startedAt : now() - whole(stats.playMs);
      solo = null;
      let result: "win" | "loss" | "finished" = "finished";
      if (stats.mode === "sprint") result = stats.cleared ? "win" : "loss";
      soloRow(startedAt, stats, result);
      if (isNewBest(stats, previousBest)) {
        const value = stats.mode === "sprint" ? whole(stats.playMs) : whole(stats.score);
        sink.recordHistory("personal_best", value, { mode: modeName(stats.mode) });
      }
    },

    soloQuit(stats) {
      const open = solo;
      solo = null;
      if (open === null || stats.pieces <= 0) return;
      soloRow(open.startedAt, stats, "quit");
    },

    versusStarted(kind, submode) {
      versus = { startedAt: now() };
      sink.record("game_start", { mode: modeName(kind, submode) });
    },

    versusEnded(stats, won) {
      const startedAt = versus !== null ? versus.startedAt : now() - whole(stats.matchMs);
      versus = null;
      versusRow(startedAt, stats, won ? "win" : "loss");
    },

    versusQuit(stats) {
      const open = versus;
      versus = null;
      if (open === null || stats.pieces <= 0) return;
      versusRow(open.startedAt, stats, "quit");
    },

    open() {
      if (solo !== null) return "solo";
      return versus !== null ? "versus" : null;
    },
  };
}
