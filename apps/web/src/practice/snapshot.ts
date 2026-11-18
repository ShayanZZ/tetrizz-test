// @ts-nocheck
import { PIECES } from "@tetrizz/core";
import { escapeHtml } from "../core/escape";
import { HID, SDF_OPTS, clamp, configState } from "../core/config";
import { bindingsState } from "../input/bindings";
import { game } from "../game/state";
import { $, clampPractice, savePractice } from "../ui/layout";
import { startCountdown } from "../game/game";
import { refreshOpts, selectMode } from "../ui/settings";
import {
  addBoardEntry,
  drawStyledGrid,
  pieceAt,
  renderBoardList,
  syncPracticeToBoard,
  toast,
} from "./board-library";
import { MP, adjustBotStep, vsAdjust } from "../versus/lobby";

import {
  exitReplay,
  replayShowControls,
  replayState,
  rpEncodeBoard,
  rpIsMulti,
  rpSetPPIcon,
} from "../replay/replay";

export const snapshotState = {
  snapCtx: null,
  _snT: 0,
};

function snapOverlay(on) {
  const ov = $("ovSnap");
  if (!ov) return;
  if (on) {
    ov.classList.remove("hidden");
    ov.removeAttribute("inert");
    ov.querySelectorAll(".menu-screen").forEach((x) => x.classList.add("active"));
    const sc = ov.querySelector(".menu-scroll");
    if (sc) sc.scrollTop = 0;
  } else {
    ov.classList.add("hidden");
    ov.setAttribute("inert", "");
  }
  void ov.offsetHeight;
  if (on) snapFit();
  if (window.tzRepaint) {
    window.tzRepaint();
    setTimeout(window.tzRepaint, 260);
  }
}

function snapBoardOf(f, cols, vis) {
  const g = [];
  for (let y = 0; y < vis; y++) {
    const r = [];
    for (let x = 0; x < cols; x++) r.push((f.bd.charCodeAt((y + HID) * cols + x) || 48) - 48);
    g.push(r);
  }
  return g;
}

function snapBoardCanvas(cv, f, cols, vis, cs, withPiece) {
  cv.width = cols * cs;
  cv.height = vis * cs;
  cv.style.width = cv.width + "px";
  cv.style.height = cv.height + "px";
  const c = cv.getContext("2d");
  c.fillStyle = "#05070c";
  c.fillRect(0, 0, cv.width, cv.height);
  c.strokeStyle = "rgba(255,255,255,.07)";
  c.lineWidth = 1;
  c.beginPath();
  for (let i = 1; i < cols; i++) {
    c.moveTo(i * cs + 0.5, 0);
    c.lineTo(i * cs + 0.5, vis * cs);
  }
  for (let j = 1; j < vis; j++) {
    c.moveTo(0, j * cs + 0.5);
    c.lineTo(cols * cs, j * cs + 0.5);
  }
  c.stroke();
  const g = snapBoardOf(f, cols, vis);
  drawStyledGrid(c, g, cols, vis, cs, 0, 0);
  if (withPiece && Array.isArray(f.p) && f.p.length === 4 && PIECES[f.p[0]]) {
    c.globalAlpha = 0.8;
    const tg = Array.from({ length: vis }, () => new Array(cols).fill(0));
    for (const [cx, cy] of PIECES[f.p[0]].cells[f.p[1]]) {
      const X = f.p[2] + cx,
        Y = f.p[3] + cy - HID;
      if (X >= 0 && X < cols && Y >= 0 && Y < vis) tg[Y][X] = f.p[0] + 1;
    }
    drawStyledGrid(c, tg, cols, vis, cs, 0, 0);
    c.globalAlpha = 1;
  }
  c.strokeStyle = "rgba(120,140,190,.55)";
  c.lineWidth = 2;
  c.strokeRect(1, 1, cv.width - 2, cv.height - 2);
}

function snapPieces(cv, types, cs) {
  const n = Math.max(1, types.length);
  cv.width = 4 * cs;
  cv.height = n * 3 * cs;
  cv.style.width = cv.width + "px";
  cv.style.height = cv.height + "px";
  const c = cv.getContext("2d");
  c.clearRect(0, 0, cv.width, cv.height);
  types.forEach((t, k) => {
    const P = PIECES[t];
    if (!P) return;
    const cells = P.cells[0];
    let x0 = 9,
      x1 = -9,
      y0 = 9,
      y1 = -9;
    for (const [a, b] of cells) {
      x0 = Math.min(x0, a);
      x1 = Math.max(x1, a);
      y0 = Math.min(y0, b);
      y1 = Math.max(y1, b);
    }
    const w = x1 - x0 + 1,
      h = y1 - y0 + 1,
      ox = ((4 - w) * cs) / 2,
      oy = k * 3 * cs + ((3 - h) * cs) / 2;
    pieceAt(c, cells, t, ox, oy, cs, x0, y0);
  });
}

