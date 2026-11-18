// @ts-nocheck
import { clock } from "../core/clock";
import { escapeHtml } from "../core/escape";
import {
  HID,
  LOCK_MS,
  MOBILE,
  SPRINT_LINES,
  ULTRA_MS,
  clamp,
  colsForMode,
  configState,
  visForMode,
} from "../core/config";
import { emitEvent, emitBefore } from "../core/events";
import { rgba } from "../render/theme";
import { bindingsState } from "../input/bindings";
import { game } from "../game/state";
import {
  SFX,
  emptyRow,
  findFullRows,
  gravMsFor,
  levelForLines,
  spliceRows,
} from "../engine/engine";
import {
  $,
  applyGeometry,
  cancelRestartHold,
  layout,
  layoutSoon,
  layoutState,
  trackHdr,
} from "../ui/layout";
import { hideAction, updateParticlesArr } from "../render/render";
import {
  cancelGoText,
  clearInput,
  gameState,
  hideAllOverlays,
  openOverlay,
  syncPad,
  syncPanels,
  syncVsPlay,
} from "../game/game";
import { fitAllStats, fmtTime, fmtTimeP, presetScoreFont, setText } from "../ui/menus";
import { syncPracticeButtons, syncVsButtons, updateModeCards } from "../ui/settings";
import { PLAYER_COLORS } from "../ui/brand";
import {
  MP,
  buildMpChips,
  giOf,
  giOfSlot,
  mpBuildStations,
  mpClearInputs,
  sanitizePlayers,
  saveVs,
  tickGarbage,
  versusLobbyState,
  vsGarbageMode,
} from "./lobby";
import {
  consumeIdx,
  ensureStream,
  insertActiveIdx,
  refreshQueuesAll,
  setMpGauges,
  stTopOut,
} from "./garbage";
import {
  drawStHold,
  drawStNexts,
  hideStAction,
  mpBannerAll,
  renderStation,
  stBanner,
  stBannerStay,
  stCheckDanger,
  stCollide,
  stEnter,
  stHumanStep,
  stLevelPanelShow,
  stPull,
  stUpdateLevelPanel,
  stUpdateStats,
} from "./stations";
import { botPull, botStep } from "../bot/bot-control";
import { onlineSessionState } from "../net/online-session";
import { resetOnlineReady, spectatorStartWatching } from "../net/online-lobby";
import { mulberry32 } from "@tetrizz/core";

export function layoutMp(slot) {
  if (!versusLobbyState.vsActive || !MP.stations.length) return;
  if (MP.stations[0]) {
    MP.stations[0].cellPx = game.CELL;
    if (MP.stations[0].wrapEl) MP.stations[0].wrapEl.style.setProperty("--bcell", game.CELL + "px");
    presetScoreFont(MP.stations[0].scoreEl, vsGarbageMode() ? "999" : "9,999,999,999");
  }
  for (let i = 1; i < MP.n; i++) {
    const st = MP.stations[i];
    if (!st || !st.wrapEl) continue;
    const bw = st.wrapEl.clientWidth;
    if (bw < 4) continue;
    st.cellPx = bw / Math.max(1, configState.COLS);
    const bh = st.cellPx * configState.ROWS;
    st.cvEl.style.width = bw + "px";
    st.cvEl.style.height = bh + 2 * st.cellPx + "px";
    st.cvEl.style.top = -(HID + 2) * st.cellPx + "px";
    const _sw = Math.round(bw * layoutState.dpr),
      _sh = Math.round((bh + 2 * st.cellPx) * layoutState.dpr);
    if (st.cvEl.width !== _sw) st.cvEl.width = _sw;
    if (st.cvEl.height !== _sh) st.cvEl.height = _sh;
    st.wrapEl.style.setProperty("--bcell", st.cellPx + "px");
    if (MOBILE.matches && !document.body.classList.contains("splitMob"))
      st.wrapEl.style.height = st.cellPx * configState.VIS + "px";
    else st.wrapEl.style.height = "";
    const sl = Math.max(2, Math.round(2.4 * (st.cellPx || game.MINI)));
    st.nextItems.forEach((it) => {
      it.style.height = sl + "px";
    });
    if (st.holdCv) st.holdCv.style.height = sl + "px";
    [st.holdCv].concat(st.nextCvs).forEach((cv) => {
      if (!cv) return;
      const q = cv.getBoundingClientRect();
      cv.width = Math.max(1, Math.round(q.width * layoutState.dpr));
      cv.height = Math.max(1, Math.round(q.height * layoutState.dpr));
    });
    presetScoreFont(st.scoreEl, vsGarbageMode() ? "999" : "9,999,999,999");
    stUpdateLevelPanel(st);
    stLevelPanelShow(st);
    drawStHold(st);
    drawStNexts(st);
    renderStation(st);
  }
  if (MP.stations[0]) {
    drawStHold(MP.stations[0]);
    drawStNexts(MP.stations[0]);
    stUpdateLevelPanel(MP.stations[0]);
    stLevelPanelShow(MP.stations[0]);
  }
}

