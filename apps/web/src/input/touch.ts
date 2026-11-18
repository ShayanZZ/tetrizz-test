// @ts-nocheck
import { PIECES } from "@tetrizz/core";
import { log } from "../core/logger";
import { storage } from "../core/storage";
import { HID, configState, gridScale } from "../core/config";
import { themeState } from "../render/theme";
import { bindingsState } from "./bindings";
import { $, computeFlatComponents, layoutState } from "../ui/layout";
import {
  drawCell,
  drawFlatComps,
  drawGhostFlatComp,
  drawPieceFlatComp,
  getCellEpoch,
  getParticleSprite,
} from "../render/render";
import { drawGhostCellShape } from "../ui/screens";
import { btnDown, btnUp } from "./gamepad";

export const touchState = {
  touchOrder: undefined,
  touchSel: undefined,
  touchPresets: undefined,
};

const TOUCH_ACTIONS = ["r180", "ccw", "cw", "hold", "soft", "left", "right", "hard"];

export const TOUCH_DEFAULT_ORDER = ["hold", "ccw", "cw", "r180", "soft", "left", "right", "hard"];

const TOUCH_PRESET_MAX = 8;

const TOUCH_ICON = {
  ccw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="transform:scaleX(-1)"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
  cw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  right:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
};

function isValidTouchOrder(a) {
  if (!Array.isArray(a) || a.length !== TOUCH_ACTIONS.length) return false;
  const s = new Set(a);
  return s.size === TOUCH_ACTIONS.length && TOUCH_ACTIONS.every((x) => s.has(x));
}

export function loadTouchOrder() {
  try {
    const a = JSON.parse(storage.get("tetris_touch_order"));
    touchState.touchOrder = isValidTouchOrder(a) ? a.slice() : TOUCH_DEFAULT_ORDER.slice();
  } catch (_) {
    touchState.touchOrder = TOUCH_DEFAULT_ORDER.slice();
  }
}

export function saveTouchOrder() {
  try {
    storage.set("tetris_touch_order", JSON.stringify(touchState.touchOrder));
  } catch (_) {
    log.debug("input/touch.saveTouchOrder", _);
  }
}

export function loadTouchPresets() {
  try {
    const a = JSON.parse(storage.get("tetris_touch_presets"));
    touchState.touchPresets = Array.isArray(a)
      ? a
          .filter((p) => p && typeof p.name === "string" && isValidTouchOrder(p.order))
          .slice(0, TOUCH_PRESET_MAX)
      : [];
  } catch (_) {
    touchState.touchPresets = [];
  }
}

function saveTouchPresets() {
  try {
    storage.set("tetris_touch_presets", JSON.stringify(touchState.touchPresets));
  } catch (_) {
    log.debug("input/touch.saveTouchPresets", _);
  }
}

function sanitizePresetName(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 _\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 14)
    .trim();
}

export function applyTouchPreset(name) {
  const p = touchState.touchPresets.find((x) => x.name === name);
  if (!p || !isValidTouchOrder(p.order)) return;
  touchState.touchOrder = p.order.slice();
  touchState.touchSel = null;
  saveTouchOrder();
  renderTouchBars();
  renderTouchEditor();
  renderTouchPresets();
}

export function deleteTouchPreset(name) {
  touchState.touchPresets = touchState.touchPresets.filter((x) => x.name !== name);
  saveTouchPresets();
  renderTouchPresets();
}

export function saveTouchPreset(btn) {
  const row = btn.closest(".tp-saverow");
  const inp = row && row.querySelector(".tp-name");
  let name = sanitizePresetName(inp && inp.value);
  if (!name) name = "LAYOUT " + (touchState.touchPresets.length + 1);
  const existing = touchState.touchPresets.find((p) => p.name === name);
  if (existing) existing.order = touchState.touchOrder.slice();
  else {
    if (touchState.touchPresets.length >= TOUCH_PRESET_MAX) return;
    touchState.touchPresets.push({ name: name, order: touchState.touchOrder.slice() });
  }
  saveTouchPresets();
  renderTouchPresets();
  document.querySelectorAll(".tp-name").forEach((i) => {
    i.value = "";
  });
}

