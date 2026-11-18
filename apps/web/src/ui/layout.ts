// @ts-nocheck
import { clock } from "../core/clock";
import { storage } from "../core/storage";
import { log } from "../core/logger";
import { HID, MOBILE, PRACTICE_DEFAULTS, clamp, configState } from "../core/config";
import { rgba, shade } from "../render/theme";
import { bindingsState } from "../input/bindings";
import { RESTART_HOLD_MS, game } from "../game/state";
import { drawHold, drawMini, drawNexts, drawThemePreview } from "../render/render";
import { startCountdown } from "../game/game";
import { fitAllStats, isBattle, menusState, presetScoreFont } from "./menus";
import { mpComputeU, versusLobbyState, vsGarbageMode } from "../versus/lobby";
import { resetGaugeCache } from "../versus/garbage";
import { layoutMp } from "../versus/rounds";
import { onlineSessionState } from "../net/online-session";

export const layoutState = {
  wrap: undefined,
  bcv: undefined,
  g: undefined,
  holdCv: undefined,
  nextCvs: undefined,
  nextItems: undefined,
  elScore: undefined,
  elLevel: undefined,
  elLines: undefined,
  elTime: undefined,
  elPieces: undefined,
  elPps: undefined,
  pScoreH3: undefined,
  lvlK: undefined,
  lnK: undefined,
  comboChip: undefined,
  b2bChip: undefined,
  actionLine: undefined,
  bannerEl: undefined,
  headerEl: undefined,
  mainEl: undefined,
  colL: undefined,
  colR: undefined,
  restartHoldEl: undefined,
  restartHoldBar: undefined,
  dpr: 1,
  vw: 0,
  vh: 0,
  _panelUnitCache: null,
  _layoutSoonAt: 0,
  _layoutSoonT: null,
  _resizeRaf: null,
};

export const $ = (id) => document.getElementById(id);

export function clampPractice() {
  configState.practice.level = clamp(Math.round(+configState.practice.level || 0), 0, 20);
  configState.practice.width = clamp(Math.round(+configState.practice.width || 10), 4, 20);
  configState.practice.height = clamp(Math.round(+configState.practice.height || 20), 4, 40);
  configState.practice.garbage = clamp(Math.round(+configState.practice.garbage || 0), 0, 40);
  configState.practice.mess = clamp(Math.round(+configState.practice.mess || 0), 0, 100);
  configState.practice.autoIntervalMin = clamp(
    Math.round(+configState.practice.autoIntervalMin || 8),
    1,
    120,
  );
  configState.practice.autoIntervalMax = clamp(
    Math.round(+configState.practice.autoIntervalMax || 15),
    1,
    120,
  );
  if (configState.practice.autoIntervalMin > configState.practice.autoIntervalMax)
    configState.practice.autoIntervalMax = configState.practice.autoIntervalMin;
  configState.practice.autoMin = clamp(Math.round(+configState.practice.autoMin || 0), 0, 20);
  configState.practice.autoMax = clamp(Math.round(+configState.practice.autoMax || 0), 0, 20);
  if (configState.practice.autoMin > configState.practice.autoMax)
    configState.practice.autoMax = configState.practice.autoMin;
  configState.practice.levelUp = !!configState.practice.levelUp;
  configState.practice.disableHold = !!configState.practice.disableHold;
  configState.practice.infiniteHold = !!configState.practice.infiniteHold;
  configState.practice.disableLock = !!configState.practice.disableLock;
  configState.practice.autoGarbage = !!configState.practice.autoGarbage;
  if (document.body)
    document.body.classList.toggle(
      "practice-default",
      configState.mode === "practice" && configState.practice.height === 20,
    );
}

export function savePractice() {
  try {
    storage.set("tetris_practice", JSON.stringify(configState.practice));
  } catch (_) {
    log.debug("ui/layout.savePractice", _);
  }
}