export function mpBattleWinner() {
  const alive = MP.stations.filter((s) => s.alive);
  if (alive.length === 1) return alive[0];
  if (alive.length > 1) return alive[0];
  const dead = MP.stations
    .slice()
    .sort((a, b) => b.deathAt - a.deathAt || b.score - a.score || a.slot - b.slot);
  return dead.length ? dead[0] : MP.stations[0];
}

export function vsStartMatch() {
  emitBefore("vsStartMatch");
  vsStartMatchBody();
  emitEvent("vsStartMatch");
}

function vsStartMatchBody() {
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) {
    spectatorStartWatching();
    return;
  }
  saveVs();
  sanitizePlayers();
  const maxSlots =
    MOBILE.matches &&
    !(onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame)
      ? 2
      : 4;
  const act = [];
  for (let i = 0; i < maxSlots; i++) {
    if (versusLobbyState.vs.players[i].type !== "off")
      act.push({ p: versusLobbyState.vs.players[i], i: i });
  }
  if (MOBILE.matches && act.length && act[0].p.type === "bot") {
    const uIdx = act.findIndex((o) => o.p.type === "user");
    if (uIdx > 0) {
      const u = act.splice(uIdx, 1)[0];
      act.unshift(u);
    }
  }
  versusLobbyState.vsActive = true;
  versusLobbyState.vsMatchOver = false;
  versusLobbyState.vsRoundOver = false;
  versusLobbyState.vsRound =
    typeof versusLobbyState._vsPendingRound === "number" ? versusLobbyState._vsPendingRound : 1;
  versusLobbyState._vsPendingRound = null;
  if (onlineSessionState.isOnlineGame === undefined || !onlineSessionState.isOnlineGame) {
    document.body.classList.remove("online-play", "onlineMulti", "onlineMulti3", "onlineMulti4");
  }
  document.body.classList.remove("matchover");
  MP.wins = [0, 0, 0, 0];
  MP.cum = [0, 1, 2, 3].map(() => ({
    lines: 0,
    pieces: 0,
    ms: 0,
    combo: 0,
    score: 0,
    atk: 0,
    recv: 0,
    lvl: 1,
  }));
  configState.COLS = colsForMode("vsbot");
  configState.VIS = visForMode("vsbot");
  configState.ROWS = configState.VIS + HID;
  applyGeometry();
  mpBuildStations(act);
  document.body.style.setProperty("--mpN", String(MOBILE.matches ? 1 : MP.n));
  buildMpChips();
  const vf = $("vsFinal");
  if (vf) vf.style.display = "none";
  syncVsPlay();
  layout();
  layoutMp();
  layoutSoon(80);
  layoutSoon(350);
  layoutSoon(700);
  vsBeginRound();
}