function snapHold(f) {
  return typeof f.h === "number" && f.h >= 0 ? f.h : null;
}

function snapSeq(f) {
  const q = [];
  if (Array.isArray(f.p) && f.p.length === 4 && PIECES[f.p[0]]) q.push(f.p[0]);
  if (Array.isArray(f.q)) for (const t of f.q.slice(0, 5)) q.push(t);
  return { q: q, rem: [], h: snapHold(f) };
}

function snapExtras(f) {
  const e = {
    queue: Array.isArray(f.q) ? f.q.slice(0, 5) : [],
    hold: snapHold(f),
    holdUsed: !!f.hu,
    piece: null,
  };
  if (Array.isArray(f.p) && f.p.length === 4 && PIECES[f.p[0]])
    e.piece = { type: f.p[0], rot: f.p[1], x: f.p[2], y: f.p[3] };
  return e;
}

function snapLabel(o, i) {
  const st = o.meta.stations && o.meta.stations[i];
  return ((st && st.label) || "PLAYER " + (i + 1)) + (st && st.bot ? " (BOT)" : "");
}

function snapActive() {
  const ov = $("ovSnap");
  if (ov) ov.querySelectorAll(".menu-screen").forEach((x) => x.classList.add("active"));
}

export function snapBack() {
  const o = snapshotState.snapCtx;
  if (o && o.view && o.frame.s.length > 1) snapShowPick();
  else {
    snapOverlay(false);
    snapshotState.snapCtx = null;
  }
}

function snapShowPick() {
  const o = snapshotState.snapCtx;
  if (!o) return;
  o.view = false;
  const sts = o.frame.s,
    cols = o.meta.cols || 10,
    vis = o.meta.vis || 20;
  $("snapTitle").textContent = "Choose a board";
  $("snapBody").innerHTML =
    '<div class="dev-note">Tap the board you want to practice from. The replay is paused at this moment.</div><div class="snap-grid">' +
    sts
      .map(
        (_, i) =>
          '<button type="button" class="snap-card" data-sn="' +
          i +
          '"><canvas></canvas><span>' +
          escapeHtml(snapLabel(o, i)) +
          "</span></button>",
      )
      .join("") +
    "</div>";
  const n = sts.length,
    per = Math.floor((Math.min(innerWidth - 48, 1100) - (n - 1) * 12) / n) - 24,
    K = Math.min(1, innerWidth * 0.00211, innerHeight * 0.00141),
    cs =
      innerWidth >= 800
        ? Math.max(2, Math.min(22, Math.floor(per / cols), Math.floor((innerHeight - 260) / vis)))
        : Math.max(2, Math.floor(Math.min(11, 150 / cols, 250 / vis) * K));
  snapActive();
  document
    .querySelectorAll("#snapBody .snap-card canvas")
    .forEach((cv, i) => snapBoardCanvas(cv, sts[i], cols, vis, cs, true));
}

export function snapShowView(i) {
  const o = snapshotState.snapCtx;
  if (!o) return;
  snapActive();
  o.idx = i;
  o.view = true;
  const f = o.frame.s[i],
    cols = o.meta.cols || 10,
    vis = o.meta.vis || 20;
  $("snapTitle").textContent =
    (o.frame.s.length > 1 ? snapLabel(o, i) + " · " : "") + "Practice position";
  $("snapBody").innerHTML =
    '<div class="snap-view"><div class="snap-col"><div class="snap-side"><div class="snap-lb">HOLD</div><canvas id="snHold"></canvas></div><div class="snap-side"><div class="snap-lb">CURRENT</div><canvas id="snCur"></canvas></div></div><canvas id="snBoard"></canvas><div class="snap-side"><div class="snap-lb">NEXT</div><canvas id="snNext"></canvas></div></div><div class="dev-note" id="snInfo" style="margin-top:12px;text-align:center"></div><div class="start-wrap" style="gap:8px;margin-top:6px"><button class="menu-btn" id="snSave" type="button" style="flex:1">SAVE BOARD</button><button class="menu-btn primary" id="snPlay" type="button" style="flex:1">PRACTICE NOW</button></div>';
  const cs = Math.max(
    2,
    Math.min(
      28,
      Math.floor(
        (innerWidth * 0.94 - 80 * Math.min(1, innerWidth * 0.00211, innerHeight * 0.00141)) /
          (cols + 6),
      ),
      Math.floor((innerHeight - 250) / vis),
    ),
  );
  snapBoardCanvas($("snBoard"), f, cols, vis, cs, true);
  const ps = Math.max(3, Math.min(18, Math.floor(cs * 0.75)));
  const h = snapHold(f);
  snapPieces($("snHold"), h === null ? [] : [h], ps);
  const cur = Array.isArray(f.p) && f.p.length === 4 && PIECES[f.p[0]] ? f.p[0] : null;
  snapPieces($("snCur"), cur === null ? [] : [cur], ps);
  snapPieces($("snNext"), Array.isArray(f.q) ? f.q.slice(0, 5) : [], ps);
  const g = snapBoardOf(f, cols, vis);
  let n = 0;
  for (const r of g) for (const v of r) if (v) n++;
  const L = "IJLOSTZ";
  $("snInfo").textContent =
    n +
    " blocks · " +
    cols +
    "×" +
    vis +
    " board · hold: " +
    (h === null ? "none" : L[h]) +
    " · current: " +
    (cur === null ? "—" : L[cur]) +
    " · next: " +
    ((f.q || [])
      .slice(0, 5)
      .map((t) => L[t])
      .join(" ") || "—");
  snapFit();
}

