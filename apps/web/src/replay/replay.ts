// @ts-nocheck
import { clock } from "../core/clock";
import { fxRandom } from "../core/random";
import { PIECES } from "@tetrizz/core";
import { escapeHtml } from "../core/escape";
import { log } from "../core/logger";
import { storage } from "../core/storage";
import { HID, configState, setDVH } from "../core/config";
import { bindingsState } from "../input/bindings";
import { game } from "../game/state";
import { SFX, emptyRow, fx, fxKick, fxSpin } from "../engine/engine";
import { $, applyGeometry, layout, layoutSoon, layoutState } from "../ui/layout";
import {
  banner,
  burstAt,
  clearAllBanners,
  drawHold,
  drawNexts,
  hideAction,
  showAction,
  updateChips,
} from "../render/render";
import { cancelGoText, hideAllOverlays, quitToMenu, showScreen, syncPad } from "../game/game";
import { fmtTime, updateStats } from "../ui/menus";
import { showGameAlert } from "../ui/settings";
import { render, scheduleVisibleFrame } from "../ui/screens";
import { MP, buildMpChips, mpBuildStations, qCountIdx, versusLobbyState } from "../versus/lobby";
import { setGaugeEl } from "../versus/garbage";
import {
  drawStHold,
  drawStNexts,
  hideStAction,
  renderStation,
  showStAction,
  stBanner,
  stBannerStay,
  stBurstAt,
  stFxKick,
  stFxSpin,
  stUpdateChips,
  stUpdateStats,
} from "../versus/stations";
import { layoutMp, vsUpdateHud } from "../versus/rounds";
import { onlineSessionState } from "../net/online-session";
import { showLanSetupScreen } from "../net/lan";
import { relayResumeRoom } from "../net/relay";
import { joinOnlineRoom, keepRejoiningServerRoom, onlineLobbyState } from "../net/online-lobby";

export const replayState = {
  _autoRoom: null,
  replayData: null,
  replayPlayback: null,
  replayTime: 0,
  replaySpeed: 1,
  replayPaused: false,
  replayCurrentRound: 0,
  replayAppliedFrame: null,
  replayEvtIdx: 0,
  replayEndApplied: false,
  replayHideT: null,
  replayPausedAtEnd: false,
  _goWasVs: false,
  _replayActLast: 0,
  _savedTheme: "dark",
  _savedMode: "endless",
  _rfi: undefined,
  _rs: undefined,
  _rsel: undefined,
  dragCounter: 0,
  _installEvt: null,
};

export const AUTO_REJOIN_MS = 15 * 60 * 1000;

export function attemptRejoin(lr) {
  if (onlineLobbyState._rejoinAbort) return;
  if (lr && lr.mode === "lan") {
    showLanSetupScreen();
    return;
  }
  if (lr && lr.mode === "p2p" && lr.host) {
    relayResumeRoom(lr);
    return;
  }
  if (lr && lr.mode === "server" && lr.room) {
    keepRejoiningServerRoom(lr.room);
    return;
  }
  joinOnlineRoom(lr ? lr.room : replayState._autoRoom);
}

export const RP = {
  active: false,
  data: null,
  round: null,
  lastSt: [],
  appIdx: 0,
  prevFrame: null,
};

export function rpTime() {
  return Math.round(
    versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive
      ? versusLobbyState.vsTime
      : game.playMs,
  );
}

export function rpEncodeBoard(bd) {
  let s = "";
  for (let r = 0; r < configState.ROWS; r++) {
    const row = bd[r];
    for (let c = 0; c < configState.COLS; c++) s += row[c];
  }
  return s;
}

function rpDecodeBoard(str) {
  const bd = [];
  for (let r = 0; r < configState.ROWS; r++) {
    const row = [];
    for (let c = 0; c < configState.COLS; c++)
      row.push((str.charCodeAt(r * configState.COLS + c) || 48) - 48);
    bd.push(row);
  }
  return bd;
}

function rpBuildPiece(p) {
  if (!p || p === 0) return null;
  return {
    type: p[0],
    rot: p[1],
    x: p[2],
    y: p[3],
    cells: PIECES[p[0]].cells[p[1]],
    lockT: 0,
    lockResets: 0,
    lastRotate: null,
  };
}

export function rpIsMulti() {
  return (
    versusLobbyState.vsActive !== undefined &&
    versusLobbyState.vsActive &&
    true &&
    MP.stations &&
    MP.stations.length > 0
  );
}

function rpMeta() {
  const multi = rpIsMulti();
  const MODE_NM = {
    endless: "ENDLESS",
    ultra: "ULTRA",
    sprint: "SPRINT",
    wide: "4 WIDE",
    practice: "PRACTICE",
  };
  const m = {
    date: new Date().toISOString(),
    cols: configState.COLS,
    vis: configState.VIS,
    multi: multi ? 1 : 0,
  };
  if (multi) {
    m.submode = versusLobbyState.vs.submode;
    const _subNm = {
      battle: "BATTLE",
      wide: "4 WIDE",
      endless: "ENDLESS",
      ultra: "ULTRA",
      sprint: "SPRINT",
    };
    m.modeName =
      _subNm[versusLobbyState.vs.submode] ||
      String(versusLobbyState.vs.submode || "battle").toUpperCase();
    m.online =
      onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame ? 1 : 0;
    m.players = MP.n;
    m.stations = MP.stations.map((st) => ({
      label: st.label,
      color: st.color,
      bot: st.isBot ? 1 : 0,
    }));
  } else {
    m.mode = configState.mode;
    m.modeName = MODE_NM[configState.mode] || String(configState.mode).toUpperCase();
  }
  return m;
}

