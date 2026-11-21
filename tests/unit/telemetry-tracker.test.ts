import { describe, expect, it } from "vitest";
import type { GameReport } from "../../apps/web/src/telemetry/client";
import { createErrorReporter, describeError } from "../../apps/web/src/telemetry/errors";
import {
  attackPerMinute,
  createGameTracker,
  isNewBest,
  modeName,
  piecesPerSecond,
  type SoloStats,
  type VersusStats,
} from "../../apps/web/src/telemetry/tracker";

interface Seen {
  events: { kind: string; payload: unknown }[];
  games: GameReport[];
  history: { kind: string; value: number | undefined; detail: unknown }[];
}

function setup(playerId: string | null = "player-id-0001", start = 1_000_000) {
  const seen: Seen = { events: [], games: [], history: [] };
  let clock = start;
  const tracker = createGameTracker(
    {
      record: (kind, payload) => void seen.events.push({ kind, payload }),
      recordGame: (game) => void seen.games.push(game),
      recordHistory: (kind, value, detail) => void seen.history.push({ kind, value, detail }),
    },
    () => playerId,
    () => clock,
  );
  return {
    seen,
    tracker,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const solo = (over: Partial<SoloStats> = {}): SoloStats => ({
  mode: "endless",
  score: 4200,
  lines: 31,
  pieces: 120,
  playMs: 60_000,
  cleared: false,
  ...over,
});

const versus = (over: Partial<VersusStats> = {}): VersusStats => ({
  kind: "vs",
  submode: "battle",
  seat: 0,
  bots: 1,
  botLevel: 6,
  lines: 40,
  score: 9000,
  pieces: 150,
  ms: 90_000,
  matchMs: 120_000,
  attack: 60,
  matchId: null,
  ...over,
});

describe("rates and names", () => {
  it("computes pieces per second and attack per minute, or nothing without time", () => {
    expect(piecesPerSecond(120, 60_000)).toBe(2);
    expect(piecesPerSecond(5, 0)).toBeUndefined();
    expect(attackPerMinute(60, 90_000)).toBe(40);
    expect(attackPerMinute(1, 0)).toBeUndefined();
  });

  it("makes mode names the server accepts", () => {
    expect(modeName("vs", "battle")).toBe("vs-battle");
    expect(modeName("Online", "W!de")).toBe("online-wde");
    expect(modeName("x".repeat(40))).toHaveLength(24);
    expect(modeName("!!!")).toBe("unknown");
  });

  it("follows the page's rule for a new best", () => {
    expect(isNewBest(solo(), null)).toBe(true);
    expect(isNewBest(solo(), { s: 5000, t: 0 })).toBe(false);
    expect(isNewBest(solo({ score: 0 }), null)).toBe(false);
    expect(isNewBest(solo({ mode: "practice" }), null)).toBe(false);
    expect(
      isNewBest(solo({ mode: "sprint", cleared: true, playMs: 50_000 }), { s: 0, t: 60_000 }),
    ).toBe(true);
    expect(
      isNewBest(solo({ mode: "sprint", cleared: true, playMs: 70_000 }), { s: 0, t: 60_000 }),
    ).toBe(false);
    expect(isNewBest(solo({ mode: "sprint", cleared: false, playMs: 10_000 }), null)).toBe(false);
  });
});

describe("solo games", () => {
  it("reports a finished game with the player's own row and notes the start", () => {
    const { seen, tracker, advance } = setup();
    tracker.soloStarted("endless");
    advance(61_000);
    tracker.soloEnded(solo(), { s: 9000, t: 0 });
    expect(seen.events).toEqual([{ kind: "game_start", payload: { mode: "endless" } }]);
    expect(seen.games).toHaveLength(1);
    expect(seen.games[0]).toMatchObject({
      mode: "endless",
      startedAt: 1_000_000,
      durationMs: 60_000,
      players: [
        {
          playerId: "player-id-0001",
          seat: 0,
          result: "finished",
          lines: 31,
          score: 4200,
          pieces: 120,
          pps: 2,
        },
      ],
    });
    expect(seen.games[0]?.id).toBeUndefined();
    expect(seen.history).toEqual([]);
    expect(tracker.open()).toBeNull();
  });

  it("writes a personal best into the history", () => {
    const { seen, tracker } = setup();
    tracker.soloStarted("endless");
    tracker.soloEnded(solo(), null);
    expect(seen.history).toEqual([
      { kind: "personal_best", value: 4200, detail: { mode: "endless" } },
    ]);
  });

  it("stores a sprint best as the time, and a cleared sprint as a win", () => {
    const { seen, tracker } = setup();
    tracker.soloStarted("sprint");
    tracker.soloEnded(solo({ mode: "sprint", cleared: true, playMs: 48_500, lines: 40 }), null);
    expect(seen.games[0]?.players[0]?.result).toBe("win");
    expect(seen.history[0]).toMatchObject({ kind: "personal_best", value: 48_500 });
  });

  it("calls a sprint that ended before the target a loss, and practice finished", () => {
    const { seen, tracker } = setup();
    tracker.soloStarted("sprint");
    tracker.soloEnded(solo({ mode: "sprint", lines: 12 }), null);
    tracker.soloStarted("practice");
    tracker.soloEnded(solo({ mode: "practice" }), null);
    expect(seen.games.map((g) => g.players[0]?.result)).toEqual(["loss", "finished"]);
    expect(seen.history).toEqual([]);
  });

  it("reports a game left through the menu as quit, once", () => {
    const { seen, tracker } = setup();
    tracker.soloStarted("ultra");
    tracker.soloQuit(solo({ mode: "ultra" }));
    tracker.soloQuit(solo({ mode: "ultra" }));
    expect(seen.games).toHaveLength(1);
    expect(seen.games[0]?.players[0]?.result).toBe("quit");
  });

  it("does not report a quit with no piece played, nor a quit with no game open", () => {
    const { seen, tracker } = setup();
    tracker.soloStarted("endless");
    tracker.soloQuit(solo({ pieces: 0 }));
    tracker.soloQuit(solo());
    expect(seen.games).toEqual([]);
  });

  it("reports a resumed game that ended without a noted start, dated back by its play time", () => {
    const { seen, tracker } = setup(undefined, 5_000_000);
    tracker.soloEnded(solo({ playMs: 30_000 }), null);
    expect(seen.games[0]?.startedAt).toBe(4_970_000);
  });

  it("reports nothing without an identity", () => {
    const { seen, tracker } = setup(null);
    tracker.soloStarted("endless");
    tracker.soloEnded(solo(), null);
    expect(seen.games).toEqual([]);
  });

  it("restarting while a game is open does not leak it: the next quit has its own start", () => {
    const { seen, tracker, advance } = setup();
    tracker.soloStarted("endless");
    advance(10_000);
    tracker.soloQuit(solo());
    tracker.soloStarted("endless");
    advance(5_000);
    tracker.soloQuit(solo());
    expect(seen.games.map((g) => g.startedAt)).toEqual([1_000_000, 1_010_000]);
  });
});

describe("versus games", () => {
  it("reports a local match with bots, the player's own row and rates", () => {
    const { seen, tracker, advance } = setup();
    tracker.versusStarted("vs", "battle");
    advance(100_000);
    tracker.versusEnded(versus(), true);
    expect(seen.events).toEqual([{ kind: "game_start", payload: { mode: "vs-battle" } }]);
    expect(seen.games[0]).toMatchObject({
      mode: "vs-battle",
      startedAt: 1_000_000,
      durationMs: 120_000,
      bots: 1,
      botLevel: 6,
      players: [{ playerId: "player-id-0001", seat: 0, result: "win", pps: 1.67, apm: 40 }],
    });
    expect(seen.games[0]?.id).toBeUndefined();
  });

  it("gives every page of an online match the same game id", () => {
    const a = setup("player-aaaaaaaa");
    const b = setup("player-bbbbbbbb");
    for (const t of [a, b]) {
      t.tracker.versusStarted("online", "battle");
    }
    a.tracker.versusEnded(
      versus({ kind: "online", bots: 0, botLevel: undefined, matchId: "m0123456789abcdef" }),
      true,
    );
    b.tracker.versusEnded(
      versus({
        kind: "online",
        bots: 0,
        botLevel: undefined,
        matchId: "m0123456789abcdef",
        seat: 1,
      }),
      false,
    );
    expect(a.seen.games[0]?.id).toBe("m0123456789abcdef");
    expect(b.seen.games[0]?.id).toBe("m0123456789abcdef");
    expect(a.seen.games[0]?.mode).toBe("online-battle");
    expect(b.seen.games[0]?.players[0]).toMatchObject({
      playerId: "player-bbbbbbbb",
      seat: 1,
      result: "loss",
    });
    expect(a.seen.games[0]?.bots).toBeUndefined();
  });

  it("reports a match left through the menu as quit, and nothing when no piece was played", () => {
    const { seen, tracker } = setup();
    tracker.versusStarted("vs", "sprint");
    tracker.versusQuit(versus({ pieces: 0 }));
    tracker.versusStarted("vs", "sprint");
    tracker.versusQuit(versus());
    expect(seen.games).toHaveLength(1);
    expect(seen.games[0]?.players[0]?.result).toBe("quit");
  });

  it("keeps the seat and the bot count in range", () => {
    const { seen, tracker } = setup();
    tracker.versusStarted("vs", "wide");
    tracker.versusEnded(versus({ seat: 9, bots: 7 }), false);
    expect(seen.games[0]?.players[0]?.seat).toBe(3);
    expect(seen.games[0]?.bots).toBe(3);
  });

  it("knows which kind of game is open", () => {
    const { tracker } = setup();
    expect(tracker.open()).toBeNull();
    tracker.soloStarted("endless");
    expect(tracker.open()).toBe("solo");
    tracker.soloQuit(solo({ pieces: 0 }));
    tracker.versusStarted("vs", "battle");
    expect(tracker.open()).toBe("versus");
  });
});

describe("script errors", () => {
  function failure(): Error {
    const error = new TypeError(
      "Cannot read properties of undefined (reading 'x') for room abcdef0123456789abcdef",
    );
    error.stack = [
      "TypeError: boom",
      "    at frame (https://example.test/assets/game-1a2b3c.js:412:19)",
      "    at tick (https://example.test/assets/game-1a2b3c.js:77:3)",
    ].join("\n");
    return error;
  }

  it("keeps the name, a short message without long tokens, the place and a hash", () => {
    const d = describeError(failure());
    expect(d.name).toBe("TypeError");
    expect(d.message).toContain("Cannot read properties");
    expect(d.message).not.toContain("abcdef0123456789abcdef");
    expect(d.where).toBe("game-1a2b3c.js:412");
    expect(d.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(describeError(failure()).hash).toBe(d.hash);
  });

  it("sends no path or address", () => {
    expect(JSON.stringify(describeError(failure()))).not.toContain("example.test");
  });

  it("describes strings, plain objects and nothing", () => {
    expect(describeError("plain text").message).toBe("plain text");
    expect(describeError({ name: "Custom", message: "m" }).name).toBe("Custom");
    expect(describeError(undefined, "Script error.").message).toBe("Script error.");
  });

  it("limits the message length", () => {
    expect(describeError(new Error("x ".repeat(500))).message.length).toBeLessThanOrEqual(120);
  });

  it("reports each distinct error once and at most five per page load", () => {
    const seen: unknown[] = [];
    const reporter = createErrorReporter({ record: (_kind, payload) => void seen.push(payload) });
    expect(reporter.report(failure())).toBe(true);
    expect(reporter.report(failure())).toBe(false);
    for (let i = 0; i < 10; i++) {
      const other = new Error(`different ${i}`);
      other.stack = `Error: x\n    at somewhere (https://example.test/a/file-${i}.js:${i + 1}:1)`;
      reporter.report(other);
    }
    expect(seen).toHaveLength(5);
  });
});