function snapFit() {
  const b = $("snapBody");
  if (!b) return;
  const sv = b.querySelector(".snap-view");
  if (!sv) return;
  sv.style.zoom = "";
  const avail = (document.documentElement.clientWidth || innerWidth) - 12,
    w = sv.scrollWidth;
  if (w > avail && avail > 0) sv.style.zoom = Math.max(0.15, avail / w);
}

export function snapRelayout() {
  const ov = $("ovSnap");
  if (!ov || ov.classList.contains("hidden") || !snapshotState.snapCtx) return;
  const b = $("snapBody");
  b.classList.add("noanim");
  if (snapshotState.snapCtx.view) snapShowView(snapshotState.snapCtx.idx);
  else snapShowPick();
  snapFit();
  setTimeout(() => b.classList.remove("noanim"), 120);
}

function rpLiveStates() {
  const mk = (bd, q, h, hu, p) => ({
    bd: rpEncodeBoard(bd),
    q: (q || []).slice(0, 5),
    h: typeof h === "number" ? h : -1,
    hu: hu ? 1 : 0,
    p: p ? [p.type, p.rot, p.x, p.y] : 0,
  });
  if (rpIsMulti())
    return MP.stations.map((st) => mk(st.board, st.queue, st.hold, st.holdUsed, st.piece));
  return game.board ? [mk(game.board, game.queue, game.hold, game.holdUsed, game.piece)] : [];
}

export function replayToPractice() {
  if (game.state !== "replay" || !replayState.replayPlayback || !replayState.replayAppliedFrame) {
    toast("Press play or drag the timeline first.");
    return;
  }
  replayState.replayPaused = true;
  replayState.replayPausedAtEnd = false;
  rpSetPPIcon();
  replayShowControls();
  const meta = replayState.replayPlayback.meta || {};
  const live = rpLiveStates();
  if (!live.length) {
    toast("This replay moment has no board data.");
    return;
  }
  snapshotState.snapCtx = { frame: { s: live }, meta: meta, idx: 0, view: false };
  if (live.length > 1) snapShowPick();
  else snapShowView(0);
  snapOverlay(true);
}

export function snapSave() {
  const o = snapshotState.snapCtx;
  if (!o) return false;
  const f = o.frame.s[o.idx],
    cols = o.meta.cols || 10,
    vis = o.meta.vis || 20;
  addBoardEntry(snapBoardOf(f, cols, vis), cols, vis, false);
  const ent = configState.practice.boards[configState.practice.boards.length - 1];
  if (ent) {
    ent.name = ("REPLAY " + snapLabel(o, o.idx).replace(/ \(BOT\)/, "")).toUpperCase().slice(0, 18);
    ent.note = "From a replay — hold and queue saved with it.";
    ent.seq = snapSeq(f);
  }
  savePractice();
  renderBoardList();
  return true;
}

export function snapPlay() {
  const o = snapshotState.snapCtx;
  if (!o) return;
  const f = o.frame.s[o.idx],
    cols = o.meta.cols || 10,
    vis = o.meta.vis || 20;
  configState.practice.tempBoard = {
    name: "REPLAY POSITION",
    cols: cols,
    vis: vis,
    grid: snapBoardOf(f, cols, vis),
    fixedSize: true,
    seq: snapSeq(f),
  };
  configState.practice.boardSel = -2;
  configState.practice.startExtras = snapExtras(f);
  syncPracticeToBoard(configState.practice.tempBoard);
  savePractice();
  snapOverlay(false);
  snapshotState.snapCtx = null;
  exitReplay();
  selectMode("practice");
  refreshPractice();
  startCountdown();
}

