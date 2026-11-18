// @ts-nocheck
import { clock } from "../core/clock";
import { shuffleInPlace } from "@tetrizz/core";
import { gameRandom } from "../core/random";
import { PIECES } from "@tetrizz/core";
import { log } from "../core/logger";
import { HID, MOBILE, clamp, colsForMode, configState, deepCopy, visForMode } from "../core/config";
import { bindingsState } from "../input/bindings";
import { game } from "../game/state";
import { collide, curCells, emptyRow, gravMsFor } from "../engine/engine";
import {
  $,
  applyGeometry,
  layout,
  layoutPieceModal,
  layoutSoon,
  layoutState,
  savePractice,
} from "../ui/layout";
import { checkDanger, drawHold, drawNexts, updateChips } from "../render/render";
import { clearInput, hideAllOverlays, pullNext, syncPad, syncVsPlay } from "../game/game";
import { updateStats } from "../ui/menus";
import { snapState } from "../ui/settings";
import { boardThumb, renderBoardList, selectedBoard } from "./board-library";
import { refreshPractice } from "./snapshot";
import { render } from "../ui/screens";
import { MP, buildMpChips, mpBuildStations, versusLobbyState } from "../versus/lobby";
import { ensureStream, refreshQueues, setMpGauges } from "../versus/garbage";
import {
  drawStHold,
  drawStNexts,
  stCheckDanger,
  stUpdateChips,
  stUpdateStats,
} from "../versus/stations";
import { layoutMp, vsUpdateHud } from "../versus/rounds";

const practiceState = {
  SMART_TABLE: null,
};

export function restoreState(s) {
  if (s.vs) {
    restoreVsSession(s.vs);
    if (s.st && s.st !== "over") game.state = s.st;
    clearInput();
    return;
  }
  game.board = s.board.map((r) => r.slice());
  game.piece = s.piece
    ? { ...s.piece, lastRotate: s.piece.lastRotate ? { ...s.piece.lastRotate } : null }
    : null;
  game.hold = s.hold;
  game.holdUsed = s.holdUsed;
  game.queue = s.queue.slice();
  game.score = s.score;
  game.lines = s.lines;
  game.level = s.level;
  game.combo = s.combo;
  game.maxCombo = s.maxCombo;
  game.b2bChain = s.b2bChain;
  game.pieces = s.pieces;
  game.playMs = s.playMs;
  game.gravMs = s.gravMs < 0 ? Infinity : s.gravMs;
  game.gravT = s.gravT;
  configState.practiceNextGarbage = s.practiceNextGarbage || 0;
  if (Array.isArray(s.sharedStream)) {
    versusLobbyState.sharedStream = s.sharedStream.slice();
    versusLobbyState.playerPtr = s.playerPtr || 0;
  }
  if (s.st && s.st !== "over") game.state = s.st;
  clearInput();
  drawHold();
  drawNexts();
  updateStats();
  updateChips();
  checkDanger();
  render();
}