export function loadPractice() {
  try {
    const o = JSON.parse(storage.get("tetris_practice"));
    if (o && typeof o === "object") {
      configState.practice = { ...PRACTICE_DEFAULTS, ...o };
      if (o.autoInterval !== undefined && o.autoIntervalMin === undefined) {
        configState.practice.autoIntervalMin = o.autoInterval;
        configState.practice.autoIntervalMax = o.autoInterval;
      }
    }
  } catch (e) {
    log.debug("loadPractice", e);
  }
  clampPractice();
}

export function applyGeometry() {
  let sideU;
  if (configState.mode === "wide") sideU = MOBILE.matches ? 4 : 5;
  else if (configState.mode === "vsbot") sideU = MOBILE.matches ? 3.2 : 4;
  else sideU = MOBILE.matches ? 3.2 : 5;
  document.body.style.setProperty("--cols", configState.COLS);
  document.body.style.setProperty("--vis", configState.VIS);
  document.body.style.setProperty("--vdiv", configState.VIS + 4.3);
  document.body.style.setProperty("--sideU", sideU);
  document.body.style.setProperty("--gapU", 0.7);
  document.body.classList.toggle("practice", configState.mode === "practice");
  document.body.classList.toggle("wide", configState.mode === "wide");
  document.body.classList.toggle("vsbot", configState.mode === "vsbot");
  document.body.classList.toggle(
    "practice-default",
    configState.mode === "practice" && configState.practice.height === 20,
  );
}

function positionRestartHold() {
  if (!layoutState.restartHoldEl) return;
  const r = layoutState.wrap.getBoundingClientRect();
  layoutState.restartHoldEl.style.left = r.left + "px";
  layoutState.restartHoldEl.style.width = r.width + "px";
  layoutState.restartHoldEl.style.top = r.bottom + 2 + "px";
}

function showRestartHold() {
  if (!layoutState.restartHoldEl) return;
  positionRestartHold();
  layoutState.restartHoldEl.style.display = "block";
  if (layoutState.restartHoldBar) layoutState.restartHoldBar.style.width = "0%";
}

function hideRestartHold() {
  if (!layoutState.restartHoldEl) return;
  layoutState.restartHoldEl.style.display = "none";
  if (layoutState.restartHoldBar) layoutState.restartHoldBar.style.width = "0%";
}

export function beginRestartHold() {
  if (game.state === "menu") return;
  if (onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame) return;
  if (game.restartHoldState.active) return;
  game.restartHoldState.active = true;
  game.restartHoldState.start = clock.now();
  showRestartHold();
  updateRestartHold();
}

export function cancelRestartHold() {
  if (!game.restartHoldState.active) return;
  game.restartHoldState.active = false;
  if (game.restartHoldState.raf) cancelAnimationFrame(game.restartHoldState.raf);
  game.restartHoldState.raf = null;
  hideRestartHold();
}

function updateRestartHold() {
  if (!game.restartHoldState.active) return;
  positionRestartHold();
  const elapsed = clock.now() - game.restartHoldState.start;
  const p = Math.min(1, elapsed / RESTART_HOLD_MS);
  if (layoutState.restartHoldBar) layoutState.restartHoldBar.style.width = p * 100 + "%";
  if (p >= 1) {
    game.restartHoldState.active = false;
    game.restartHoldState.raf = null;
    hideRestartHold();
    startCountdown();
    return;
  }
  game.restartHoldState.raf = requestAnimationFrame(updateRestartHold);
}

function panelUnit() {
  if (layoutState._panelUnitCache !== null) return layoutState._panelUnitCache;
  const sample = document.querySelector(".panel");
  if (sample) {
    const pt = parseFloat(getComputedStyle(sample).paddingTop);
    if (pt > 0) {
      layoutState._panelUnitCache = pt / 0.34;
      return layoutState._panelUnitCache;
    }
  }
  return game.CELL;
}

export function layoutPieceModal() {
  document.querySelectorAll("#pieceGrid .piece-btn").forEach((b) => {
    const cv = b.querySelector("canvas");
    if (!cv) return;
    const r = b.getBoundingClientRect();
    const w = Math.max(1, r.width - 10),
      h = Math.max(1, r.height - 10);
    cv.width = Math.round(w * layoutState.dpr);
    cv.height = Math.round(h * layoutState.dpr);
    const idx = +b.dataset.idx;
    drawMini(cv, idx, 1, Math.min(w, h) / 5);
  });
}

