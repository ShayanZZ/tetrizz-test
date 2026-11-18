// @ts-nocheck
import { PIECES } from "@tetrizz/core";
import { configState } from "../core/config";
import { game } from "../game/state";
import {
  hideAllOverlays,
  startCountdown,
  doHold,
  softStep,
  hardDrop,
  showScreen,
  togglePause,
  gameOver,
} from "../game/game";
import { openInstallPop } from "../ui/install";
import { movePiece, tryRotate } from "../render/render";
import { selectMode, snapOpts } from "../ui/settings";
import { loadVs, versusLobbyState, MP } from "../versus/lobby";
import { vsStartMatch } from "../versus/rounds";
import { $ } from "../ui/layout";
import { rpEntryData } from "../replay/replay";

/** The options snapshot as v1.2.0 produced it: without the settings added after that release. */
function legacyOptsSnapshot(): string {
  const opts = JSON.parse(snapOpts());
  delete opts.motion;
  delete opts.onlineBackend;
  delete opts.adaptive;
  return JSON.stringify(opts);
}

const hash = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
};

/**
 * Replaces the regression harness's `window.__h` with accessors bound to this build's modules.
 * It does nothing unless the harness has already created `window.__h`, so normal pages never
 * expose internals.
 */
export function installHarnessHook() {
  if (!window.__h) return;
  window.__h = {
    startSolo(m) {
      selectMode(m);
      hideAllOverlays();
      startCountdown();
    },
    act(name, arg) {
      if (name === "move") return movePiece(arg);
      if (name === "rotate") return tryRotate(arg);
      if (name === "hold") return doHold();
      if (name === "soft") return softStep();
      if (name === "drop") return hardDrop();
    },
    snap() {
      return {
        state: game.state,
        mode: configState.mode,
        score: game.score,
        lines: game.lines,
        level: game.level,
        combo: game.combo,
        maxCombo: game.maxCombo,
        b2b: game.b2bChain,
        pieces: game.pieces,
        hold: game.hold === null ? -1 : game.hold,
        cur: game.piece ? game.piece.type : -1,
        px: game.piece ? game.piece.x : -1,
        rot: game.piece ? game.piece.rot : -1,
        board: hash(JSON.stringify(game.board)),
      };
    },
    startVs(cfg) {
      localStorage.setItem("tetris_vsbot", JSON.stringify(cfg));
      loadVs();
      selectMode("vsbot");
      hideAllOverlays();
      vsStartMatch();
    },
    vsSnap() {
      return {
        state: game.state,
        active: !!versusLobbyState.vsActive,
        round: versusLobbyState.vsRound,
        wins: MP.wins.slice(0, 4),
        stations: MP.stations.map((st) => ({
          pieces: st.pieces,
          timeMs: Math.round(st.timeMs),
          lines: st.lines,
          alive: st.alive,
          isBot: !!st.isBot,
        })),
      };
    },
    async profileSummary() {
      const txt = (n) => {
        showScreen($("ovStart"), n);
        const s = document.querySelector(".menu-screen.active");
        return s ? s.innerText.replace(/\s+/g, " ").trim() : "";
      };
      const list = JSON.parse(localStorage.getItem("tetris_replays") || "[]");
      const replays = [];
      for (const r of list) {
        const d = await rpEntryData(r);
        replays.push({
          id: r.id,
          dur: r.dur,
          nR: r.nR,
          rounds: d ? d.rounds.length : -1,
          frames: d ? d.rounds.reduce((a, x) => a + x.frames.length, 0) : -1,
        });
      }
      return {
        opts: legacyOptsSnapshot(),
        mode: configState.mode,
        scoresText: txt("scores"),
        replaysText: txt("replays"),
        replays,
      };
    },
    showScreen(name) {
      showScreen($("ovStart"), name);
    },
    openInstallPop() {
      openInstallPop();
    },
    togglePause() {
      togglePause();
    },
    gameOver() {
      gameOver();
    },
    shapes() {
      return PIECES.map((p) => p.cells);
    },
    board() {
      return JSON.parse(JSON.stringify(game.board));
    },
  };
}