function restoreVsSession(v) {
  versusLobbyState.vsActive = true;
  versusLobbyState.vsMatchOver = false;
  versusLobbyState.vsRoundOver = false;
  versusLobbyState.vs.submode = v.submode || "battle";
  versusLobbyState.vsRound = v.round || 1;
  MP.wins = (v.wins || [0, 0, 0, 0]).slice(0, 4);
  MP.cum =
    v.cum && v.cum.length
      ? v.cum.slice(0, 4).map(function (c) {
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
        })
      : [0, 1, 2, 3].map(function () {
          return { lines: 0, pieces: 0, ms: 0, combo: 0, score: 0, atk: 0, recv: 0, lvl: 1 };
        });
  versusLobbyState.vsTime = v.time || 0;
  versusLobbyState.vsHudT = 0;
  versusLobbyState.vsBannerUntil = 0;
  versusLobbyState.vsCountdownStarted = true;
  configState.COLS = colsForMode("vsbot");
  configState.VIS = visForMode("vsbot");
  configState.ROWS = configState.VIS + HID;
  applyGeometry();
  const maxSlots = MOBILE.matches ? 2 : 4;
  const act = [];
  for (let i = 0; i < maxSlots; i++) {
    if (versusLobbyState.vs.players[i].type !== "off")
      act.push({ p: versusLobbyState.vs.players[i], i: i });
  }
  mpBuildStations(act);
  document.body.style.setProperty("--mpN", String(MOBILE.matches ? 1 : MP.n));
  buildMpChips();
  versusLobbyState.sharedStream.length = 0;
  Array.prototype.push.apply(versusLobbyState.sharedStream, (v.stream || []).slice());
  MP.ptrs = (v.ptrs || []).slice(0, MP.n);
  while (MP.ptrs.length < MP.n) MP.ptrs.push(0);
  MP.qs = [];
  for (let i = 0; i < MP.n; i++) MP.qs[i] = v.qs && v.qs[i] ? deepCopy(v.qs[i]) : [];
  MP.lastHole = (v.lastHole || [-1, -1, -1, -1]).slice(0, 4);
  (v.stations || []).forEach(function (sd, i) {
    const st = MP.stations[i];
    if (!st) return;
    st.board = (sd.board || []).map(function (r) {
      return r.slice();
    });
    while (st.board.length < configState.ROWS) st.board.push(emptyRow());
    st.piece = sd.piece
      ? {
          type: sd.piece.t,
          rot: sd.piece.r,
          x: sd.piece.x,
          y: sd.piece.y,
          cells: PIECES[sd.piece.t].cells[sd.piece.r],
          lockT: 0,
          lockResets: 0,
          lastRotate: null,
          softSounded: false,
        }
      : null;
    st.queue = (sd.queue || []).slice();
    st.hold = sd.hold != null ? sd.hold : null;
    st.holdUsed = !!sd.holdUsed;
    st.score = sd.score || 0;
    st.lines = sd.lines || 0;
    st.level = sd.level || 1;
    st.combo = typeof sd.combo === "number" ? sd.combo : -1;
    st.maxCombo = sd.maxCombo || 0;
    st.b2b = sd.b2b || 0;
    st.pieces = sd.pieces || 0;
    st.sent = sd.sent || 0;
    st.alive = sd.alive !== 0;
    st.left = !!sd.left;
    st.deathAt = 0;
    st.gravMs = sd.gravMs < 0 ? Infinity : sd.gravMs;
    st.gravT = sd.gravT || 0;
    st.timeMs = sd.timeMs || 0;
    st.plan = null;
    st.topActions = [];
    st.execIdx = 0;
    st.topAcc = 0;
    st.spinDone = false;
    st.spinAt = 0;
    st.bottomFail = 0;
    st.thinkGen = null;
    st.spec = null;
    st.particles.length = 0;
    st.in.left = st.in.right = st.in.down = false;
    st.in.dir = 0;
    st.in.dasT = st.in.arrT = 0;
    if (st.left || !st.alive) {
      if (st.wrapEl) {
        st.wrapEl.classList.add("lost");
        st.wrapEl.classList.remove("danger");
      }
    } else if (st.wrapEl) {
      st.wrapEl.classList.remove("lost", "danger", "garbage-hit");
    }
    drawStHold(st);
    drawStNexts(st);
    stUpdateStats(st);
    stUpdateChips(st);
    stCheckDanger(st);
  });
  document.body.classList.remove("matchover");
  syncVsPlay();
  vsUpdateHud();
  setMpGauges();
  layout();
  layoutMp();
  layoutSoon(80);
  layoutSoon(300);
}

export function pushHistory() {
  if (configState.mode !== "practice") return;
  game.hist.push(snapState());
  if (game.hist.length > 120) game.hist.shift();
  game.redoStack.length = 0;
  updatePracticeButtons();
}

function canPracticeAction() {
  return (
    configState.mode === "practice" &&
    (game.state === "playing" ||
      game.state === "countdown" ||
      game.state === "editing" ||
      game.state === "over")
  );
}

export function undo() {
  if (!canPracticeAction() || !game.hist.length) return;
  if (game.state !== "over") game.redoStack.push(snapState());
  const s = game.hist.pop();
  const keepEdit = game.editMode;
  restoreState(s);
  if (keepEdit) game.state = "editing";
  if (game.state === "over" || game.state === "menu") game.state = "playing";
  hideAllOverlays();
  bindingsState.openOverlayEl = null;
  syncPad();
  game.lastTs = clock.now();
  updatePracticeButtons();
}

