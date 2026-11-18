// @ts-nocheck
import { fxRandom } from "../core/random";
import { PIECES, tryRotateOn } from "@tetrizz/core";
import { HID, MAX_RESETS, MOBILE, clearScale, configState, dims } from "../core/config";
import { emitEvent } from "../core/events";
import { rgba, shade, themeState } from "./theme";
import { bindingsState } from "../input/bindings";
import { game, partPool } from "../game/state";
import { LEAN, SFX, collide, curCells, fx, fxSpin } from "../engine/engine";
import { $, layoutState, makeComponent, paintFlatComponent, rr } from "../ui/layout";
import { detectSpin } from "../game/game";
import { MP, versusLobbyState } from "../versus/lobby";

export const renderState = {
  actionState: "idle",
  actionTimer: null,
  actionSeq: 0,
  botComboChip: undefined,
  botB2bChip: undefined,
};

export function drawFlatComps(c, comps, cell) {
  for (const comp of comps) {
    const col = themeState.COL[comp.v - 1] || themeState.COL[0];
    c.save();
    c.scale(cell, cell);
    paintFlatComponent(c, comp, col);
    c.restore();
  }
}

export function drawPieceFlatComp(c, cells, px, py, type, cell) {
  const comp = makeComponent(cells, type + 1);
  const col = themeState.COL[type] || themeState.COL[0];
  c.save();
  c.translate(px * cell, py * cell);
  c.scale(cell, cell);
  paintFlatComponent(c, comp, col);
  c.restore();
}

export function drawGhostFlatComp(c, cells, px, py, cell, gcol) {
  const comp = makeComponent(cells, 0);
  const gAlpha = bindingsState.ghostOpacity / 100;
  c.save();
  c.translate(px * cell, py * cell);
  c.scale(cell, cell);
  c.globalAlpha = gAlpha * 0.4;
  c.fillStyle = gcol;
  c.fill(comp.path, "evenodd");
  c.globalAlpha = Math.min(1, gAlpha * 1.2);
  c.strokeStyle = gcol;
  c.lineWidth = 0.07;
  c.beginPath();
  for (const s of comp.segs) {
    c.moveTo(s.x1, s.y1);
    c.lineTo(s.x2, s.y2);
  }
  c.stroke();
  c.restore();
}

function paintMatt(c, x, y, w, h, r, col, square) {
  const gr = c.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, shade(col.base, 0.05));
  gr.addColorStop(0.5, col.base);
  gr.addColorStop(1, shade(col.base, -0.3));
  rr(c, x, y, w, h, r);
  c.save();
  c.globalAlpha = 0.55;
  c.fillStyle = gr;
  c.fill();
  c.restore();
}

function paintBevel(c, x, y, w, h, r, col) {
  c.save();
  rr(c, x, y, w, h, r);
  c.clip();
  const b = Math.max(2, w * 0.18);
  c.fillStyle = col.hi;
  c.fillRect(x, y, w, b);
  c.fillRect(x, y, b, h);
  c.fillStyle = col.lo;
  c.fillRect(x, y + h - b, w, b);
  c.fillRect(x + w - b, y, b, h);
  c.restore();
}

function paintGlossy(c, x, y, w, h, r, col) {
  const gr = c.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, shade(col.base, 0.85));
  gr.addColorStop(0.55, col.base);
  gr.addColorStop(1, shade(col.base, -0.56));
  rr(c, x, y, w, h, r);
  c.save();
  c.fillStyle = gr;
  c.fill();
  c.restore();
  c.save();
  c.globalAlpha = 0.42;
  c.fillStyle = "#fff";
  rr(c, x + w * 0.1, y + h * 0.08, w * 0.8, h * 0.3, Math.max(2, r * 0.7));
  c.fill();
  c.restore();
}

function paintGlassy(c, x, y, w, h, r, col, glow, s) {
  rr(c, x, y, w, h, r);
  c.fillStyle = rgba(col.base, glow ? 0.28 : 0.2);
  c.fill();
  const lg = c.createLinearGradient(0, y, 0, y + h);
  lg.addColorStop(0, "rgba(255,255,255,.28)");
  lg.addColorStop(1, "rgba(255,255,255,.06)");
  rr(c, x, y, w, h, r);
  c.save();
  c.fillStyle = lg;
  c.fill();
  c.restore();
  c.save();
  c.globalAlpha = 0.55;
  c.strokeStyle = rgba(col.base, 0.75);
  c.lineWidth = Math.max(1, s * 0.055);
  rr(c, x + 1, y + 1, w - 2, h - 2, Math.max(1, r - 1));
  c.stroke();
  c.restore();
}