function rpRefreshMetaStations() {
  if (!RP.data) return;
  if (rpIsMulti()) {
    RP.data.meta.stations = MP.stations.map((st) => ({
      label: st.label,
      color: st.color,
      bot: st.isBot ? 1 : 0,
    }));
    RP.data.meta.players = MP.n;
  }
}

export function rpBeginRound() {
  if (!RP.data) RP.data = { meta: rpMeta(), rounds: [] };
  RP.active = true;
  RP.round = { frames: [], events: [], end: null };
  RP.data.rounds.push(RP.round);
  RP.lastSt = [];
  RP.lastWins = "";
  const sb = $("saveReplayBtn");
  if (sb) {
    sb.style.display = "none";
    const _sbl = sb.querySelector(".mm-label");
    if (_sbl) _sbl.textContent = "SAVE REPLAY";
    sb.style.opacity = "";
    sb.style.pointerEvents = "";
    sb.disabled = false;
  }
}

function rpCaptureStation(st, last) {
  const f = {};
  const parr = st.piece ? [st.piece.type, st.piece.rot, st.piece.x, st.piece.y] : null;
  const pstr = parr ? parr.join(",") : "";
  const bstr = rpEncodeBoard(st.board);
  const qstr = st.queue.join(",");
  const scarr = [
    st.score,
    st.lines,
    st.level,
    st.combo,
    st.b2b,
    st.pieces,
    st.alive ? 1 : 0,
    st.sent || 0,
  ];
  const scstr = scarr.join(",");
  let gT, gP;
  if (
    onlineSessionState.onlineRemote !== undefined &&
    onlineSessionState.onlineRemote.has(st.idx)
  ) {
    gT = st._olInc || 0;
    gP = 0;
  } else {
    gT = qCountIdx(st.idx, ["travel"]);
    gP = qCountIdx(st.idx, ["pending", "active"]);
  }
  if (!last) {
    f.p = parr ? parr : 0;
    f.bd = bstr;
    f.q = st.queue.slice(0, 5);
    f.h = st.hold;
    f.hu = st.holdUsed ? 1 : 0;
    f.sc = scarr[0];
    f.ln = scarr[1];
    f.lv = scarr[2];
    f.cb = scarr[3];
    f.b2 = scarr[4];
    f.pc = scarr[5];
    f.al = scarr[6];
    f.sn = scarr[7];
    f.gT = gT;
    f.gP = gP;
    f.tx = st.fx.tx || 0;
    return {
      f: f,
      last: {
        p: pstr,
        bd: bstr,
        q: qstr,
        h: st.hold,
        hu: st.holdUsed ? 1 : 0,
        sc: scstr,
        gT: gT,
        gP: gP,
        tx: st.fx.tx || 0,
      },
    };
  }
  if (last.p !== pstr) {
    f.p = parr ? parr : 0;
    last.p = pstr;
  }
  if (last.tx !== (st.fx.tx || 0)) {
    f.tx = st.fx.tx || 0;
    last.tx = st.fx.tx || 0;
  }
  if (last.bd !== bstr) {
    f.bd = bstr;
    last.bd = bstr;
  }
  if (last.q !== qstr) {
    f.q = st.queue.slice(0, 5);
    last.q = qstr;
  }
  if (last.h !== st.hold || last.hu !== (st.holdUsed ? 1 : 0)) {
    f.h = st.hold;
    f.hu = st.holdUsed ? 1 : 0;
    last.h = st.hold;
    last.hu = st.holdUsed ? 1 : 0;
  }
  if (last.sc !== scstr) {
    f.sc = scarr[0];
    f.ln = scarr[1];
    f.lv = scarr[2];
    f.cb = scarr[3];
    f.b2 = scarr[4];
    f.pc = scarr[5];
    f.al = scarr[6];
    f.sn = scarr[7];
    last.sc = scstr;
  }
  if (last.gT !== gT || last.gP !== gP) {
    f.gT = gT;
    f.gP = gP;
    last.gT = gT;
    last.gP = gP;
  }
  return { f: f, last: last };
}

function rpCaptureSingle(last) {
  const f = {};
  const parr = game.piece ? [game.piece.type, game.piece.rot, game.piece.x, game.piece.y] : null;
  const pstr = parr ? parr.join(",") : "";
  const bstr = rpEncodeBoard(game.board);
  const qstr = game.queue.join(",");
  const scarr = [
    game.score,
    game.lines,
    game.level,
    game.combo,
    game.b2bChain,
    game.pieces,
    game.state !== "over" ? 1 : 0,
    0,
  ];
  const scstr = scarr.join(",");
  if (!last) {
    f.p = parr ? parr : 0;
    f.bd = bstr;
    f.q = game.queue.slice(0, 5);
    f.h = game.hold;
    f.hu = game.holdUsed ? 1 : 0;
    f.sc = scarr[0];
    f.ln = scarr[1];
    f.lv = scarr[2];
    f.cb = scarr[3];
    f.b2 = scarr[4];
    f.pc = scarr[5];
    f.al = scarr[6];
    f.sn = 0;
    f.tx = fx.tx;
    return {
      f: f,
      last: {
        p: pstr,
        bd: bstr,
        q: qstr,
        h: game.hold,
        hu: game.holdUsed ? 1 : 0,
        sc: scstr,
        tx: fx.tx,
      },
    };
  }
  if (last.p !== pstr) {
    f.p = parr ? parr : 0;
    last.p = pstr;
  }
  if (last.tx !== fx.tx) {
    f.tx = fx.tx;
    last.tx = fx.tx;
  }
  if (last.bd !== bstr) {
    f.bd = bstr;
    last.bd = bstr;
  }
  if (last.q !== qstr) {
    f.q = game.queue.slice(0, 5);
    last.q = qstr;
  }
  if (last.h !== game.hold || last.hu !== (game.holdUsed ? 1 : 0)) {
    f.h = game.hold;
    f.hu = game.holdUsed ? 1 : 0;
    last.h = game.hold;
    last.hu = game.holdUsed ? 1 : 0;
  }
  if (last.sc !== scstr) {
    f.sc = scarr[0];
    f.ln = scarr[1];
    f.lv = scarr[2];
    f.cb = scarr[3];
    f.b2 = scarr[4];
    f.pc = scarr[5];
    f.al = scarr[6];
    f.sn = 0;
    last.sc = scstr;
  }
  return { f: f, last: last };
}