export function refreshPractice() {
  document.querySelectorAll(".step[data-t]").forEach((st) => {
    const k = st.dataset.t;
    const val = st.querySelector(".val");
    if (!val || val.querySelector("input")) return;
    val.textContent = configState.practice[k];
  });
  document.querySelectorAll('[data-tgl="levelUp"]').forEach((b) => {
    b.textContent = configState.practice.levelUp ? "ON" : "OFF";
    b.classList.toggle("off", !configState.practice.levelUp);
  });
  document.querySelectorAll('[data-tgl="disableHold"]').forEach((b) => {
    b.textContent = configState.practice.disableHold ? "ON" : "OFF";
    b.classList.toggle("off", !configState.practice.disableHold);
  });
  document.querySelectorAll('[data-tgl="infiniteHold"]').forEach((b) => {
    b.textContent = configState.practice.infiniteHold ? "ON" : "OFF";
    b.classList.toggle("off", !configState.practice.infiniteHold);
  });
  document.querySelectorAll('[data-tgl="disableLock"]').forEach((b) => {
    b.textContent = configState.practice.disableLock ? "ON" : "OFF";
    b.classList.toggle("off", !configState.practice.disableLock);
  });
  document.querySelectorAll('[data-tgl="autoGarbage"]').forEach((b) => {
    b.textContent = configState.practice.autoGarbage ? "ON" : "OFF";
    b.classList.toggle("off", !configState.practice.autoGarbage);
  });
}

export function activateStepButton(t) {
  const botStep = t.closest("[data-bot-step]");
  if (botStep && t.dataset.d !== undefined) {
    adjustBotStep(+botStep.dataset.slot, botStep.dataset.key, parseFloat(t.dataset.d));
    return true;
  }
  const vsStep = t.closest(".step[data-v]");
  if (vsStep && t.dataset.d !== undefined) {
    vsAdjust(vsStep.dataset.v, parseFloat(t.dataset.d));
    return true;
  }
  const prStep = t.closest(".step[data-t]");
  if (prStep && t.dataset.d !== undefined) {
    const k = prStep.dataset.t;
    configState.practice[k] = (+configState.practice[k] || 0) + +t.dataset.d;
    if (k === "autoMin" && configState.practice.autoMin > configState.practice.autoMax)
      configState.practice.autoMax = configState.practice.autoMin;
    if (k === "autoMax" && configState.practice.autoMax < configState.practice.autoMin)
      configState.practice.autoMin = configState.practice.autoMax;
    if (
      k === "autoIntervalMin" &&
      configState.practice.autoIntervalMin > configState.practice.autoIntervalMax
    )
      configState.practice.autoIntervalMax = configState.practice.autoIntervalMin;
    if (
      k === "autoIntervalMax" &&
      configState.practice.autoIntervalMax < configState.practice.autoIntervalMin
    )
      configState.practice.autoIntervalMin = configState.practice.autoIntervalMax;
    clampPractice();
    savePractice();
    refreshPractice();
    return true;
  }
  const optStep = t.closest(".step[data-s]");
  if (optStep && t.dataset.d !== undefined) {
    const s = optStep.dataset.s,
      d = +t.dataset.d;
    if (s === "das") configState.DAS = clamp(configState.DAS + d, 50, 300);
    else if (s === "arr") configState.ARR = clamp(configState.ARR + d, 0, 100);
    else if (s === "sdf")
      configState.sdfIdx = clamp(configState.sdfIdx + d, 0, SDF_OPTS.length - 1);
    else if (s === "fx") configState.fxStrength = clamp(configState.fxStrength + d, 0, 100);
    else if (s === "clearFx") configState.clearFx = clamp(configState.clearFx + d, 0, 100);
    else if (s === "grid") configState.gridVis = clamp(configState.gridVis + d, 0, 100);
    else if (s === "swipeSens") configState.swipeSens = clamp(configState.swipeSens + d, 1, 10);
    else if (s === "ghostOpacity")
      bindingsState.ghostOpacity = clamp(bindingsState.ghostOpacity + d, 0, 100);
    refreshOpts();
    return true;
  }
  return false;
}

export function stopStepHold() {
  if (game.holdRepeat.timeout) clearTimeout(game.holdRepeat.timeout);
  if (game.holdRepeat.interval) clearInterval(game.holdRepeat.interval);
  game.holdRepeat = { timeout: null, interval: null };
}

export function startStepHold(btn) {
  stopStepHold();
  game.holdRepeat.timeout = setTimeout(() => {
    game.holdRepeat.interval = setInterval(() => {
      if (!btn.isConnected || btn.disabled) {
        stopStepHold();
        return;
      }
      activateStepButton(btn);
    }, 70);
  }, 420);
}