function drawCellDirect(c, px, py, s, idx, glow) {
  const col = themeState.COL[idx] || themeState.COL[0];
  const sh = configState.blockShape;
  if (sh === "flat") {
    c.fillStyle = col.base;
    c.fillRect(px, py, s, s);
    return;
  }
  let ins, r;
  if (sh === "square") {
    ins = 1;
    r = 0;
  } else if (sh === "circle") {
    ins = 1;
    r = Math.max(3, s * 0.44);
  } else if (sh === "tile") {
    ins = Math.max(1.5, s * 0.06);
    r = Math.max(1, s * 0.05);
  } else {
    ins = 1;
    r = Math.max(2, s * 0.16);
  }
  const x = px + ins,
    y = py + ins,
    w = s - ins * 2,
    h = s - ins * 2;
  const rad = Math.min(r, w / 2);
  const fin = configState.blockStyle;
  if (fin === "glassy") {
    paintGlassy(c, x, y, w, h, rad, col, glow, s);
  } else {
    c.save();
    if (glow) {
      c.shadowColor = col.base;
      c.shadowBlur = s * 0.5;
    }
    rr(c, x, y, w, h, rad);
    c.fillStyle = col.base;
    c.fill();
    c.restore();
    if (fin === "bevel") paintBevel(c, x, y, w, h, rad, col);
    else if (fin === "glossy") paintGlossy(c, x, y, w, h, rad, col);
    else paintMatt(c, x, y, w, h, rad, col, sh === "square");
  }
}

const cellCache = new Map();

function cacheGetLRU(map, key) {
  const v = map.get(key);
  if (v !== undefined) {
    map.delete(key);
    map.set(key, v);
  }
  return v;
}

function cacheSetLRU(map, key, val, max) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > max) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

let cellEpoch = 0;

/** Changes every time the cell sprites are invalidated; cached board layers compare it. */
export function getCellEpoch() {
  return cellEpoch;
}

export function invalidateCellCache() {
  cellEpoch++;
  cellCache.clear();
  _partSpr.clear();
}

const _partSpr = new Map();

function colToRGBA(c, a) {
  if (c && c[0] === "#") {
    let h = c.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16) || 0;
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  const m = String(c).match(/[\d.]+/g);
  if (m) return "rgba(" + (m[0] | 0) + "," + (m[1] | 0) + "," + (m[2] | 0) + "," + a + ")";
  return "rgba(255,255,255," + a + ")";
}

export function getParticleSprite(col) {
  let s = cacheGetLRU(_partSpr, col);
  if (s) return s;
  s = document.createElement("canvas");
  s.width = s.height = 32;
  const x = s.getContext("2d");
  const gg = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  gg.addColorStop(0, colToRGBA(col, 1));
  gg.addColorStop(0.32, colToRGBA(col, 0.9));
  gg.addColorStop(0.68, colToRGBA(col, 0.32));
  gg.addColorStop(1, colToRGBA(col, 0));
  x.fillStyle = gg;
  x.beginPath();
  x.arc(16, 16, 16, 0, 7);
  x.fill();
  cacheSetLRU(_partSpr, col, s, 64);
  return s;
}

function getCellSprite(idx, s) {
  const d = window.devicePixelRatio || 1;
  const css = Math.max(4, Math.round(s));
  const key = [
    configState.blockShape,
    configState.blockStyle,
    configState.colorTheme,
    idx,
    css,
    Math.round(d * 100),
  ].join("|");
  let spr = cacheGetLRU(cellCache, key);
  if (spr) return spr;
  const ps = Math.max(4, Math.round(css * d));
  spr = document.createElement("canvas");
  spr.width = ps;
  spr.height = ps;
  const sc = spr.getContext("2d");
  sc.setTransform(ps / css, 0, 0, ps / css, 0, 0);
  drawCellDirect(sc, 0, 0, css, idx, false);
  cacheSetLRU(cellCache, key, spr, 400);
  return spr;
}