function resetStationRound(st) {
  st.board = Array.from({ length: configState.ROWS }, emptyRow);
  st.hold = null;
  st.holdUsed = false;
  st.holdAge = 0;
  st.piece = null;
  st.score = 0;
  st.lines = 0;
  st.level = levelForLines("vsbot", 0);
  st.combo = -1;
  st.maxCombo = 0;
  st.b2b = 0;
  st.pieces = 0;
  st.sent = 0;
  st.recv = 0;
  st.gravT = 0;
  st.gravMs = gravMsFor("vsbot", 1);
  st.plan = null;
  st.topActions = [];
  st.execIdx = 0;
  st.topAcc = 0;
  st.spinDone = false;
  st.spinAt = 0;
  st.bottomFail = 0;
  st.stallDir = 1;
  st.thinkGen = null;
  st.spec = null;
  st.alive = true;
  st.deathAt = 0;
  st.timeMs = 0;
  st.lastSpin = null;
  st.particles.length = 0;
  st.fx.x = st.fx.y = st.fx.rot = st.fx.vx = st.fx.vy = st.fx.vr = 0;
  st.in.left = st.in.right = st.in.down = false;
  st.in.dir = 0;
  st.in.dasT = st.in.arrT = 0;
  if (st.scoreEl) st.scoreEl.style.fontSize = "";
  [st.levelEl, st.linesEl, st.timeEl, st.piecesEl, st.ppsEl].forEach((el) => {
    if (el) el.style.fontSize = "";
  });
  if (st.wrapEl) st.wrapEl.classList.remove("danger", "garbage-hit", "lost");
  if (st.comboEl) st.comboEl.classList.remove("show");
  if (st.b2bEl) {
    st.b2bEl.classList.remove("show", "hot", "blaze", "inferno", "storm", "mythic");
    st.b2bEl.dataset.n = "";
  }
  hideStAction(st);
  refreshQueuesAll();
  if (st.left) {
    st.alive = false;
    st.piece = null;
    st.plan = null;
    st.thinkGen = null;
    st.spec = null;
    if (st.wrapEl) {
      st.wrapEl.classList.add("lost");
      st.wrapEl.classList.remove("danger");
    }
  } else {
    st.alive = true;
    if (st.isBot) {
      if (!onlineSessionState.onlineRemote.has(st.idx)) {
        versusLobbyState.bot = st;
        botPull();
      } else {
        const _rstPid =
          onlineSessionState.onlineSlotToPid !== undefined && onlineSessionState.onlineSlotToPid
            ? onlineSessionState.onlineSlotToPid[st.slot]
            : null;
        const _rstPl = _rstPid
          ? onlineSessionState.onlinePlayersList.find(function (q) {
              return q.id === _rstPid;
            })
          : null;
        const _rstDisc =
          _rstPl && _rstPl.state && (_rstPl.state.conn === "lost" || _rstPl.state.conn === "gone");
        if (_rstDisc) {
          stPull(st, true);
        }
      }
    } else {
      stPull(st, true);
    }
  }
  drawStHold(st);
  drawStNexts(st);
  stCheckDanger(st);
  stUpdateStats(st);
}

export function vsBeginRound() {
  emitBefore("vsBeginRound");
  vsBeginRoundBody();
  emitEvent("vsBeginRound");
}

function vsBeginRoundBody() {
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) {
    versusLobbyState.vsRoundOver = false;
    versusLobbyState.vsTime = 0;
    versusLobbyState.vsBannerUntil = clock.now() + 1150;
    versusLobbyState.vsCountdownStarted = false;
    game.countdownRemaining = 0;
    game.countdownPhase = "";
    for (const st of MP.stations) {
      st.board = Array.from({ length: configState.ROWS }, emptyRow);
      st.piece = null;
      st.queue = [];
      st.particles = [];
      st.alive = true;
      st.left = false;
      st.sent = 0;
      st.lines = 0;
      st.score = 0;
      st.pieces = 0;
      st.combo = -1;
      st.b2b = 0;
      st.hold = null;
      st.holdUsed = false;
      st.timeMs = 0;
      if (st.wrapEl) st.wrapEl.classList.remove("lost", "danger");
      hideStAction(st);
      drawStHold(st);
      drawStNexts(st);
    }
    mpBannerAll("ROUND " + versusLobbyState.vsRound, "#2a93a8", "round");
    game.state = "countdown";
    setMpGauges();
    vsUpdateHud();
    return;
  }
  clearTimeout(versusLobbyState.vsRoundT);
  versusLobbyState.vsRoundOver = false;
  versusLobbyState.vsTime = 0;
  versusLobbyState.vsHudT = 0;
  document.body.classList.remove("matchover");
  versusLobbyState.sharedStream.length = 0;

  if (
    onlineSessionState.isOnlineGame !== undefined &&
    onlineSessionState.isOnlineGame &&
    onlineSessionState.onlineSeed
  ) {
    onlineSessionState.onlineRng = mulberry32(
      (onlineSessionState.onlineSeed ^ Math.imul(versusLobbyState.vsRound, 2654435761)) >>> 0,
    );
  }
  for (let i = 0; i < MP.n; i++) {
    MP.ptrs[i] = 0;
    MP.qs[i] = [];
    MP.lastHole[i] = -1;
  }
  for (const st of MP.stations) resetStationRound(st);
  game.state = "countdown";
  hideAllOverlays();
  bindingsState.openOverlayEl = null;
  syncPad();
  game.lastTs = clock.now();
  game.countdownRemaining = 0;
  game.countdownPhase = "";
  versusLobbyState.vsCountdownStarted = false;
  versusLobbyState.vsBannerUntil = clock.now() + 1150;
  mpBannerAll("ROUND " + versusLobbyState.vsRound, "#2a93a8", "round");
  vsUpdateHud();
  setMpGauges();
  trackHdr(450);
}

export function vsRoundEnd(winnerSlot) {
  emitBefore("vsRoundEnd", winnerSlot);
  vsRoundEndBody(winnerSlot);
  emitEvent("vsRoundEnd", winnerSlot);
}