export function rpCaptureFrame(force) {
  if (!RP.round) return;
  const multi = rpIsMulti();
  const frame = { t: rpTime(), s: [] };
  let changed = false;
  if (multi) {
    for (let i = 0; i < MP.stations.length; i++) {
      const r = rpCaptureStation(MP.stations[i], RP.lastSt[i]);
      frame.s.push(r.f);
      RP.lastSt[i] = r.last;
      if (Object.keys(r.f).length) changed = true;
    }
  } else {
    const r = rpCaptureSingle(RP.lastSt[0]);
    frame.s.push(r.f);
    RP.lastSt[0] = r.last;
    if (Object.keys(r.f).length) changed = true;
  }
  if (rpIsMulti()) {
    const wstr = MP.wins.join(",");
    if (RP.lastWins !== wstr) {
      frame.wins = MP.wins.slice(0, 4);
      RP.lastWins = wstr;
      changed = true;
    }
  }
  if (changed || force) RP.round.frames.push(frame);
}

export function rpFinalCapture() {
  rpCaptureFrame(true);
}

export function rpSingleEnd() {
  const span = $("goText") ? $("goText").querySelector("span") : null;
  return {
    t: rpTime(),
    wins: null,
    banners:
      span && span.textContent
        ? [{ txt: span.textContent, col: span.style.color || "", go: true }]
        : null,
  };
}

export function rpMultiEnd(stay) {
  return {
    t: Math.round(versusLobbyState.vsTime),
    wins: MP.wins.slice(0, 4),
    banners: MP.stations.map((st) =>
      st.bannerEl
        ? { txt: st.bannerEl.textContent, col: st.bannerEl.style.color || "", stay: !!stay }
        : null,
    ),
  };
}

export function rpEndRound(end) {
  if (!RP.round) return;
  RP.round.end = end || null;
  rpRefreshMetaStations();
}

export function rpEndMatch() {
  if (!RP.data) return;
  RP.data.rounds = RP.data.rounds.filter((r) => r.frames.length > 0);
  rpRefreshMetaStations();
  RP.active = false;
  replayState.replayData = RP.data;
  const btn = $("saveReplayBtn");
  if (btn && RP.data.rounds.length > 0) btn.style.display = "";
}

function rpSeekReset() {
  RP.prevFrame = null;
  clearAllBanners();
  if (rpIsMulti()) {
    for (const st of MP.stations) {
      st.board = Array.from({ length: configState.ROWS }, emptyRow);
      st.piece = null;
      st.queue = [];
      st.hold = null;
      st.holdUsed = false;
      st.score = 0;
      st.lines = 0;
      st.level = 1;
      st.combo = -1;
      st.b2b = 0;
      st.pieces = 0;
      st.sent = 0;
      st.timeMs = 0;
      st.alive = true;
      st.particles = [];
      if (st.wrapEl) st.wrapEl.classList.remove("lost", "danger", "garbage-hit");
      hideStAction(st);
      st.fx.tx = 0;
      st.fx.lx = 0;
      st.fx.lvx = 0;
    }
  } else {
    game.board = Array.from({ length: configState.ROWS }, emptyRow);
    game.piece = null;
    game.queue = [];
    game.hold = null;
    game.holdUsed = false;
    game.score = 0;
    game.lines = 0;
    game.level = 1;
    game.combo = -1;
    game.b2bChain = 0;
    game.pieces = 0;
    game.playMs = 0;
    game.particles = [];
    layoutState.wrap.classList.remove("lost", "danger");
    hideAction();
    fx.tx = 0;
    fx.lx = 0;
    fx.lvx = 0;
  }
  for (const st of MP.stations) {
    st._rpGT = 0;
    st._rpGP = 0;
    if (st.gaugeEl) setGaugeEl(st.gaugeEl, 0, 0);
  }
}

function rpTopRow(bd) {
  for (let y = 0; y < configState.ROWS; y++)
    for (let x = 0; x < configState.COLS; x++) if (bd[y][x]) return y;
  return configState.ROWS;
}

function rpBurstLines(st, n) {
  n = Math.min(n, 4);
  for (let k = 0; k < n; k++) {
    const y = configState.ROWS - 1 - k;
    for (let x = 0; x < configState.COLS; x += 1) {
      if (st) stBurstAt(st, x, y, null, 2, true, 1.2);
      else burstAt(x, y, null, 2, true, 1.2);
    }
  }
}