export function layout() {
  menusState._fitEpoch++;
  layoutState._panelUnitCache = null;
  const _vsOn = versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive;
  layoutState.dpr = Math.min(
    window.devicePixelRatio || 1,
    MOBILE.matches ? (_vsOn ? 1.25 : 1.5) : 2,
  );
  resetGaugeCache();
  if (MOBILE.matches) {
    if (!bindingsState.touchBtnsOn) document.body.style.setProperty("--barH", "0px");
    else document.body.style.removeProperty("--barH");
  }
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) mpComputeU();
  const ww = layoutState.wrap.clientWidth;
  layoutState.vw = ww;
  game.CELL = ww / Math.max(1, configState.COLS);
  game.MINI = panelUnit();
  layoutState.vh = game.CELL * configState.ROWS;
  layoutState.bcv.style.width = layoutState.vw + "px";
  layoutState.bcv.style.height = layoutState.vh + 2 * game.CELL + "px";
  layoutState.bcv.style.top = -HID * game.CELL - 2 * game.CELL + "px";
  const _bw = Math.round(layoutState.vw * layoutState.dpr),
    _bh = Math.round((layoutState.vh + 2 * game.CELL) * layoutState.dpr);
  if (layoutState.bcv.width !== _bw) layoutState.bcv.width = _bw;
  if (layoutState.bcv.height !== _bh) layoutState.bcv.height = _bh;
  const _sm = document.body.classList.contains("splitMob") ? 3.5 : 2.4;
  const slot = Math.max(2, Math.round(_sm * game.MINI));
  layoutState.nextItems.forEach((it) => {
    it.style.height = slot + "px";
  });
  layoutState.holdCv.style.height = slot + "px";
  [layoutState.holdCv, ...layoutState.nextCvs].forEach((cv) => {
    const q = cv.getBoundingClientRect();
    cv.width = Math.round(q.width * layoutState.dpr);
    cv.height = Math.round(q.height * layoutState.dpr);
  });
  presetScoreFont(layoutState.elScore, isBattle() ? "999" : "9,999,999");
  presetScoreFont(
    $("botScore"),
    versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive && vsGarbageMode()
      ? "999"
      : "9,999,999,999",
  );
  drawHold();
  drawNexts();
  drawThemePreview();
  fitAllStats();
  balanceVertical();
  layoutPieceModal();
  layoutMp(slot);
}

export function layoutSoon(ms) {
  const at = clock.now() + (ms || 0);
  if (layoutState._layoutSoonT != null && at <= layoutState._layoutSoonAt) return;
  layoutState._layoutSoonAt = at;
  if (layoutState._layoutSoonT != null) clearTimeout(layoutState._layoutSoonT);
  layoutState._layoutSoonT = setTimeout(
    function () {
      layoutState._layoutSoonT = null;
      layoutState._layoutSoonAt = 0;
      layout();
      if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) layoutMp();
    },
    Math.max(16, at - clock.now()),
  );
}

export function trackHdr(ms) {
  clearTimeout(trackHdr._t);
  trackHdr._t = setTimeout(() => {
    if (
      (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) ||
      game.state === "playing" ||
      game.state === "countdown"
    )
      layout();
  }, ms || 450);
}