export function redo() {
  if (!canPracticeAction() || !game.redoStack.length) return;
  game.hist.push(snapState());
  const s = game.redoStack.pop();
  const keepEdit = game.editMode;
  restoreState(s);
  if (keepEdit) game.state = "editing";
  if (game.state === "over" || game.state === "menu") game.state = "playing";
  hideAllOverlays();
  bindingsState.openOverlayEl = null;
  syncPad();
  game.lastTs = clock.now();
  updatePracticeButtons();
}

export function updatePracticeButtons() {
  const u = $("undoBtn");
  if (!u) return;
  u.disabled = !(configState.mode === "practice" && game.hist.length);
  $("redoBtn").disabled = !(configState.mode === "practice" && game.redoStack.length);
  $("editBtn").classList.toggle("active", game.editMode);
  $("paintBtn").classList.toggle("active", game.editTool === "paint");
  $("eraseBtn").classList.toggle("active", game.editTool === "erase");
}

function resolvePieceCollision() {
  if (!game.piece) {
    pullNext(true);
    return;
  }
  let guard = 0;
  while (collide(curCells(), game.piece.x, game.piece.y) && guard++ < configState.ROWS + 10)
    game.piece.y--;
  game.piece.lockT = 0;
  game.piece.lockResets = 0;
  if (collide(curCells(), game.piece.x, game.piece.y)) {
    game.piece = null;
    pullNext(true);
  }
}

export function toggleEdit() {
  if (configState.mode !== "practice") return;
  if (!game.editMode) {
    if (game.state === "menu" || game.state === "over") return;
    if (bindingsState.openOverlayEl && !bindingsState.openOverlayEl.classList.contains("hidden"))
      return;
    game.editMode = true;
    game.editTool = "paint";
    game.editDrawing = false;
    game.editStroke = false;
    game.state = "editing";
    clearInput();
    hideAllOverlays();
    bindingsState.openOverlayEl = null;
    document.body.classList.add("editing");
    syncPad();
    updatePracticeButtons();
  } else exitEdit();
}

export function exitEdit() {
  if (!game.editMode) return;
  game.editMode = false;
  game.editDrawing = false;
  game.editStroke = false;
  document.body.classList.remove("editing");
  resolvePieceCollision();
  game.state = "playing";
  syncPad();
  game.lastTs = clock.now();
  updatePracticeButtons();
}

function editCellFromEvent(e) {
  const rect = layoutState.wrap.getBoundingClientRect();
  const cell = rect.width / Math.max(1, configState.COLS);
  if (cell <= 0) return null;
  const cx = e.clientX - rect.left,
    cy = e.clientY - rect.top;
  if (cx < 0 || cy < 0 || cx >= rect.width || cy >= rect.height) return null;
  const x = Math.floor(cx / cell),
    y = HID + Math.floor(cy / cell);
  if (x < 0 || x >= configState.COLS || y < HID || y >= configState.ROWS) return null;
  return { x, y };
}

function applyEditCell(x, y, erase) {
  if (x < 0 || x >= configState.COLS || y < 0 || y >= configState.ROWS) return;
  game.board[y][x] = erase ? 0 : 8;
  if (!erase) game.editStrokeCells.add(y * 32 + x);
}