export function drawCell(c, px, py, s, idx, glow) {
  if (!glow && s > 0) {
    const spr = getCellSprite(idx, s);
    if (spr) {
      c.drawImage(spr, px, py, s, s);
      return;
    }
  }
  drawCellDirect(c, px, py, s, idx, glow);
}

export function drawMini(cv, type, alpha, cellSize) {
  const c = cv.getContext("2d");
  c.setTransform(layoutState.dpr, 0, 0, layoutState.dpr, 0, 0);
  const w = cv.width / layoutState.dpr,
    h = cv.height / layoutState.dpr;
  c.clearRect(0, 0, w, h);
  if (type == null) return;
  const cells = PIECES[type].cells[0];
  let x0 = 9,
    x1 = -9,
    y0 = 9,
    y1 = -9;
  cells.forEach(([x, y]) => {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  });
  const bw = x1 - x0 + 1,
    bh = y1 - y0 + 1;
  const fitCell = Math.min((w - 6) / 4, (h - 6) / 2);
  cellSize = Math.min(cellSize, fitCell);
  if (cellSize <= 0) return;
  const ox = (w - bw * cellSize) / 2,
    oy = (h - bh * cellSize) / 2;
  c.globalAlpha = alpha;
  if (configState.blockShape === "flat") {
    const comp = makeComponent(cells, type + 1);
    c.save();
    c.translate(ox - comp.x0 * cellSize, oy - comp.y0 * cellSize);
    c.scale(cellSize, cellSize);
    paintFlatComponent(c, comp, themeState.COL[type] || themeState.COL[0]);
    c.restore();
  } else {
    cells.forEach(([x, y]) =>
      drawCell(c, ox + (x - x0) * cellSize, oy + (y - y0) * cellSize, cellSize, type, false),
    );
  }
  c.globalAlpha = 1;
}

function miniCell() {
  return versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive
    ? Math.max(6, game.CELL * 0.8)
    : game.MINI;
}

export function drawHold() {
  drawMini(layoutState.holdCv, game.hold, game.holdUsed ? 0.35 : 1, miniCell());
  layoutState.holdCv.classList.toggle("used", game.holdUsed);
}

export function drawNexts() {
  layoutState.nextCvs.forEach((cv, i) =>
    drawMini(cv, i < game.queue.length ? game.queue[i] : null, 1, miniCell()),
  );
}

export function drawThemePreview() {
  document.querySelectorAll(".theme-picker").forEach((pk) => {
    const cv = pk.querySelector(".theme-preview");
    const steps = pk.querySelector(".theme-steps");
    if (!cv || !steps) return;
    if (!pk.offsetParent) return;
    const r = steps.getBoundingClientRect();
    if (r.height < 4) return;
    const ch = Math.round(r.height);
    cv.style.height = ch + "px";
    cv.style.width = ch + "px";
    cv.width = Math.max(1, Math.round(ch * layoutState.dpr));
    cv.height = Math.max(1, Math.round(ch * layoutState.dpr));
    drawMini(cv, 6, 1, ch / 3);
  });
}

export function showAction(title, sub, cls, color) {
  emitEvent("showAction", { title: title, sub: sub || "", cls: cls || "", color: color || "" });
  const seq = ++renderState.actionSeq;
  const st = color ? ` style="color:${color};text-shadow:0 0 16px ${rgba(color, 0.6)}"` : "";
  const html =
    `<span class="at"${st}>${title}</span>` + (sub ? `<span class="pts">${sub}</span>` : "");
  clearTimeout(renderState.actionTimer);
  const enter = () => {
    layoutState.actionLine.classList.remove("out");
    layoutState.actionLine.innerHTML = html;
    layoutState.actionLine.className = "action " + (cls || "");
    layoutState.actionLine.parentElement.classList.add("has-action");
    void layoutState.actionLine.offsetWidth;
    layoutState.actionLine.classList.add("in");
    renderState.actionState = "showing";
    renderState.actionTimer = setTimeout(() => hideAction(), 2200);
  };
  if (renderState.actionState === "showing") {
    layoutState.actionLine.classList.remove("in");
    layoutState.actionLine.classList.add("out");
    renderState.actionState = "leaving";
    setTimeout(() => {
      if (seq !== renderState.actionSeq) return;
      enter();
    }, 200);
  } else {
    enter();
  }
}

