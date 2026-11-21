// @ts-nocheck
/**
 * Connects the page to the telemetry client: turns the page's own moments (a game
 * starting, ending or being left, a script error, an install, an update) into telemetry items.
 * The rules for what is reported live in `telemetry/tracker.ts` and `telemetry/errors.ts`; this
 * file only reads the page's state and hands it over. Nothing here changes how the game plays.
 * The client starts at the end of this file, through `startPageTelemetry`. Until it has started
 * `pageTelemetry()` is null and every call below does nothing.
 */
import { playerIdFromKey } from "@tetrizz/protocol";
import { SPRINT_LINES, configState } from "../core/config";
import { clock } from "../core/clock";
import { onBefore, onEvent } from "../core/events";
import { frameStats, perfState } from "../core/metrics";
import { game } from "../game/state";
import { onlineSessionState } from "../net/online-session";
import { playerKey } from "../net/identity";
import { bestFor } from "../ui/settings";
import { MP, giOf, versusLobbyState } from "../versus/lobby";
import { pageTelemetry, startPageTelemetry } from "../telemetry";
import { matchGameId } from "../telemetry/address";
import { createErrorReporter } from "../telemetry/errors";
import { createGameTracker } from "../telemetry/tracker";

const SOLO_MODES = new Set(["endless", "sprint", "ultra", "practice"]);
const MATCH_STAMP_MAX_AGE_MS = 120_000;
const PERF_MIN_FRAMES = 120;

const sink = {
  record: (kind, payload) => pageTelemetry()?.record(kind, payload),
  recordGame: (report) => pageTelemetry()?.recordGame(report),
  recordHistory: (kind, value, detail) => pageTelemetry()?.recordHistory(kind, value, detail),
};

let cachedPlayerId;
function ownPlayerId() {
  if (cachedPlayerId === undefined) {
    const key = playerKey();
    cachedPlayerId = key ? playerIdFromKey(key) : null;
  }
  return cachedPlayerId;
}

const tracker = createGameTracker(sink, ownPlayerId, () => clock.wall());
const errors = createErrorReporter(sink);

const soloActive = () => !versusLobbyState.vsActive && SOLO_MODES.has(configState.mode);

function readSolo() {
  return {
    mode: configState.mode,
    score: game.score,
    lines: game.lines,
    pieces: game.pieces,
    playMs: game.playMs,
    cleared: configState.mode === "sprint" && game.lines >= SPRINT_LINES,
  };
}

/** The player's own numbers for the running match, or null when this page has no human on board 1. */
function readVersus(roundInProgress, matchId) {
  const own = MP.stations[0];
  if (!own || own.isBot) return null;
  const totals = (st) => {
    const c = MP.cum[st.slot] || {};
    const live = roundInProgress && st.alive !== undefined ? st : null;
    return {
      lines: (c.lines || 0) + (live ? live.lines || 0 : 0),
      pieces: (c.pieces || 0) + (live ? live.pieces || 0 : 0),
      score: (c.score || 0) + (live ? live.score || 0 : 0),
      ms: (c.ms || 0) + (live ? Math.round(live.timeMs || 0) : 0),
      atk: (c.atk || 0) + (live ? live.sent || 0 : 0),
    };
  };
  const mine = totals(own);
  const bots = MP.stations.filter((st) => st.isBot && !onlineSessionState.onlineRemote.has(st.idx));
  let botLevel;
  if (bots.length > 0) {
    const cfg = versusLobbyState.vs.players[bots[0].slot];
    const level = cfg && typeof cfg.diff === "number" ? cfg.diff : versusLobbyState.vs.diff;
    if (typeof level === "number") botLevel = level;
  }
  return {
    kind: onlineSessionState.isOnlineGame ? "online" : "vs",
    submode: versusLobbyState.vs.submode,
    seat: own.slot,
    bots: bots.length,
    botLevel,
    lines: mine.lines,
    score: mine.score,
    pieces: mine.pieces,
    ms: mine.ms,
    matchMs: Math.max(...MP.stations.map((st) => totals(st).ms)),
    attack: mine.atk,
    matchId,
  };
}

/** The shared id of the online match that is starting, from the host's stamp; null when unknown. */
function takeMatchId() {
  const stamp = onlineSessionState.onlineMatchStamp;
  onlineSessionState.onlineMatchStamp = null;
  if (!onlineSessionState.isOnlineGame || !stamp) return null;
  if (Math.abs(clock.wall() - stamp.ts) > MATCH_STAMP_MAX_AGE_MS) return null;
  return matchGameId({
    room: String(onlineSessionState.onlineRoomId ?? ""),
    stamp: stamp.ts,
    order: stamp.order,
  });
}

function perfSample(mode) {
  const f = frameStats();
  if (f.frames < PERF_MIN_FRAMES) return;
  const tenth = (n) => Math.round(n * 10) / 10;
  sink.record("perf_sample", {
    mode,
    fps: Math.round(f.fps),
    medianMs: tenth(f.medianMs),
    p95Ms: tenth(f.p95Ms),
    maxMs: Math.round(f.maxMs),
    thinkMs: tenth(f.thinkMs),
    tier: perfState.tier,
  });
}

let previousBest = null;
let matchId = null;

onBefore("startCountdown", () => {
  if (tracker.open() === "solo") tracker.soloQuit(readSolo());
});

onEvent("startCountdown", () => {
  if (soloActive()) tracker.soloStarted(configState.mode);
});

onBefore("gameOver", () => {
  previousBest = soloActive() ? bestFor(configState.mode) : null;
});

onEvent("gameOver", () => {
  if (!soloActive()) return;
  tracker.soloEnded(readSolo(), previousBest);
  perfSample(configState.mode);
});

onEvent("vsStartMatch", () => {
  if (onlineSessionState.isSpectator || !versusLobbyState.vsActive) return;
  matchId = takeMatchId();
  tracker.versusStarted(
    onlineSessionState.isOnlineGame ? "online" : "vs",
    versusLobbyState.vs.submode,
  );
});

onEvent("vsMatchEnd", (winnerGi) => {
  if (tracker.open() !== "versus") return;
  const stats = readVersus(false, matchId);
  if (!stats) return;
  tracker.versusEnded(stats, giOf(MP.stations[0]) === winnerGi);
  perfSample(`${stats.kind}-${stats.submode}`);
});

function quitVersus() {
  const stats = readVersus(!versusLobbyState.vsRoundOver && !versusLobbyState.vsMatchOver, matchId);
  if (stats) tracker.versusQuit(stats);
}

onBefore("quitToMenu", () => {
  const open = tracker.open();
  if (open === "solo") tracker.soloQuit(readSolo());
  else if (open === "versus") quitVersus();
});

// Leaving an online room clears the room's state before it quits to the menu, so the page's own
// numbers are read here, while the room is still whole.
onBefore("leaveOnlineRoom", () => {
  if (tracker.open() === "versus") quitVersus();
});

window.addEventListener("error", (event) =>
  errors.report(event.error ?? event.message, event.message),
);
window.addEventListener("unhandledrejection", (event) =>
  errors.report(event.reason, "Unhandled rejection"),
);
onEvent("roomEntered", ({ how, backend }) =>
  sink.record(how === "create" ? "room_create" : "room_join", { backend }),
);

window.addEventListener("appinstalled", () => sink.record("install"));

if ("serviceWorker" in navigator) {
  const wasControlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (wasControlled) sink.record("update_applied");
  });
}

void startPageTelemetry();