function rpApplySingle(f, prev, t, quiet) {
  if (f.bd !== undefined) game.board = rpDecodeBoard(f.bd);
  if (f.q !== undefined) game.queue = f.q.slice();
  if (f.h !== undefined) {
    game.hold = f.h;
    game.holdUsed = !!f.hu;
  }
  if (f.p !== undefined) game.piece = rpBuildPiece(f.p);
  if (f.tx !== undefined) fx.tx = f.tx;
  if (f.sc !== undefined) {
    const _oldPc = game.pieces,
      _oldSc = game.score;
    game.score = f.sc;
    game.lines = f.ln;
    game.level = f.lv;
    game.combo = f.cb;
    game.b2bChain = f.b2;
    game.pieces = f.pc;
    layoutState.wrap.classList.toggle("lost", !f.al);
    if (!f.al) layoutState.wrap.classList.remove("danger");
    if (!quiet) {
      if (f.sc > _oldSc) {
        layoutState.elScore.classList.remove("bump");
        void layoutState.elScore.offsetWidth;
        layoutState.elScore.classList.add("bump");
      }
      if (f.pc > _oldPc && prev && prev.p && prev.p !== 0) {
        const pp = prev.p,
          cells = PIECES[pp[0]].cells[pp[1]];
        for (const q of cells) {
          const X = pp[2] + q[0],
            Y = pp[3] + q[1];
          if (Y >= HID) burstAt(X, Y, pp[0], 2, true, 0.85);
        }
      }
    }
  }
  game.playMs = t;
  if (!quiet) {
    updateStats();
    updateChips();
    drawHold();
    drawNexts();
  }
  if (!quiet && prev && f.ln !== undefined && prev.ln !== undefined && f.ln > prev.ln)
    rpBurstLines(null, f.ln - prev.ln);
  if (game.state === "replay")
    layoutState.wrap.classList.toggle(
      "danger",
      rpTopRow(game.board) < HID + 5 && !layoutState.wrap.classList.contains("lost"),
    );
}

function rpApplyStation(st, f, prev, t, quiet) {
  if (f.bd !== undefined) st.board = rpDecodeBoard(f.bd);
  if (f.q !== undefined) st.queue = f.q.slice();
  if (f.h !== undefined) {
    st.hold = f.h;
    st.holdUsed = !!f.hu;
  }
  if (f.p !== undefined) st.piece = rpBuildPiece(f.p);
  if (f.tx !== undefined) st.fx.tx = f.tx;
  if (f.sc !== undefined) {
    const _oldPc = st.pieces;
    st.score = f.sc;
    st.lines = f.ln;
    st.level = f.lv;
    st.combo = f.cb;
    st.b2b = f.b2;
    st.pieces = f.pc;
    st.sent = f.sn || 0;
    st.alive = !!f.al;
    if (st.wrapEl) {
      st.wrapEl.classList.toggle("lost", !st.alive);
      if (!st.alive) st.wrapEl.classList.remove("danger");
    }
    if (!quiet && f.pc > _oldPc && prev && prev.p && prev.p !== 0) {
      const pp = prev.p,
        cells = PIECES[pp[0]].cells[pp[1]];
      for (const q of cells) {
        const X = pp[2] + q[0],
          Y = pp[3] + q[1];
        if (Y >= HID) stBurstAt(st, X, Y, pp[0], 2, true, 0.85);
      }
    }
  }
  st.timeMs = t;
  if (f.gT !== undefined || f.gP !== undefined) {
    st._rpGT = f.gT || 0;
    st._rpGP = f.gP || 0;
    if (!quiet) setGaugeEl(st.gaugeEl, st._rpGT, st._rpGP);
  }
  if (!quiet) {
    stUpdateStats(st);
    stUpdateChips(st);
    drawStHold(st);
    drawStNexts(st);
  }
  if (!quiet && prev && f.ln !== undefined && prev.ln !== undefined && f.ln > prev.ln)
    rpBurstLines(st, f.ln - prev.ln);
  if (game.state === "replay") {
    if (!st.alive) {
      if (st.wrapEl) st.wrapEl.classList.remove("danger");
    } else if (st.wrapEl) st.wrapEl.classList.toggle("danger", rpTopRow(st.board) < HID + 5);
  }
}

function rpApplyFrame(frame, quiet) {
  if (rpIsMulti()) {
    for (let i = 0; i < MP.stations.length && i < frame.s.length; i++) {
      const f = frame.s[i];
      if (!f) continue;
      const prevS = RP.prevFrame && RP.prevFrame.s[i] ? RP.prevFrame.s[i] : null;
      rpApplyStation(MP.stations[i], f, prevS, frame.t, quiet);
    }
  } else {
    const f = frame.s[0];
    if (f)
      rpApplySingle(
        f,
        RP.prevFrame && RP.prevFrame.s[0] ? RP.prevFrame.s[0] : null,
        frame.t,
        quiet,
      );
  }
}

function rpSyncDom() {
  if (rpIsMulti()) {
    for (const st of MP.stations) {
      stUpdateStats(st);
      stUpdateChips(st);
      drawStHold(st);
      drawStNexts(st);
      if (st.gaugeEl) setGaugeEl(st.gaugeEl, st._rpGT || 0, st._rpGP || 0);
    }
    vsUpdateHud();
  } else {
    updateStats();
    updateChips();
    drawHold();
    drawNexts();
  }
}

function rpRender() {
  if (rpIsMulti()) {
    for (const st of MP.stations) {
      renderStation(st);
      if (st.gaugeEl) setGaugeEl(st.gaugeEl, st._rpGT || 0, st._rpGP || 0);
    }
  } else render();
}