function vsRoundEndBody(winnerSlot) {
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) return;
  if (versusLobbyState.vsRoundOver || versusLobbyState.vsMatchOver) return;
  versusLobbyState.vsRoundOver = true;
  cancelRestartHold();
  clearInput();
  mpClearInputs();
  game.state = "vsround";
  for (const st of MP.stations) {
    st.piece = null;
    st.plan = null;
    st.thinkGen = null;
    st.spec = null;
    const c = MP.cum[st.slot];
    c.lines += st.lines;
    c.pieces += st.pieces;
    c.ms += Math.round(st.timeMs);
    c.combo = Math.max(c.combo, st.maxCombo);
    c.score += st.score;
    c.atk = (c.atk || 0) + (st.sent || 0);
    c.recv = (c.recv || 0) + (st.recv || 0);
    c.lvl = Math.max(c.lvl || 1, st.level);
  }
  const winnerGi = giOfSlot(winnerSlot);
  MP.wins[winnerGi]++;
  for (const st of MP.stations)
    stBanner(
      st,
      st.slot === winnerSlot ? "ROUND WON" : "ROUND LOST",
      st.slot === winnerSlot ? "#4fe08a" : "#f5546b",
      "round",
    );
  const wCfg = versusLobbyState.vs.players[winnerSlot];
  if (wCfg && wCfg.type === "user") SFX.roundWin();
  else SFX.roundLose();
  syncVsPlay();
  vsUpdateHud();
  setMpGauges();
  clearTimeout(versusLobbyState.vsRoundT);
  versusLobbyState.vsRoundT = setTimeout(() => {
    if (MP.wins[winnerGi] >= versusLobbyState.vs.rounds) vsMatchEnd(winnerGi);
    else {
      versusLobbyState.vsRound++;
      vsBeginRound();
    }
  }, 2300);
}

export function vsMatchEnd(winnerGi) {
  vsMatchEndBody(winnerGi);
  emitEvent("vsMatchEnd", winnerGi);
}

function vsMatchEndBody(winnerGi) {
  onlineSessionState.onlineGameActive = false;
  versusLobbyState.vsMatchOver = true;
  game.state = "over";
  resetOnlineReady();
  for (const st of MP.stations) st.piece = null;
  document.body.classList.add("matchover");
  hideAction();
  clearInput();
  cancelGoText();
  syncPanels();
  syncVsPlay();
  const _wSt = MP.stations.find((s) => giOf(s) === winnerGi) || MP.stations[0];
  const slotWinner = _wSt ? _wSt.slot : 0;
  const cfg = versusLobbyState.vs.players[slotWinner] || { type: "bot" };
  const _on = onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame;
  const label = _wSt ? _wSt.label : (cfg.type === "bot" ? "B" : "P") + (slotWinner + 1);
  const color = _wSt ? _wSt.color : PLAYER_COLORS[slotWinner];
  const ot = $("overTitle");
  ot.textContent = label + " WINS";
  ot.style.color = color;
  ot.style.webkitTextFillColor = color;
  ot.style.textShadow = "0 0 30px " + rgba(color, 0.45);
  for (const st of MP.stations) {
    const won = giOf(st) === winnerGi;
    stBannerStay(st, won ? "VICTORY" : "DEFEAT", won ? "#4fe08a" : "#f5546b", "end");
  }
  $("bestLine").textContent = "";
  const vf = $("vsFinal");
  if (vf) {
    const rows = MP.stations
      .slice()
      .sort(
        (a, b) =>
          MP.wins[giOf(b)] - MP.wins[giOf(a)] || MP.cum[b.slot].score - MP.cum[a.slot].score,
      );
    vf.innerHTML = rows
      .map((st) => {
        const isBot = !_on && st.isBot;
        const lv = isBot ? botLevelForSlot(st.slot) : 0;
        const nameSuffix = isBot
          ? " (LV " + lv + ")"
          : _on
            ? !onlineSessionState.isSpectator && st.idx === 0
              ? " · YOU"
              : ""
            : st.isBot
              ? ""
              : " · HUMAN";
        const brief = vsBriefStats(st);
        return (
          '<div class="vfr' +
          (giOf(st) === winnerGi ? " win" : "") +
          '" data-slot="' +
          st.slot +
          '" title="Tap to see this player\'s details"><span class="lb2" style="color:' +
          st.color +
          '">' +
          escapeHtml(st.label) +
          nameSuffix +
          '</span><span class="st2">' +
          brief
            .map(
              (b) =>
                '<span class="st2u"><b class="st2v">' +
                b.v +
                '</b><span class="st2k">' +
                b.k +
                "</span></span>",
            )
            .join("") +
          "</span></div>"
        );
      })
      .join("");
    vf.style.display = "grid";
  }
  showEndStatsFor(slotWinner);
  updateModeCards();
  syncPracticeButtons();
  syncVsButtons();
  clearTimeout(gameState.goTextTimer);
  gameState.goTextTimer = setTimeout(() => {
    cancelGoText();
    if (game.state === "over") openOverlay($("ovOver"));
    window.dispatchEvent(new Event("resize"));
  }, 1500);
}