export function hideAction() {
  clearTimeout(renderState.actionTimer);
  if (renderState.actionState === "idle") return;
  layoutState.actionLine.classList.remove("in");
  layoutState.actionLine.classList.add("out");
  renderState.actionState = "leaving";
  setTimeout(() => {
    if (renderState.actionState !== "leaving") return;
    layoutState.actionLine.className = "action";
    layoutState.actionLine.parentElement.classList.remove("has-action");
    renderState.actionState = "idle";
  }, 260);
}

export function setBannerEl(el, txt, color, cls) {
  if (!el) return;
  el.textContent = txt;
  el.style.color = color;
  el.style.opacity = "";
  el.style.transform = "";
  el.style.fontSize = "";
  el.classList.remove("go", "count", "round", "end", "pc", "pc2");
  void el.offsetWidth;
  if (cls) el.classList.add(cls);
  el.classList.add("go");
}

export function banner(txt, color, cls) {
  emitEvent("banner", { txt: txt, color: color || "", cls: cls || "" });
  setBannerEl(layoutState.bannerEl, txt, color, cls);
}

function bannerB(txt, color, cls) {
  setBannerEl($("botBanner"), txt, color, cls);
}

export function bannerBoth(pt, pc, clsP, bt, bc, clsB) {
  banner(pt, pc, clsP);
  bannerB(bt, bc, clsB);
}

export function bannerStay(el, txt, color, cls) {
  if (!el) return;
  el.textContent = txt;
  el.style.color = color;
  el.style.opacity = "1";
  el.style.transform = "none";
  el.classList.remove("go", "count", "round", "end", "pc", "pc2");
  if (cls) el.classList.add(cls);
}

export function clearAllBanners() {
  const reset = (el) => {
    if (!el) return;
    el.textContent = "";
    el.style.opacity = "";
    el.style.transform = "";
    el.style.fontSize = "";
    el.classList.remove("go", "count", "round", "end", "pc", "pc2");
  };
  reset(layoutState.bannerEl);
  reset($("botBanner"));
  if (MP.stations) {
    for (const st of MP.stations) reset(st.bannerEl);
  }
}

export function burstAt(cx, cy, idx, n = 1, up = true, power = 1) {
  const s = clearScale();
  if (s <= 0 || n <= 0) return;
  const scale = Math.min(2, s);
  let count = Math.max(1, Math.round(n * scale));
  const cap = MOBILE.matches ? 140 : 300;
  const room = cap - game.particles.length;
  if (room <= 0) return;
  if (count > room) count = room;
  const sizeScale = 0.7 + 0.3 * scale;
  for (let i = 0; i < count; i++) {
    let p;
    if (game.partPoolUsed < partPool.length) {
      p = partPool[game.partPoolUsed++];
    } else {
      p = { px: 0, py: 0, vx: 0, vy: 0, life: 0, max: 1, size: 0, col: "" };
    }
    p.px = cx + 0.5;
    p.py = cy + 0.5;
    p.vx = (fxRandom() * 2 - 1) * 6 * power;
    p.vy = (up ? -(3 + fxRandom() * 8) : fxRandom() * 3 - 1) * power;
    p.life = 0.4 + fxRandom() * 0.4;
    p.max = 0.9;
    p.size = (2.5 + fxRandom() * 1.6) * power * sizeScale;
    p.col = idx == null ? "#fff" : (themeState.COL[idx] || themeState.COL[7]).base;
    game.particles.push(p);
  }
}

export function updateParticlesArr(arr, dt) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i];
    p.life -= dt;
    if (p.life <= 0) {
      const last = arr.pop();
      if (i < arr.length) arr[i] = last;
      if (game.partPoolUsed > 0) game.partPoolUsed--;
      continue;
    }
    p.vy += 26 * dt;
    p.px += p.vx * dt;
    p.py += p.vy * dt;
  }
}