function rpApplyEnd(round) {
  const end = round.end;
  if (!end) return;
  if (rpIsMulti()) {
    if (end.wins) {
      MP.wins = end.wins.slice(0, 4);
      vsUpdateHud();
    }
    if (end.banners) {
      MP.stations.forEach((st, i) => {
        const b = end.banners[i];
        if (b && b.txt) {
          if (b.stay) stBannerStay(st, b.txt, b.col || "#fff", "end");
          else stBanner(st, b.txt, b.col || "#fff", "round");
        }
      });
    }
  } else {
    const b = end.banners && end.banners[0];
    if (b && b.txt && b.go) {
      const gt = $("goText"),
        span = gt ? gt.querySelector("span") : null;
      if (gt && span) {
        span.textContent = b.txt;
        span.style.color = b.col || "#fff";
        gt.classList.remove("show");
        void gt.offsetWidth;
        gt.classList.add("show");
      }
    }
  }
}

function rpFireEvent(ev) {
  if (!ev) return;
  if (ev.k === "s") {
    const fn = SFX[ev.n];
    if (typeof fn === "function") {
      try {
        fn.apply(null, ev.a || []);
      } catch (_) {
        log.debug("replay/replay.rpFireEvent", _);
      }
    }
  } else if (ev.k === "fx") {
    if (ev.type === "kick") fxKick(ev.dx, ev.dy, ev.dr);
    else if (ev.type === "spin") fxSpin(ev.dir);
    else if (ev.type === "skick") {
      const st = rpIsMulti() ? MP.stations[ev.i] : null;
      if (st) stFxKick(st, ev.dx, ev.dy, ev.dr);
    } else if (ev.type === "sspin") {
      const st = rpIsMulti() ? MP.stations[ev.i] : null;
      if (st) stFxSpin(st, ev.dir);
    }
  } else if (ev.k === "a") {
    if (ev.i < 0 || !rpIsMulti()) showAction(ev.title, ev.sub, ev.cls, ev.color || null);
    else {
      const st = MP.stations[ev.i];
      if (st) showStAction(st, ev.title, ev.sub, ev.cls, ev.color || null);
    }
  } else if (ev.k === "b") {
    if (ev.i < 0 || !rpIsMulti()) banner(ev.txt, ev.color, ev.cls);
    else {
      const st = MP.stations[ev.i];
      if (st) stBanner(st, ev.txt, ev.color, ev.cls);
    }
  }
}

function rpHandleEvents(round, fromT, toT, resetDone) {
  const evs = round.events;
  if (!evs || !evs.length) {
    replayState.replayEvtIdx = 0;
    return;
  }
  const jump = resetDone || toT - fromT > 300 || toT < fromT - 1;
  if (jump) {
    let i = 0;
    while (i < evs.length && evs[i].t <= toT) i++;
    replayState.replayEvtIdx = i;
    return;
  }

  while (replayState.replayEvtIdx < evs.length && evs[replayState.replayEvtIdx].t < fromT - 1)
    replayState.replayEvtIdx++;
  while (replayState.replayEvtIdx < evs.length && evs[replayState.replayEvtIdx].t <= toT) {
    rpFireEvent(evs[replayState.replayEvtIdx]);
    replayState.replayEvtIdx++;
  }
}

function rpShowRoundBanner() {
  if (!rpIsMulti()) return;
  const txt = "ROUND " + (replayState.replayCurrentRound + 1);
  for (const st of MP.stations) stBanner(st, txt, "#2a93a8", "round");
}

export function rpTick(dt) {
  if (!replayState.replayPlayback) return;
  versusLobbyState.vsRound = replayState.replayCurrentRound + 1;
  const round = replayState.replayPlayback.rounds[replayState.replayCurrentRound];
  if (!round) return;
  const frames = round.frames;
  if (!frames.length) return;
  const fromT = replayState.replayTime;
  if (!replayState.replayPaused) replayState.replayTime += dt * replayState.replaySpeed;
  const maxT = frames[frames.length - 1].t;
  if (replayState.replayTime < 0) replayState.replayTime = 0;
  if (replayState.replayTime > maxT) {
    replayState.replayTime = maxT;
    if (!replayState.replayPaused) {
      replayState.replayPaused = true;
      replayState.replayPausedAtEnd = true;
      rpSetPPIcon();
      replayShowControls();
    }
    if (!replayState.replayEndApplied) {
      replayState.replayEndApplied = true;
      rpApplyEnd(round);
    }
  }
  if (replayState.replayPausedAtEnd && replayState.replayTime < maxT - 1) {
    replayState.replayPausedAtEnd = false;
    if (replayState.replayPaused) {
      replayState.replayPaused = false;
      rpSetPPIcon();
    }
  }
  if (replayState.replayTime < maxT - 1 && replayState.replayEndApplied) {
    replayState.replayEndApplied = false;
    clearAllBanners();
    cancelGoText();
  }
  let resetDone = false;
  if (
    replayState.replayAppliedFrame === null ||
    replayState.replayTime < replayState.replayAppliedFrame.t - 1
  ) {
    const _showBanner = replayState.replayAppliedFrame === null;
    rpSeekReset();
    RP.appIdx = 0;
    resetDone = true;
    if (_showBanner) rpShowRoundBanner();
  }
  let _nApplied = 0,
    _lastQuiet = false;
  while (RP.appIdx < frames.length && frames[RP.appIdx].t <= replayState.replayTime) {
    const _q = replayState.replayTime - frames[RP.appIdx].t > 250;
    rpApplyFrame(frames[RP.appIdx], _q);
    if (rpIsMulti() && frames[RP.appIdx].wins) {
      MP.wins = frames[RP.appIdx].wins.slice(0, 4);
      if (!_q) vsUpdateHud();
    }
    RP.prevFrame = frames[RP.appIdx];
    replayState.replayAppliedFrame = frames[RP.appIdx];
    RP.appIdx++;
    _nApplied++;
    _lastQuiet = _q;
  }
  if (_nApplied && (_lastQuiet || _nApplied > 1)) rpSyncDom();
  rpHandleEvents(round, fromT, replayState.replayTime, resetDone);
  rpRender();
  updateReplayUI();
}