function botLevelForSlot(slot) {
  const p = versusLobbyState.vs.players[slot];
  return p && p.type === "bot" && typeof p.diff === "number" ? p.diff : versusLobbyState.vs.diff;
}

function vsCumOf(slot) {
  const c = MP.cum && MP.cum[slot] ? MP.cum[slot] : {};
  return {
    lines: c.lines || 0,
    pieces: c.pieces || 0,
    ms: c.ms || 0,
    combo: c.combo || 0,
    score: c.score || 0,
    atk: c.atk || 0,
    recv: c.recv || 0,
    lvl: c.lvl || 1,
  };
}

function fmtPpsC(c) {
  return c.ms > 0 ? (c.pieces / (c.ms / 1000)).toFixed(2) : "0.00";
}

function fmtApmC(c) {
  return c.ms > 0 ? ((c.atk * 60000) / c.ms).toFixed(1) : "0.0";
}

function vsBriefStats(st) {
  const c = vsCumOf(st.slot);
  const wins = MP.wins[giOf(st)];
  const sub = versusLobbyState.vs.submode;
  if (sub === "battle" || sub === "wide")
    return [
      { v: wins, k: "WINS" },
      { v: Math.round(c.atk), k: "ATK SENT" },
      { v: Math.round(c.recv), k: "ATK RECV" },
    ];
  if (sub === "sprint")
    return [
      { v: wins, k: "WINS" },
      { v: c.ms > 0 ? fmtTime(c.ms) : "—", k: "TIME" },
      { v: fmtPpsC(c), k: "PPS" },
    ];
  if (sub === "ultra")
    return [
      { v: wins, k: "WINS" },
      { v: Math.round(c.score).toLocaleString("en-US"), k: "SCORE" },
      { v: c.lines, k: "LINES" },
    ];
  return [
    { v: wins, k: "WINS" },
    { v: fmtTime(c.ms), k: "TIME" },
    { v: c.lvl, k: "LEVEL" },
  ];
}

function vsDetailStats(slot) {
  const st = MP.stations
    ? MP.stations.find(function (s) {
        return s.slot === slot;
      })
    : null;
  const c = vsCumOf(slot);
  const wins = st ? MP.wins[giOf(st)] : 0;
  const sub = versusLobbyState.vs.submode;
  let headline, stats;
  if (sub === "battle" || sub === "wide") {
    headline = { v: Math.round(c.atk), k: "TOTAL ATTACK SENT" };
    stats = [
      { v: Math.round(c.atk), k: "ATTACK SENT" },
      { v: Math.round(c.recv), k: "ATTACK RECEIVED" },
      { v: fmtApmC(c), k: "APM" },
      { v: wins, k: "WINS" },
      { v: c.lines, k: "LINES" },
      { v: Math.max(c.combo, 0), k: "MAX COMBO" },
      { v: fmtPpsC(c), k: "PPS" },
      { v: c.pieces, k: "PIECES" },
      { v: fmtTime(c.ms), k: "TIME" },
    ];
  } else if (sub === "sprint") {
    headline = { v: c.ms > 0 ? fmtTimeP(c.ms) : "—", k: "CLEAR TIME" };
    stats = [
      { v: wins, k: "WINS" },
      { v: c.lines, k: "LINES" },
      { v: c.pieces, k: "PIECES" },
      { v: fmtPpsC(c), k: "PPS" },
      { v: Math.max(c.combo, 0), k: "MAX COMBO" },
      { v: Math.round(c.score).toLocaleString("en-US"), k: "SCORE" },
      { v: c.lvl, k: "LEVEL" },
    ];
  } else if (sub === "ultra") {
    headline = { v: Math.round(c.score).toLocaleString("en-US"), k: "FINAL SCORE" };
    stats = [
      { v: wins, k: "WINS" },
      { v: c.lines, k: "LINES" },
      { v: c.pieces, k: "PIECES" },
      { v: fmtPpsC(c), k: "PPS" },
      { v: Math.max(c.combo, 0), k: "MAX COMBO" },
      { v: fmtTime(c.ms), k: "TIME" },
      { v: c.lvl, k: "LEVEL" },
    ];
  } else {
    headline = { v: fmtTime(c.ms), k: "SURVIVAL TIME" };
    stats = [
      { v: wins, k: "WINS" },
      { v: c.lvl, k: "LEVEL" },
      { v: c.lines, k: "LINES" },
      { v: c.pieces, k: "PIECES" },
      { v: fmtPpsC(c), k: "PPS" },
      { v: Math.round(c.score).toLocaleString("en-US"), k: "SCORE" },
      { v: Math.max(c.combo, 0), k: "MAX COMBO" },
    ];
  }
  return { headline: headline, stats: stats };
}