export function balanceVertical() {
  if (configState._balancePending) return;
  if (MOBILE.matches) {
    if (!document.body.classList.contains("splitMob")) {
      layoutState.mainEl.style.paddingTop = "";
      layoutState.mainEl.style.alignContent = "";
    }
    return;
  }

  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
    layoutState.mainEl.style.paddingTop = "";
    layoutState.mainEl.style.alignContent = "";
    return;
  }
  const practiceDefault = configState.mode === "practice" && configState.practice.height === 20;
  if (
    (configState.mode === "practice" && !practiceDefault) ||
    configState.mode === "vsbot" ||
    configState.mode === "wide"
  ) {
    layoutState.mainEl.style.paddingTop = "";
    layoutState.mainEl.style.alignContent = "";
    return;
  }

  const cs = getComputedStyle(layoutState.mainEl);
  const padB = parseFloat(cs.paddingBottom) || 0;
  const screenH = layoutState.mainEl.clientHeight;
  const hdrB = layoutState.headerEl.getBoundingClientRect().bottom;
  const boardPx = layoutState.wrap.clientHeight;
  if (boardPx < 20) return;
  const contentPx =
    configState.mode === "practice"
      ? Math.max(boardPx, layoutState.colL.offsetHeight, layoutState.colR.offsetHeight)
      : boardPx;

  const desired = hdrB + (screenH - hdrB - contentPx) / 2;
  const lower = hdrB + 3 * game.CELL + 6;
  const upper = screenH - contentPx - padB - 6;

  const _bvPad = Math.max(lower, Math.min(upper, desired));
  const _bvCur = parseFloat(layoutState.mainEl.style.paddingTop) || 0;
  if (layoutState.mainEl.style.paddingTop && Math.abs(_bvPad - _bvCur) < 2) return;
  layoutState.mainEl.style.paddingTop = Math.round(_bvPad) + "px";
  layoutState.mainEl.style.alignContent = "start";
}

export function rr(c, x, y, w, h, r) {
  c.beginPath();
  if (!(w > 0) || !(h > 0)) return;
  if (c.roundRect) {
    c.roundRect(x, y, w, h, Math.max(0, r));
  } else {
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
}

export function shapeRR(c, x, y, w, h, sh) {
  let ins, r;
  if (sh === "flat") {
    ins = 0;
    r = 0;
  } else if (sh === "square") {
    ins = 1;
    r = 0;
  } else if (sh === "circle") {
    ins = 1;
    r = Math.max(3, w * 0.44);
  } else if (sh === "tile") {
    ins = Math.max(1.5, w * 0.06);
    r = Math.max(1, w * 0.05);
  } else {
    ins = 1;
    r = Math.max(2, w * 0.16);
  }
  const px = x + ins,
    py = y + ins,
    pw = w - ins * 2,
    ph = h - ins * 2;
  const rad = Math.min(r, pw / 2);
  rr(c, px, py, pw, ph, rad);
}

export function makeComponent(cells, v) {
  const set = new Set();
  for (const [x, y] of cells) set.add(x + "," + y);
  const segs = [];
  let x0 = 1e9,
    y0 = 1e9,
    x1 = -1e9,
    y1 = -1e9;
  for (const [x, y] of cells) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x + 1 > x1) x1 = x + 1;
    if (y + 1 > y1) y1 = y + 1;
    if (!set.has(x - 1 + "," + y)) segs.push({ d: "l", x1: x, y1: y, x2: x, y2: y + 1 });
    if (!set.has(x + 1 + "," + y)) segs.push({ d: "r", x1: x + 1, y1: y, x2: x + 1, y2: y + 1 });
    if (!set.has(x + "," + (y - 1))) segs.push({ d: "t", x1: x, y1: y, x2: x + 1, y2: y });
    if (!set.has(x + "," + (y + 1))) segs.push({ d: "b", x1: x, y1: y + 1, x2: x + 1, y2: y + 1 });
  }
  return { v, set, segs, path: segsToPath(segs), x0, y0, x1, y1 };
}