function rpSetupStations(meta) {
  const n = (meta.stations && meta.stations.length) || Math.max(2, meta.players || 2);
  const act = [];
  for (let i = 0; i < n; i++) {
    const s = meta.stations ? meta.stations[i] : { bot: i > 0 ? 1 : 0 };
    act.push({
      p: { type: s.bot ? "bot" : "user", dev: "key", touch: false, swipe: false },
      i: i,
    });
  }
  versusLobbyState.vs.players = [];
  for (let i = 0; i < 4; i++)
    versusLobbyState.vs.players.push({ type: i < n ? act[i].p.type : "off", dev: "key" });
  mpBuildStations(act);
  for (let i = 0; i < MP.stations.length; i++) {
    const st = MP.stations[i];
    st.slot = i;
    st.gi = i;
    if (meta.stations && meta.stations[i]) {
      if (meta.stations[i].label) st.label = meta.stations[i].label;
      if (meta.stations[i].color) st.color = meta.stations[i].color;
      st.isBot = !!meta.stations[i].bot;
    }
    st.board = Array.from({ length: configState.ROWS }, emptyRow);
    st.particles = [];
  }
  buildMpChips();
  document.body.classList.add("vsplay");
  document.body.classList.toggle("vsWide", versusLobbyState.vs.submode === "wide");
  document.body.classList.toggle("vs3P", MP.n === 3);
}

export function startReplay(data) {
  if (!data || !data.rounds || !data.rounds.length) return;
  replayState.replayPlayback = data;
  replayState.replayCurrentRound = 0;
  replayState.replayTime = 0;
  replayState.replaySpeed = 1;
  replayState.replayPaused = false;
  replayState.replayAppliedFrame = null;
  replayState.replayEvtIdx = 0;
  replayState.replayEndApplied = false;
  RP.appIdx = 0;
  RP.prevFrame = null;
  const meta = data.meta || {};
  const multi = !!meta.multi;
  configState.COLS = meta.cols || 10;
  configState.VIS = meta.vis || 20;
  configState.ROWS = configState.VIS + HID;
  if (multi) {
    versusLobbyState.vs.submode = meta.submode || "battle";
    configState.mode = "vsbot";
    rpSetupStations(meta);
    versusLobbyState.vsActive = true;
    rpSeekReset();
  } else {
    configState.mode = meta.mode || "endless";
    versusLobbyState.vsActive = false;
    MP.stations = [];
    MP.n = 0;
    game.board = Array.from({ length: configState.ROWS }, emptyRow);
    game.piece = null;
    game.queue = [];
    game.hold = null;
    game.holdUsed = false;
    game.score = 0;
    game.lines = 0;
    game.level = 1;
    game.combo = -1;
    game.b2bChain = 0;
    game.pieces = 0;
    game.playMs = 0;
    game.particles = [];
    document.body.classList.remove("vsplay", "vsWide", "splitMob", "mobOnMulti");
  }
  applyGeometry();
  game.state = "replay";
  if (window.tzRepaint) {
    setTimeout(window.tzRepaint, 60);
    setTimeout(window.tzRepaint, 400);
  }
  document.body.classList.remove("replayClean");
  document.body.classList.add("replaying");
  document.body.classList.remove(
    "matchover",
    "online-play",
    "online-spec",
    "onlineMulti",
    "onlineMulti3",
    "onlineMulti4",
  );
  hideAllOverlays();
  bindingsState.openOverlayEl = null;
  clearAllBanners();
  cancelGoText();
  hideAction();
  layoutState.comboChip.classList.remove("show");
  layoutState.b2bChip.classList.remove("show", "hot", "blaze", "inferno", "storm", "mythic");
  if (multi && MP.stations) {
    for (const st of MP.stations) {
      if (st.comboEl) st.comboEl.classList.remove("show");
      if (st.b2bEl) {
        st.b2bEl.classList.remove("show", "hot", "blaze", "inferno", "storm", "mythic");
        st.b2bEl.dataset.n = "";
      }
      hideStAction(st);
      if (st.wrapEl) st.wrapEl.classList.remove("danger", "garbage-hit", "lost");
    }
  }
  syncPad();
  layout();
  if (multi) layoutMp(game.MINI);
  layoutSoon(80);
  layoutSoon(300);
  requestAnimationFrame(function () {
    setDVH();
    layout();
    if (multi) layoutMp(game.MINI);
    scheduleVisibleFrame();
    requestAnimationFrame(function () {
      layout();
      if (multi) layoutMp(game.MINI);
    });
  });
  const eb = $("replayExitBtn");
  if (eb) eb.style.display = "";
  document
    .querySelectorAll(".replay-speed")
    .forEach((b) => b.classList.toggle("active", parseFloat(b.dataset.speed) === 1));
  rpSetPPIcon();
  updateReplayUI();
  rpShowRoundBanner();
  replayShowControls();
}

export function exitReplay() {
  replayState.replayPlayback = null;
  replayState.replayAppliedFrame = null;
  replayState.replayEndApplied = false;
  clearAllBanners();
  cancelGoText();
  game.state = "menu";
  versusLobbyState.vsActive = false;
  document.body.classList.remove(
    "vsplay",
    "vsWide",
    "splitMob",
    "mobOnMulti",
    "replaying",
    "replayClean",
    "matchover",
  );
  const rc = $("replayControls");
  if (rc) rc.classList.add("hidden");
  const eb = $("replayExitBtn");
  if (eb) eb.style.display = "none";
  clearTimeout(replayState.replayHideT);
  quitToMenu();
  showScreen($("ovStart"), "replays");
}