export function updateChipsFor(cv, bv, ce, be) {
  if (!ce || !be) return;
  if (cv >= 1) {
    const _pc = ce.dataset.n || "";
    ce.textContent = "COMBO ×" + cv;
    ce.classList.add("show");
    if (_pc !== String(cv)) {
      ce.dataset.n = String(cv);
      if (ce.animate) {
        ce.getAnimations().forEach((a) => a.cancel());
        ce.animate(
          [
            { transform: "scale(1)" },
            { transform: "scale(1.12)", offset: 0.4 },
            { transform: "scale(1)" },
          ],
          { duration: 260 },
        );
      }
    }
  } else {
    ce.classList.remove("show");
    ce.dataset.n = "";
  }
  if (bv >= 2) {
    const prev = be.dataset.n || "";
    be.textContent = "B2B ×" + bv;
    be.classList.toggle("hot", bv >= 4 && bv <= 5);
    be.classList.toggle("blaze", bv >= 6 && bv <= 7);
    be.classList.toggle("inferno", bv >= 8 && bv <= 9);
    be.classList.toggle("storm", bv >= 10 && bv <= 12);
    be.classList.toggle("mythic", bv >= 13);
    if (prev !== String(bv) || !be.classList.contains("show")) {
      be.dataset.n = String(bv);
      be.classList.add("show");
      if (be.animate) {
        be.getAnimations().forEach((a) => a.cancel());
        be.animate(
          [
            { transform: "scale(1)" },
            { transform: "scale(1.12)", offset: 0.4 },
            { transform: "scale(1)" },
          ],
          { duration: 260 },
        );
      }
    }
  } else {
    be.classList.remove("show", "hot", "blaze", "inferno", "storm", "mythic");
    be.dataset.n = "";
  }
}

export function updateChips() {
  updateChipsFor(game.combo, game.b2bChain, layoutState.comboChip, layoutState.b2bChip);
}

export function checkDanger() {
  let top = configState.ROWS;
  outer: for (let y = 0; y < configState.ROWS; y++) {
    for (let x = 0; x < configState.COLS; x++) {
      if (game.board[y][x]) {
        top = y;
        break outer;
      }
    }
  }
  layoutState.wrap.classList.toggle("danger", game.state === "playing" && top < HID + 5);
}

export function ghostY() {
  let y = game.piece.y;
  const c = curCells();
  while (!collide(c, game.piece.x, y + 1)) y++;
  return y;
}

function afterAction() {
  if (!game.piece) return;
  const unlimited = configState.mode === "practice" && configState.practice.disableLock;
  game.piece.lockResets++;
  if (!unlimited && game.piece.lockResets >= MAX_RESETS) return;
  if (!collide(curCells(), game.piece.x, game.piece.y + 1)) return;
  game.piece.lockT = 0;
}

export function spawnXFor(t) {
  const cells = PIECES[t].cells[0];
  let minX = 9,
    maxX = -9;
  for (const [x] of cells) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const w = maxX - minX + 1;
  return Math.max(0, Math.floor((configState.COLS - w) / 2) - minX);
}

export function movePiece(dx) {
  if (!game.piece) return false;
  if (collide(curCells(), game.piece.x + dx, game.piece.y)) {
    let minX = 99,
      maxX = -99;
    for (const [cx] of curCells()) {
      const X = game.piece.x + cx;
      if (X < minX) minX = X;
      if (X > maxX) maxX = X;
    }
    if (dx < 0 && minX <= 0) fx.tx = -LEAN;
    else if (dx > 0 && maxX >= configState.COLS - 1) fx.tx = LEAN;
    else fx.tx = 0;
    return false;
  }
  game.piece.x += dx;
  game.piece.lastRotate = null;
  fx.tx = 0;
  SFX.move();
  afterAction();
  return true;
}

export function tryRotate(kind) {
  if (!game.piece) return false;
  const r = tryRotateOn(game.board, dims, game.piece, kind);
  if (!r) return false;
  game.piece.x = r.x;
  game.piece.y = r.y;
  game.piece.rot = r.rot;
  game.piece.lastRotate = { kick: r.kick, dir: r.dir };
  SFX.rotate();
  if (detectSpin()) {
    SFX.spinMove();
    fxSpin(game.piece.lastRotate.dir || 0);
  }
  afterAction();
  return true;
}