function segsToPath(segs) {
  const path = new Path2D();
  const n = segs.length;
  const used = new Uint8Array(n);
  const adj = new Map();
  const pk = (x, y) => x + "," + y;
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    const a = pk(s.x1, s.y1),
      b = pk(s.x2, s.y2);
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(i);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(b).push(i);
  }
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const s0 = segs[i];
    path.moveTo(s0.x1, s0.y1);
    let cx = s0.x2,
      cy = s0.y2,
      prev = i;
    path.lineTo(cx, cy);
    let guard = 0;
    while (guard++ <= n) {
      if (cx === s0.x1 && cy === s0.y1) break;
      const list = adj.get(pk(cx, cy));
      let next = -1;
      if (list)
        for (const j of list) {
          if (j !== prev && !used[j]) {
            next = j;
            break;
          }
        }
      if (next < 0) break;
      used[next] = 1;
      const s = segs[next];
      if (s.x1 === cx && s.y1 === cy) {
        cx = s.x2;
        cy = s.y2;
      } else {
        cx = s.x1;
        cy = s.y1;
      }
      path.lineTo(cx, cy);
      prev = next;
    }
    path.closePath();
  }
  return path;
}

export function paintFlatComponent(c, comp, col) {
  const { path, segs, x0, y0, x1, y1 } = comp;
  const w = x1 - x0,
    h = y1 - y0;
  const fin = configState.blockStyle;
  if (fin === "bevel") {
    c.fillStyle = col.base;
    c.fill(path, "evenodd");
    c.save();
    c.clip(path, "evenodd");
    c.lineCap = "butt";
    c.lineWidth = 0.28;
    c.beginPath();
    for (const s of segs)
      if (s.d === "t" || s.d === "l") {
        c.moveTo(s.x1, s.y1);
        c.lineTo(s.x2, s.y2);
      }
    c.strokeStyle = col.hi;
    c.globalAlpha = 0.5;
    c.stroke();
    c.beginPath();
    for (const s of segs)
      if (s.d === "b" || s.d === "r") {
        c.moveTo(s.x1, s.y1);
        c.lineTo(s.x2, s.y2);
      }
    c.strokeStyle = col.lo;
    c.stroke();
    c.restore();
  } else if (fin === "glossy") {
    const gr = c.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, shade(col.base, 0.55));
    gr.addColorStop(0.38, col.base);
    gr.addColorStop(1, shade(col.base, -0.45));
    c.fillStyle = gr;
    c.fill(path, "evenodd");
    c.save();
    c.clip(path, "evenodd");
    c.globalAlpha = 0.3;
    c.fillStyle = "#fff";
    c.fillRect(x0, y0 + h * 0.05, w, h * 0.22);
    c.restore();
  } else if (fin === "glassy") {
    c.save();
    c.globalAlpha = 0.3;
    c.fillStyle = col.base;
    c.fill(path, "evenodd");
    c.restore();
    const lg = c.createLinearGradient(0, y0, 0, y1);
    lg.addColorStop(0, "rgba(255,255,255,.26)");
    lg.addColorStop(1, "rgba(255,255,255,.10)");
    c.fillStyle = lg;
    c.fill(path, "evenodd");
    c.save();
    c.globalAlpha = 0.6;
    c.strokeStyle = rgba(col.base, 0.85);
    c.lineWidth = 0.06;
    c.beginPath();
    for (const s of segs) {
      c.moveTo(s.x1, s.y1);
      c.lineTo(s.x2, s.y2);
    }
    c.stroke();
    c.restore();
  } else {
    c.fillStyle = col.base;
    c.fill(path, "evenodd");
  }
}

export function computeFlatComponents(bd) {
  bd = bd || game.board;
  const comps = [];
  const seen = new Uint8Array(configState.ROWS * configState.COLS);
  for (let y = 0; y < configState.ROWS; y++)
    for (let x = 0; x < configState.COLS; x++) {
      const v = bd[y][x];
      if (!v || seen[y * configState.COLS + x]) continue;
      const cells = [];
      const q = [[x, y]];
      seen[y * configState.COLS + x] = 1;
      while (q.length) {
        const [cx, cy] = q.pop();
        cells.push([cx, cy]);
        const nb = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of nb) {
          if (nx < 0 || nx >= configState.COLS || ny < 0 || ny >= configState.ROWS) continue;
          const i = ny * configState.COLS + nx;
          if (!seen[i] && bd[ny][nx] === v) {
            seen[i] = 1;
            q.push([nx, ny]);
          }
        }
      }
      comps.push(makeComponent(cells, v));
    }
  return comps;
}