export function replayTogglePlay() {
  if (!replayState.replayPlayback) return;
  const round = replayState.replayPlayback.rounds[replayState.replayCurrentRound];
  const frames = round.frames;
  const maxT = frames.length ? frames[frames.length - 1].t : 0;
  if (replayState.replayPaused && replayState.replayTime >= maxT - 1) {
    replayState.replayTime = 0;
    replayState.replayAppliedFrame = null;
    replayState.replayEvtIdx = 0;
    replayState.replayEndApplied = false;
    clearAllBanners();
    cancelGoText();
  }
  replayState.replayPaused = !replayState.replayPaused;
  replayState.replayPausedAtEnd = false;
  rpSetPPIcon();
  replayShowControls();
}

export function rpSetPPIcon() {
  const b = $("replayPlayPause");
  if (!b) return;
  b.innerHTML = replayState.replayPaused
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6z"/><path d="M14 5h4v14h-4z"/></svg>';
}

export function replayShowControls() {
  const c = $("replayControls");
  if (c) {
    c.classList.remove("hidden");
    c.style.setProperty("display", "flex", "important");
    c.style.transform = "";
  }
  clearTimeout(replayState.replayHideT);
  replayState.replayHideT = setTimeout(() => {
    if (game.state === "replay" && !replayState.replayPaused) {
      const c2 = $("replayControls");
      if (c2) c2.classList.add("hidden");
    }
  }, 3000);
}

export function updateReplayUI() {
  if (!replayState.replayPlayback) return;
  const rounds = replayState.replayPlayback.rounds;
  const sel = $("replayRoundSel");
  if (sel) {
    if (rounds.length > 1) {
      sel.style.display = "";
      if (sel.options.length !== rounds.length)
        sel.innerHTML = rounds
          .map((_, i) => '<option value="' + i + '">ROUND ' + (i + 1) + "</option>")
          .join("");
      if (sel.value !== String(replayState.replayCurrentRound))
        sel.value = String(replayState.replayCurrentRound);
    } else sel.style.display = "none";
  }
  const round = rounds[replayState.replayCurrentRound];
  const frames = round.frames;
  const maxT = frames.length ? frames[frames.length - 1].t : 0;
  const seek = $("replaySeek");
  if (seek) {
    seek.max = maxT;
    seek.value = replayState.replayTime;
  }
  const rt = $("replayTime");
  if (rt) rt.textContent = fmtTime(replayState.replayTime) + " / " + fmtTime(maxT);
}

export function replayTitle(meta) {
  meta = meta || {};
  if (meta.multi) {
    let t =
      "MULTIPLAYER · " +
      (meta.online ? "ONLINE" : "LOCAL") +
      " · " +
      (meta.modeName || "BATTLE") +
      " · " +
      (meta.players || 2) +
      "P";
    const bots = (meta.stations || []).filter((s) => s.bot).length;
    if (bots) t += " · " + bots + " BOT" + (bots > 1 ? "S" : "");
    return t;
  }
  return "SINGLE · " + (meta.modeName || String(meta.mode || "").toUpperCase());
}

function fmtReplayDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "/" +
    p(d.getMonth() + 1) +
    "/" +
    p(d.getDate()) +
    "  " +
    p(d.getHours()) +
    ":" +
    p(d.getMinutes())
  );
}