export function showEndStatsFor(slot) {
  if (!MP.stations || !MP.stations.length) return;
  const st = MP.stations.find(function (s) {
    return s.slot === slot;
  });
  if (!st) return;
  const d = vsDetailStats(slot);
  $("finalScore").textContent = d.headline.v;
  $("bestLine").textContent = d.headline.k;
  const ids = [
    ["fLevel", "fLevelK"],
    ["fLines", "fLinesK"],
    ["fCombo", "fComboK"],
    ["fTime", "fTimeK"],
    ["fPieces", "fPiecesK"],
    ["fPps", "fPpsK"],
    ["fX1", "fX1K"],
    ["fX2", "fX2K"],
    ["fX3", "fX3K"],
  ];
  const boxes = document.querySelectorAll("#ovOver .gstats .gs");
  for (let i = 0; i < ids.length; i++) {
    const ve = $(ids[i][0]);
    const ke = $(ids[i][1]);
    const box = boxes[i];
    if (i < d.stats.length) {
      if (ve) ve.textContent = d.stats[i].v;
      if (ke) ke.textContent = d.stats[i].k;
      if (box) box.style.display = "";
    } else {
      if (box) box.style.display = "none";
    }
  }
  document.querySelectorAll("#vsFinal .vfr").forEach(function (el) {
    el.classList.toggle("sel", +el.dataset.slot === slot);
  });
}

export function pingClass(ms) {
  return ms < 100 ? "ping-good" : ms < 200 ? "ping-mid" : ms < 300 ? "ping-bad" : "ping-bad2";
}

export function updatePings() {
  if (!MP || !MP.stations) return;
  for (const st of MP.stations) {
    const pid = onlineSessionState.onlineSlotToPid
      ? onlineSessionState.onlineSlotToPid[st.slot]
      : null;
    const own = pid === onlineSessionState.myPlayerId;
    const ms = pid != null && !own ? onlineSessionState.onlinePing[pid] : null;
    const el = document.getElementById("st" + st.idx + "Ping");
    if (el) {
      if (ms != null) {
        const val = Math.round(ms);
        el.textContent = val + "ms";
        el.className = "ping-val " + pingClass(val);
      } else {
        el.textContent = "--";
        el.className = "ping-val";
      }
    }
  }
  if (onlineSessionState.onlinePlayersList !== undefined && onlineSessionState.onlinePlayersList) {
    for (const p of onlineSessionState.onlinePlayersList) {
      if (p.id === onlineSessionState.myPlayerId) continue;
      const lel = document.querySelector('[data-pingid="' + p.id + '"]');
      if (!lel) continue;
      const ms = onlineSessionState.onlinePing[p.id];
      if (ms != null) {
        const v = Math.round(ms);
        lel.textContent = " · " + v + "ms";
        lel.className = "mpc-ping " + pingClass(v);
      } else {
        lel.textContent = "";
        lel.className = "mpc-ping";
      }
    }
  }
}

export function vsUpdateHud() {
  const rl = $("vsRoundLbl"),
    rl2 = $("vsRoundLbl2");
  setText(rl, "ROUND " + versusLobbyState.vsRound);
  if (rl2) setText(rl2, "ROUND " + versusLobbyState.vsRound);
  for (const st of MP.stations) {
    stUpdateStats(st);
    const wt = String(MP.wins[giOf(st)]);
    if (st.chipEl) {
      const v = st.chipEl.querySelector(".mpc-v");
      if (v && v.__t !== wt) {
        v.__t = wt;
        v.textContent = wt;
      }
    }
    if (st.chipEl2) {
      const v2 = st.chipEl2.querySelector(".mpc-v");
      if (v2 && v2.__t !== wt) {
        v2.__t = wt;
        v2.textContent = wt;
      }
    }
  }
}