export function renderTouchPresets() {
  const cur = JSON.stringify(touchState.touchOrder);
  const html = touchState.touchPresets.length
    ? touchState.touchPresets
        .map((p) => {
          const active = JSON.stringify(p.order) === cur;
          return `<span class="tp-chip${active ? " active" : ""}"><button type="button" class="tp-apply" data-name="${p.name}">${p.name}</button><button type="button" class="tp-del" data-name="${p.name}" title="Delete preset">×</button></span>`;
        })
        .join("")
    : '<span class="tp-empty">No saved presets yet — arrange the buttons above, then save.</span>';
  document.querySelectorAll(".touch-preset-list").forEach((el) => {
    el.innerHTML = html;
  });
}

function touchLabel(a) {
  const L = {
    r180: "180°",
    ccw: "Rotate CCW",
    cw: "Rotate CW",
    hold: "Hold",
    soft: "Soft Drop",
    left: "Move Left",
    right: "Move Right",
    hard: "Hard Drop",
  };
  return L[a] || a;
}

function touchShortLabel(a) {
  const L = {
    r180: "180°",
    ccw: "CCW",
    cw: "CW",
    hold: "HOLD",
    soft: "SOFT",
    left: "LEFT",
    right: "RIGHT",
    hard: "DROP",
  };
  return L[a] || a;
}

function touchButtonContent(a) {
  if (TOUCH_ICON[a]) return TOUCH_ICON[a];
  if (a === "r180") return "180°";
  if (a === "hold") return "HOLD";
  if (a === "soft") return "SOFT";
  if (a === "hard") return "DROP";
  return a;
}

function renderTouchBarEl(el) {
  if (!el) return;
  el.innerHTML = touchState.touchOrder
    .map(
      (a) =>
        `<button class="tbtn" data-a="${a}" aria-label="${touchLabel(a)}">${touchButtonContent(a)}</button>`,
    )
    .join("");
  el.querySelectorAll(".tbtn").forEach((b) => {
    const a = b.dataset.a;
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      btnDown(a, el);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((ev) =>
      b.addEventListener(ev, () => btnUp(a, el)),
    );
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    if (!window.PointerEvent) {
      b.addEventListener(
        "touchstart",
        (e) => {
          e.preventDefault();
          btnDown(a, el);
        },
        { passive: false },
      );
      ["touchend", "touchcancel"].forEach((ev) => b.addEventListener(ev, () => btnUp(a, el)));
    }
  });
}

export function renderTouchBars() {
  renderTouchBarEl($("touch"));
  renderTouchBarEl($("touch2"));
}

export function renderTouchEditor() {
  document.querySelectorAll(".touch-edit-grid").forEach((grid) => {
    grid.innerHTML = touchState.touchOrder
      .map(
        (a, i) =>
          `<button type="button" class="touch-edit-btn${i === touchState.touchSel ? " sel" : ""}" data-idx="${i}" aria-label="${touchLabel(a)}">${touchButtonContent(a)}<span class="te-label">${touchShortLabel(a)}</span></button>`,
      )
      .join("");
  });
}

export function handleTouchEditClick(idx) {
  if (touchState.touchSel === null) touchState.touchSel = idx;
  else if (touchState.touchSel === idx) touchState.touchSel = null;
  else {
    const from = touchState.touchSel;
    const tmp = touchState.touchOrder[from];
    touchState.touchOrder[from] = touchState.touchOrder[idx];
    touchState.touchOrder[idx] = tmp;
    touchState.touchSel = null;
    saveTouchOrder();
    renderTouchBars();
  }
  renderTouchEditor();
  renderTouchPresets();
}

export function resetTouchLayout() {
  touchState.touchOrder = TOUCH_DEFAULT_ORDER.slice();
  touchState.touchSel = null;
  saveTouchOrder();
  renderTouchBars();
  renderTouchEditor();
  renderTouchPresets();
}