function editLine(a, b, erase) {
  let x0 = a.x,
    y0 = a.y,
    x1 = b.x,
    y1 = b.y;
  const dx = Math.abs(x1 - x0),
    dy = Math.abs(y1 - y0),
    sx = x0 < x1 ? 1 : -1,
    sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    applyEditCell(x0, y0, erase);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export function editPointerDown(e) {
  if (!game.editMode) return;
  if (e.target.closest && e.target.closest("button, .overlay, #pieceModal")) return;
  e.preventDefault();
  const cell = editCellFromEvent(e);
  if (!cell) return;
  game.editDrawing = true;
  game.editPointerId = e.pointerId;
  game.editErase = (e.button === 2) !== (game.editTool === "erase");
  if (!game.editStroke) {
    pushHistory();
    game.editStroke = true;
    game.editStrokeCells.clear();
  }
  applyEditCell(cell.x, cell.y, game.editErase);
  game.editLast = cell;
  render();
  try {
    layoutState.wrap.setPointerCapture(e.pointerId);
  } catch (_) {
    log.debug("practice/practice.editPointerDown", _);
  }
}

export function editPointerMove(e) {
  if (!game.editMode || !game.editDrawing || e.pointerId !== game.editPointerId) return;
  e.preventDefault();
  const cell = editCellFromEvent(e);
  if (!cell) return;
  if (!game.editLast || cell.x !== game.editLast.x || cell.y !== game.editLast.y) {
    editLine(game.editLast || cell, cell, game.editErase);
    game.editLast = cell;
    render();
  }
}

export function editPointerUp(e) {
  if (!game.editMode || !game.editDrawing || e.pointerId !== game.editPointerId) return;
  game.editDrawing = false;
  game.editStroke = false;
  game.editLast = null;
  game.editPointerId = null;
  smartColorStroke();
  checkDanger();
  updatePracticeButtons();
  render();
}

export function openPieceModal(target, idx) {
  game.pieceModalTarget = { target, idx };
  $("pieceModal").hidden = false;
  layoutPieceModal();
}

export function closePieceModal() {
  game.pieceModalTarget = null;
  $("pieceModal").hidden = true;
}

function selectPieceModal(type) {
  if (!game.pieceModalTarget) return;
  if (game.pieceModalTarget.target === "hold") {
    game.hold = type;
    drawHold();
  } else {
    game.queue[game.pieceModalTarget.idx] = type;
    drawNexts();
  }
  closePieceModal();
}

export function buildPieceModal() {
  const grid = $("pieceGrid");
  if (!grid) return;
  grid.innerHTML = "";
  PIECES.forEach((p, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "piece-btn";
    b.tabIndex = -1;
    b.dataset.idx = i;
    const cv = document.createElement("canvas");
    b.appendChild(cv);
    grid.appendChild(b);
    b.addEventListener("click", () => selectPieceModal(i));
  });
  layoutPieceModal();
}

export function changePracticeLevel(d) {
  if (configState.mode !== "practice") return;
  configState.practice.level = clamp(configState.practice.level + d, 0, 20);
  game.level = configState.practice.levelUp
    ? configState.practice.level + Math.floor(game.lines / 10)
    : configState.practice.level;
  game.gravMs = gravMsFor("practice", game.level);
  savePractice();
  refreshPractice();
  updateStats();
}

export function mirrorBoard() {
  if (configState.mode !== "practice") return;
  if (!(game.state === "playing" || game.state === "editing" || game.state === "countdown")) return;
  pushHistory();
  for (let y = 0; y < configState.ROWS; y++) game.board[y].reverse();
  if (game.piece) {
    let guard = 0;
    while (collide(curCells(), game.piece.x, game.piece.y) && guard++ < configState.ROWS + 4)
      game.piece.y--;
    if (collide(curCells(), game.piece.x, game.piece.y)) resolvePieceCollision();
  }
  const _mb = selectedBoard();
  if (_mb && Array.isArray(_mb.grid)) {
    for (const row of _mb.grid) row.reverse();
    _mb.thumb = boardThumb(_mb.grid, _mb.cols, _mb.vis);
    savePractice();
    renderBoardList();
  }
  checkDanger();
  render();
}

export function applyPracticeStartBoard() {
  const sb = selectedBoard();
  if (!sb || !Array.isArray(sb.grid)) return;
  const oy = sb.vis - configState.VIS,
    ox = Math.max(0, Math.floor((sb.cols - configState.COLS) / 2));
  for (let y = 0; y < configState.VIS; y++) {
    const sy = y + oy;
    for (let x = 0; x < configState.COLS; x++) {
      const sx = x + ox;
      let v = 0;
      if (sy >= 0 && sy < sb.vis && sx >= 0 && sx < sb.cols) v = sb.grid[sy][sx] || 0;
      game.board[HID + y][x] = v;
    }
  }
}

export function applyBoardSeq() {
  if (configState.mode !== "practice" || configState.practice.startExtras) return;
  const sb = selectedBoard();
  if (!sb || !sb.seq) return;
  const sq = sb.seq,
    q = Array.isArray(sq.q) ? sq.q.slice() : [],
    rem = Array.isArray(sq.rem) ? sq.rem.slice() : [];
  shuffleInPlace(rem, gameRandom);
  versusLobbyState.sharedStream.length = 0;
  versusLobbyState.playerPtr = 0;
  for (const t of rem.concat(q)) if (t >= 0 && t < 7) versusLobbyState.sharedStream.push(t);
  if (typeof sq.h === "number" && sq.h >= 0 && sq.h < 7) game.hold = sq.h;
}

export function boardBagText(b) {
  const s = b && b.seq;
  if (!s) return "";
  const nm = (a) => a.map((t) => (PIECES[t] ? PIECES[t].n : "?")).join(" ");
  const p = [];
  if (s.rem && s.rem.length) p.push("LEFTOVER " + nm(s.rem) + " (ANY ORDER)");
  if (s.q && s.q.length) p.push((s.rem && s.rem.length ? "THEN " : "NEXT ") + nm(s.q));
  if (typeof s.h === "number" && s.h >= 0) p.push("HOLD " + nm([s.h]));
  return p.join(" · ");
}

export function applyPracticeStartExtras() {
  const ex = configState.practice.startExtras;
  if (!ex) return;
  if (Array.isArray(ex.queue) && ex.queue.length) {
    ensureStream(versusLobbyState.playerPtr + ex.queue.length + 7);
    for (let i = 0; i < ex.queue.length; i++)
      versusLobbyState.sharedStream[versusLobbyState.playerPtr + i] = ex.queue[i];
    refreshQueues();
  }
  game.hold = ex.hold != null ? ex.hold : null;
  game.holdUsed = !!ex.holdUsed;
  drawHold();
  if (ex.piece) {
    const p = ex.piece;
    game.piece = {
      type: p.type,
      rot: p.rot,
      x: p.x,
      y: p.y,
      lockT: 0,
      lockResets: 0,
      lastRotate: null,
      softSounded: false,
    };
    game.gravT = 0;
    if (collide(curCells(), game.piece.x, game.piece.y)) game.piece = null;
  }
  drawNexts();
}

function smartShapeTable() {
  if (practiceState.SMART_TABLE) return practiceState.SMART_TABLE;
  practiceState.SMART_TABLE = new Map();
  PIECES.forEach((p, t) => {
    for (let r = 0; r < 4; r++) {
      const cells = p.cells[r];
      const nx = Math.min(...cells.map((c) => c[0])),
        ny = Math.min(...cells.map((c) => c[1]));
      const key = cells
        .map((c) => c[0] - nx + "," + (c[1] - ny))
        .sort()
        .join(";");
      if (!practiceState.SMART_TABLE.has(key)) practiceState.SMART_TABLE.set(key, t);
    }
  });
  return practiceState.SMART_TABLE;
}

function smartColorStroke() {
  if (!game.editStrokeCells.size) return;
  const table = smartShapeTable();
  const seen = new Set();
  let changed = false;
  for (const k of game.editStrokeCells) {
    if (seen.has(k)) continue;
    const comp = [];
    const stack = [k];
    seen.add(k);
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      const x = c % 32,
        y = (c / 32) | 0;
      const nbs = [y * 32 + x + 1, y * 32 + x - 1, (y + 1) * 32 + x, (y - 1) * 32 + x];
      for (const nk of nbs) {
        if (seen.has(nk) || !game.editStrokeCells.has(nk)) continue;
        const nx2 = nk % 32,
          ny2 = (nk / 32) | 0;
        if (nx2 < 0 || nx2 >= configState.COLS || ny2 < 0 || ny2 >= configState.ROWS) continue;
        if (game.board[ny2][nx2] !== 8) continue;
        seen.add(nk);
        stack.push(nk);
      }
    }
    if (comp.length === 4) {
      const xs = comp.map((c) => c % 32),
        ys = comp.map((c) => (c / 32) | 0);
      const nx = Math.min(...xs),
        ny = Math.min(...ys);
      const key = comp
        .map((c) => (c % 32) - nx + "," + (((c / 32) | 0) - ny))
        .sort()
        .join(";");
      const t = table.get(key);
      if (t !== undefined) {
        for (const c of comp) game.board[(c / 32) | 0][c % 32] = t + 1;
        changed = true;
      }
    }
  }
  game.editStrokeCells.clear();
  if (changed) render();
}