function stRemoteStep(st, dt) {
  if (!st || !st.alive || !st.piece || st.paused) return;
  if (st.queue.length < 5 && MP.ptrs && typeof MP.ptrs[st.idx] === "number") {
    ensureStream(MP.ptrs[st.idx] + 6);
    st.queue = versusLobbyState.sharedStream.slice(MP.ptrs[st.idx], MP.ptrs[st.idx] + 5);
  }
  const p = st.piece;
  const gms = Math.max(20, st.gravMs || 833);
  st.gravT += dt;
  let gg = 0;
  while (st.gravT >= gms && gg++ < 80) {
    st.gravT -= gms;
    if (!stCollide(st, p.cells, p.x, p.y + 1)) {
      p.y++;
      p.lockT = 0;
    } else {
      st.gravT = 0;
      break;
    }
  }
  if (stCollide(st, p.cells, p.x, p.y + 1)) {
    p.lockT = (p.lockT || 0) + dt;
    if (p.lockT >= LOCK_MS) {
      insertActiveIdx(st.idx);
      if (st.alive) {
        const cells = p.cells;
        const placed = [];
        for (const q of cells) {
          const X = p.x + q[0],
            Y = p.y + q[1];
          if (Y >= 0) st.board[Y][X] = p.type + 1;
          if (Y >= HID) placed.push([X, Y]);
        }
        const rows = findFullRows(st.board);
        if (rows.length) {
          spliceRows(st.board, rows);
          st.lines += rows.length;
        }
        if (
          st.board.some(function (r) {
            return r.some(function (v) {
              return v;
            });
          })
        ) {
          st.piece = null;
          let _locSim = false;
          if (
            st.idx === 0 &&
            onlineSessionState.onlineDisconnected !== undefined &&
            onlineSessionState.onlineDisconnected
          )
            _locSim = true;
          if (!_locSim && onlineSessionState.onlineSlotToPid !== undefined) {
            const _spid = onlineSessionState.onlineSlotToPid[st.slot];
            if (_spid) {
              const _spl = onlineSessionState.onlinePlayersList.find(function (q) {
                return q.id === _spid;
              });
              if (_spl && _spl.state && (_spl.state.conn === "lost" || _spl.state.conn === "gone"))
                _locSim = true;
              else if (
                _spl &&
                (!onlineSessionState.onlineSeen[_spid] ||
                  clock.wall() - onlineSessionState.onlineSeen[_spid] > 3000)
              )
                _locSim = true;
            }
          }
          if (_locSim) {
            st.pieces++;
            const _rnt = consumeIdx(st.idx);
            st.queue = versusLobbyState.sharedStream.slice(MP.ptrs[st.idx], MP.ptrs[st.idx] + 5);
            stEnter(st, _rnt);
            drawStNexts(st);
          } else if (st.queue.length > 0) {
            const _rnt2 = st.queue.shift();
            stEnter(st, _rnt2);
            drawStNexts(st);
            if (MP.ptrs[st.idx] < versusLobbyState.sharedStream.length) {
              ensureStream(MP.ptrs[st.idx] + st.queue.length + 2);
              let _sqOk = true;
              for (let _sqj = 0; _sqj < st.queue.length; _sqj++) {
                if (versusLobbyState.sharedStream[MP.ptrs[st.idx] + _sqj] !== st.queue[_sqj]) {
                  _sqOk = false;
                  break;
                }
              }
              if (!_sqOk) {
                MP.ptrs[st.idx]++;
              }
            }
          } else stTopOut(st);
        }
      }
    }
  } else p.lockT = 0;
}

export function mpWatchHud(uNow) {
  if (MOBILE.matches || !versusLobbyState.vsActive) return;
  const el = $("vsHud");
  if (!el || getComputedStyle(el).display === "none") return;
  const u = uNow || parseFloat(getComputedStyle(document.body).getPropertyValue("--u")) || 16;
  const hdrH = layoutState.headerEl ? layoutState.headerEl.getBoundingClientRect().height : 60;
  const onlineMp =
    onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame && MP.n > 2;
  const avail = (onlineMp ? hdrH + 34 : hdrH + 3 * u + 6) - 8;

  const _sig = u.toFixed(1) + "|" + hdrH.toFixed(0) + "|" + (el.textContent || "");
  if (_sig === mpWatchHud._sig) return;
  mpWatchHud._sig = _sig;

  const REF = 16;
  el.style.setProperty("--hudU", REF + "px");
  const hh = el.offsetHeight || 0;
  if (hh <= 0) return;
  const k = hh / REF;
  const hudU = clamp(avail / Math.max(1.5, k), 6, u);
  const renderedH = k * hudU;
  el.style.setProperty("--hudU", hudU.toFixed(2) + "px");
  el.style.setProperty("--hudH", renderedH.toFixed(1) + "px");
}