function rpB64FromBytes(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

function rpBytesFromB64(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function rpCompress(obj) {
  try {
    if (typeof CompressionStream === "undefined") return null;
    const cs = new CompressionStream("gzip");
    const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return rpB64FromBytes(new Uint8Array(buf));
  } catch (_) {
    return null;
  }
}

async function rpDecompress(b64) {
  try {
    if (typeof DecompressionStream === "undefined") return null;
    const u8 = rpBytesFromB64(b64);
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    const txt = await new Response(stream).text();
    return JSON.parse(txt);
  } catch (_) {
    return null;
  }
}

export async function rpEntryData(r) {
  if (r && r.gz && typeof r.data === "string") {
    const d = await rpDecompress(r.data);
    return d || null;
  }
  return r ? r.data : null;
}

function fmtSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(2) + " MB";
}

export async function saveReplayToStorage(data) {
  let replays = [];
  try {
    replays = JSON.parse(storage.get("tetris_replays") || "[]");
  } catch (_) {
    log.debug("replay/replay.saveReplayToStorage", _);
  }
  const id =
    window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : clock.wall().toString(36) + fxRandom().toString(36).slice(2, 5);
  let dur = 0;
  for (const rd of data.rounds || []) {
    if (rd.frames && rd.frames.length) dur += rd.frames[rd.frames.length - 1].t;
  }
  const nR = (data.rounds || []).length;
  const b64 = await rpCompress(data);
  const size = b64 ? Math.round((b64.length * 3) / 4) : JSON.stringify(data).length;
  const entry = b64
    ? { id: id, name: "", meta: data.meta, gz: 1, dur: dur, size: size, nR: nR, data: b64 }
    : { id: id, name: "", meta: data.meta, dur: dur, size: size, nR: nR, data: data };
  replays.unshift(entry);
  while (replays.length > 12) replays.pop();
  try {
    storage.set("tetris_replays", JSON.stringify(replays));
  } catch (e) {
    replays.pop();
    try {
      storage.set("tetris_replays", JSON.stringify(replays));
    } catch (_) {
      log.debug("replay/replay.saveReplayToStorage#2", _);
    }
  }
}

export async function rpMigrateReplays() {
  let replays = [];
  try {
    replays = JSON.parse(storage.get("tetris_replays") || "[]");
  } catch (_) {
    return;
  }
  let dirty = false;
  for (const r of replays) {
    if (r && r.size == null && r.data && typeof r.data === "object") {
      let dur = 0;
      for (const rd of r.data.rounds || []) {
        if (rd.frames && rd.frames.length) dur += rd.frames[rd.frames.length - 1].t;
      }
      r.dur = dur;
      r.nR = (r.data.rounds || []).length;
      const b64 = await rpCompress(r.data);
      if (b64) {
        r.gz = 1;
        r.size = Math.round((b64.length * 3) / 4);
        r.data = b64;
      } else {
        r.size = JSON.stringify(r.data).length;
      }
      dirty = true;
    }
  }
  if (dirty) {
    try {
      storage.set("tetris_replays", JSON.stringify(replays));
    } catch (_) {
      log.debug("replay/replay.rpMigrateReplays", _);
    }
  }
}

export function renderReplaysList() {
  let replays = [];
  try {
    replays = JSON.parse(storage.get("tetris_replays") || "[]");
  } catch (_) {
    log.debug("replay/replay.renderReplaysList", _);
  }
  const list = document.querySelector(".replay-list");
  if (!list) return;
  if (!replays.length) {
    list.innerHTML =
      '<div class="dev-note" style="text-align:center">No saved replays yet. Finish a game and tap SAVE REPLAY.</div>';
    return;
  }
  list.innerHTML = replays
    .map((r) => {
      const nR = r.nR != null ? r.nR : r.data && r.data.rounds ? r.data.rounds.length : 0;
      let dur = r.dur != null ? r.dur : 0;
      if (r.dur == null && r.data && r.data.rounds) {
        for (const rd of r.data.rounds) {
          if (rd.frames && rd.frames.length) dur += rd.frames[rd.frames.length - 1].t;
        }
      }
      const size = r.size != null ? r.size : r.data ? JSON.stringify(r.data).length : 0;
      return (
        '<div class="replay-card">' +
        '<div class="replay-card-info">' +
        '<div class="replay-card-title">' +
        (r.name && r.name.trim() ? escapeHtml(r.name) : escapeHtml(replayTitle(r.meta))) +
        "</div>" +
        '<div class="replay-card-meta">' +
        escapeHtml(fmtReplayDate(r.meta.date)) +
        " · " +
        nR +
        " ROUND" +
        (nR > 1 ? "S" : "") +
        " · " +
        fmtTime(dur) +
        " · " +
        fmtSize(size) +
        "</div>" +
        "</div>" +
        '<div class="replay-card-actions">' +
        '<button class="rp-btn play" data-replay-id="' +
        escapeHtml(r.id) +
        '"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>PLAY</button>' +
        '<button class="rp-btn icon" data-replay-edit="' +
        escapeHtml(r.id) +
        '" title="Rename"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>' +
        '<button class="rp-btn icon" data-replay-dl="' +
        escapeHtml(r.id) +
        '" title="Download"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M6 11l6 6 6-6"/><path d="M5 21h14"/></svg></button>' +
        '<button class="rp-btn icon danger" data-replay-del="' +
        escapeHtml(r.id) +
        '" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>' +
        "</div></div>"
      );
    })
    .join("");
  list.querySelectorAll("button").forEach((b) => b.setAttribute("tabindex", "-1"));
}

export async function downloadReplayFile(data) {
  try {
    const json = JSON.stringify(data);
    let blob = null;
    try {
      if (typeof CompressionStream !== "undefined") {
        const cs = new CompressionStream("gzip");
        const buf = await new Response(new Blob([json]).stream().pipeThrough(cs)).arrayBuffer();
        blob = new Blob([buf], { type: "application/gzip" });
      }
    } catch (_) {
      log.debug("replay/replay.downloadReplayFile", _);
    }
    if (!blob) blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date(data.meta && data.meta.date ? data.meta.date : clock.wall());
    const p = (n) => String(n).padStart(2, "0");
    a.href = url;
    a.download =
      "TetriZZ_" +
      ((data.meta && data.meta.modeName) || "replay").replace(/[^A-Za-z0-9]+/g, "") +
      "_" +
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      "-" +
      p(d.getHours()) +
      p(d.getMinutes()) +
      p(d.getSeconds()) +
      ".tzzreplay";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (_) {
    showGameAlert("Could not export the replay.");
  }
}

export function loadReplayFromFile(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const u8 = new Uint8Array(e.target.result);
      let txt = null;
      if (u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
        if (typeof DecompressionStream === "undefined") {
          showGameAlert("This replay is compressed and this browser can't open it.");
          return;
        }
        txt = await new Response(
          new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip")),
        ).text();
      } else {
        txt = new TextDecoder("utf-8").decode(u8);
      }
      const data = JSON.parse(txt);
      if (data && data.meta && data.rounds) {
        saveReplayToStorage(data);
        startReplay(data);
      } else showGameAlert("Invalid replay file.");
    } catch (err) {
      showGameAlert("Failed to parse replay file.");
    }
  };
  reader.readAsArrayBuffer(file);
}

export function replayActivity(ev) {
  if (game.state !== "replay") return;

  if (ev && ev.type === "pointermove") {
    const n = clock.now();
    if (n - replayState._replayActLast < 250) return;
    replayState._replayActLast = n;
  }
  replayShowControls();
}

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  window.matchMedia("(display-mode: minimal-ui)").matches ||
  navigator.standalone === true;