export function drawFieldTo(c, bd, pObj, parts, cellPx, cssW, cssH, danger, cfFn) {
  if (cssW < 2 || cssH < 2 || !(cellPx > 0.5)) return;
  const PAD = 2 * cellPx;
  const wellH = cssH - PAD;
  c.setTransform(layoutState.dpr, 0, 0, layoutState.dpr, 0, 0);
  c.translate(0, PAD);
  c.clearRect(0, -PAD, cssW, wellH + PAD);
  const cell = cellPx;
  const useFlat = configState.blockShape === "flat";
  const Lmap = drawFieldTo.Lmap || (drawFieldTo.Lmap = new WeakMap());
  let L = Lmap.get(c);
  if (!L) {
    L = {
      cv: document.createElement("canvas"),
      ctx: null,
      fp: 1,
      cell: 0,
      w: 0,
      h: 0,
      shape: "",
      style: "",
      theme: "",
      cvTheme: null,
      grid: -1,
      dpr: 0,
      devicePx: 0,
      epoch: -1,
      useFlat: null,
    };
    L.ctx = L.cv.getContext("2d");
    Lmap.set(c, L);
  }
  const devicePx = window.devicePixelRatio || 1;
  const epoch = getCellEpoch();
  let fp = 2166136261 >>> 0;
  for (let y = 0; y < configState.ROWS; y++) {
    const row = bd[y];
    for (let x = 0; x < configState.COLS; x++) fp = Math.imul(fp ^ (row[x] | 0), 16777619) >>> 0;
  }
  const need =
    L.fp !== fp ||
    L.cell !== cell ||
    L.w !== cssW ||
    L.h !== cssH ||
    L.shape !== configState.blockShape ||
    L.style !== configState.blockStyle ||
    L.theme !== configState.colorTheme ||
    L.cvTheme !== themeState.cvTheme ||
    L.grid !== configState.gridVis ||
    L.dpr !== layoutState.dpr ||
    L.devicePx !== devicePx ||
    L.epoch !== epoch ||
    L.useFlat !== useFlat;
  if (need) {
    const lw = Math.max(1, Math.round(cssW * layoutState.dpr)),
      lh = Math.max(1, Math.round(cssH * layoutState.dpr));
    if (L.cv.width !== lw || L.cv.height !== lh) {
      L.cv.width = lw;
      L.cv.height = lh;
    }
    const lc = L.ctx;
    lc.setTransform(layoutState.dpr, 0, 0, layoutState.dpr, 0, 0);
    lc.translate(0, PAD);
    lc.clearRect(0, -PAD, cssW, wellH + PAD);
    const r = Math.max(0, Math.min(cell * 0.32, cell));
    const wy = HID * cell;
    const wpathL = () => {
      lc.beginPath();
      lc.moveTo(0, wy);
      lc.lineTo(0, wellH - r);
      lc.quadraticCurveTo(0, wellH, r, wellH);
      lc.lineTo(cssW - r, wellH);
      lc.quadraticCurveTo(cssW, wellH, cssW, wellH - r);
      lc.lineTo(cssW, wy);
    };
    const flatComps = useFlat ? computeFlatComponents(bd) : null;
    if (useFlat) {
      drawFlatComps(lc, flatComps, cell);
    } else {
      for (let y = 0; y < HID; y++)
        for (let x = 0; x < configState.COLS; x++) {
          const v = bd[y][x];
          if (!v) continue;
          drawCell(lc, x * cell, y * cell, cell, v - 1, false);
        }
    }
    wpathL();
    lc.fillStyle = themeState.cvTheme.well;
    lc.fill();
    lc.save();
    wpathL();
    lc.clip();
    if (configState.gridVis > 0) {
      const alpha = Math.min(0.6, themeState.cvTheme.gridA * gridScale());
      lc.strokeStyle = `rgba(${themeState.cvTheme.gridRGB},${alpha.toFixed(3)})`;
      lc.lineWidth = 1;
      lc.beginPath();
      for (let x = 1; x < configState.COLS; x++) {
        lc.moveTo(x * cell + 0.5, wy);
        lc.lineTo(x * cell + 0.5, wellH);
      }
      for (let y = HID + 1; y < configState.ROWS; y++) {
        lc.moveTo(0, y * cell + 0.5);
        lc.lineTo(cssW, y * cell + 0.5);
      }
      lc.stroke();
    }
    if (useFlat) {
      drawFlatComps(lc, flatComps, cell);
    } else {
      for (let y = HID; y < configState.ROWS; y++)
        for (let x = 0; x < configState.COLS; x++) {
          const v = bd[y][x];
          if (!v) continue;
          drawCell(lc, x * cell, y * cell, cell, v - 1, false);
        }
    }
    lc.restore();
    L.fp = fp;
    L.cell = cell;
    L.w = cssW;
    L.h = cssH;
    L.shape = configState.blockShape;
    L.style = configState.blockStyle;
    L.theme = configState.colorTheme;
    L.cvTheme = themeState.cvTheme;
    L.grid = configState.gridVis;
    L.dpr = layoutState.dpr;
    L.devicePx = devicePx;
    L.epoch = epoch;
    L.useFlat = useFlat;
  }
  c.drawImage(L.cv, 0, -PAD, cssW, cssH);
  const r = Math.max(0, Math.min(cell * 0.32, cell));
  const wy = HID * cell;
  const wpath = () => {
    c.beginPath();
    c.moveTo(0, wy);
    c.lineTo(0, wellH - r);
    c.quadraticCurveTo(0, wellH, r, wellH);
    c.lineTo(cssW - r, wellH);
    c.quadraticCurveTo(cssW, wellH, cssW, wellH - r);
    c.lineTo(cssW, wy);
  };
  const drawP = () => {
    if (!pObj) return;
    const cells = PIECES[pObj.type].cells[pObj.rot];
    let gy = pObj.y;
    while (!cfFn(cells, pObj.x, gy + 1)) gy++;
    const base = PIECES[pObj.type].c;
    const gcol = bindingsState.ghostMode === "gray" ? themeState.cvTheme.ghost : base;
    const showGhost = bindingsState.ghostMode !== "off";
    if (configState.blockShape === "flat") {
      if (showGhost) drawGhostFlatComp(c, cells, pObj.x, gy, cell, gcol);
      drawPieceFlatComp(c, cells, pObj.x, pObj.y, pObj.type, cell);
    } else {
      if (showGhost) {
        for (const q of cells) {
          const Y = gy + q[1];
          drawGhostCellShape(c, (pObj.x + q[0]) * cell, Y * cell, cell, gcol);
        }
      }
      for (const q of cells) {
        const Y = pObj.y + q[1];
        drawCell(c, (pObj.x + q[0]) * cell, Y * cell, cell, pObj.type, true);
      }
    }
  };
  c.save();
  wpath();
  c.clip();
  drawP();
  c.restore();
  if (pObj && pObj.y < HID) {
    c.save();
    c.beginPath();
    c.rect(0, -PAD, cssW, wy + PAD);
    c.clip();
    drawP();
    c.restore();
  }
  for (const pt of parts) {
    c.globalAlpha = Math.max(0, pt.life / pt.max);
    const ds = pt.size * 1.7;
    const spr = getParticleSprite(pt.col);
    c.drawImage(spr, pt.px * cell - ds / 2, pt.py * cell - ds / 2, ds, ds);
  }
  c.globalAlpha = 1;
  const bi = 1;
  c.beginPath();
  c.moveTo(bi, wy);
  c.lineTo(bi, wellH - r);
  c.quadraticCurveTo(bi, wellH - bi, r, wellH - bi);
  c.lineTo(cssW - r, wellH - bi);
  c.quadraticCurveTo(cssW - bi, wellH - bi, cssW - bi, wellH - r);
  c.lineTo(cssW - bi, wy);
  c.lineWidth = 2.5;
  c.strokeStyle = danger ? "rgba(245,84,107,.75)" : themeState.cvTheme.border;
  c.stroke();
}