/**
 * Advances the versus match by `dt` milliseconds. `present` is false on all but the last of the
 * steps one frame is split into, so the gauges and scoreboard are refreshed once per frame.
 */
export function vsFrame(dt, present = true) {
  if (!versusLobbyState.vsActive || !MP.stations.length) return;
  for (const st of MP.stations) updateParticlesArr(st.particles, dt / 1000);
  if (versusLobbyState.vsMatchOver) return;
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) {
    if (game.state === "playing" && !versusLobbyState.vsRoundOver) {
      versusLobbyState.vsTime += dt;
      for (const st of MP.stations) {
        if (st.alive) {
          st.timeMs += dt;
          stRemoteStep(st, dt);
        }
      }
    }
    tickGarbage();
    if (present) setMpGauges();
    versusLobbyState.vsHudT -= dt;
    if (present && versusLobbyState.vsHudT <= 0) {
      versusLobbyState.vsHudT = 250;
      vsUpdateHud();
      vsFrame._fitT = (vsFrame._fitT || 0) + 250;
      if (vsFrame._fitT >= 500) {
        vsFrame._fitT = 0;
        fitAllStats();
        mpWatchHud();
      }
    }
    return;
  }
  tickGarbage();
  if (present) setMpGauges();
  if (versusLobbyState.vsRoundOver) return;
  if (game.state !== "playing") return;
  versusLobbyState.vsTime += dt;
  for (const st of MP.stations) if (st.alive) st.timeMs += dt;
  if (vsGarbageMode()) {
    const G =
      versusLobbyState.vs.grav +
      (versusLobbyState.vsTime > versusLobbyState.vs.gravMargin
        ? (versusLobbyState.vs.gInc * (versusLobbyState.vsTime - versusLobbyState.vs.gravMargin)) /
          1000
        : 0);
    const gm = Math.max(25, 1000 / (60 * G));
    for (const st of MP.stations) st.gravMs = gm;
  } else {
    for (const st of MP.stations) st.gravMs = gravMsFor("vsbot", st.level);
  }
  for (const st of MP.stations) {
    if (!st.alive) continue;
    if (st.isBot) {
      if (onlineSessionState.onlineRemote.has(st.idx)) stRemoteStep(st, dt);
      else {
        versusLobbyState.bot = st;
        botStep(dt);
      }
    } else {
      if (onlineSessionState.onlineRemote.has(st.idx)) stRemoteStep(st, dt);
      else if (st.idx === 0 && onlineSessionState.onlineDisconnected) stRemoteStep(st, dt);
      else stHumanStep(st, dt);
    }
  }
  if (!versusLobbyState.vsRoundOver) {
    const alive = MP.stations.filter((s) => s.alive);
    if (vsGarbageMode() || versusLobbyState.vs.submode === "endless") {
      const aliveC = alive.filter((s) => {
        if (!s.left) return true;
        const _acPid =
          onlineSessionState.onlineSlotToPid !== undefined && onlineSessionState.onlineSlotToPid
            ? onlineSessionState.onlineSlotToPid[s.slot]
            : null;
        const _acPl = _acPid
          ? onlineSessionState.onlinePlayersList.find(function (q) {
              return q.id === _acPid;
            })
          : null;
        return !!(
          _acPl &&
          _acPl.state &&
          (_acPl.state.conn === "lost" || _acPl.state.conn === "gone")
        );
      });
      if (aliveC.length <= 1) {
        const w = mpBattleWinner();
        vsRoundEnd(w.slot);
      }
    } else if (versusLobbyState.vs.submode === "sprint") {
      const cands = MP.stations.filter((s) => s.alive && s.lines >= SPRINT_LINES);
      if (cands.length) {
        cands.sort((a, b) => b.lines - a.lines || a.slot - b.slot);
        vsRoundEnd(cands[0].slot);
      }
    } else if (versusLobbyState.vs.submode === "ultra" && versusLobbyState.vsTime >= ULTRA_MS) {
      const arr = MP.stations
        .slice()
        .sort((a, b) => b.score - a.score || b.lines - a.lines || a.slot - b.slot);
      vsRoundEnd(arr[0].slot);
    }
  }
  versusLobbyState.vsHudT -= dt;
  if (present && versusLobbyState.vsHudT <= 0) {
    versusLobbyState.vsHudT = 250;
    vsUpdateHud();
    vsFrame._fitT = (vsFrame._fitT || 0) + 250;
    if (vsFrame._fitT >= 500) {
      vsFrame._fitT = 0;
      fitAllStats();
      mpWatchHud();
    }
  }
}
