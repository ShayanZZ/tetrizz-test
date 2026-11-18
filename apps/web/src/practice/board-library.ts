// @ts-nocheck
import { PIECES } from "@tetrizz/core";
import { escapeHtml } from "../core/escape";
import { log } from "../core/logger";
import { HID, clamp, configState } from "../core/config";
import { themeState } from "../render/theme";
import { game } from "../game/state";
import {
  $,
  clampPractice,
  computeFlatComponents,
  makeComponent,
  paintFlatComponent,
  savePractice,
} from "../ui/layout";
import { drawCell, drawFlatComps } from "../render/render";
import { askConfirm, showEditNote } from "../ui/settings";
import { boardBagText } from "./practice";
import { bvqMount } from "./capture";
import { refreshPractice } from "./snapshot";
import { versusLobbyState } from "../versus/lobby";
import { ensureStream } from "../versus/garbage";

export const boardLibraryState = {
  bvIdx: -1,
  bvCell: 16,
  bvPaintVal: 8,
  bvDown: false,
  bvDirty: false,
  bvTool: "paint",
  bvHist: [],
  bvRedo2: [],
  bvSeq: { q: [], rem: [], h: -1 },
  bvqTgt: "q",
  bvDraft: null,
};

const PRESET_LET = "IJLOSTZ";

export function presetGrid(p) {
  const g = [];
  for (let i = 0; i < 20 - p.rows.length; i++) g.push(new Array(10).fill(0));
  for (const r of p.rows) {
    const a = new Array(10).fill(0);
    for (let x = 0; x < 10; x++) {
      const ch = r[x] || ".";
      a[x] = ch === "." ? 0 : ch === "#" ? 8 : PRESET_LET.indexOf(ch) + 1;
    }
    g.push(a);
  }
  return g;
}

export function presetTypes(str) {
  return String(str || "")
    .split("")
    .map((c) => PRESET_LET.indexOf(c))
    .filter((t) => t >= 0);
}

export function isPresetBoard(b) {
  if (!b || b.edited) return false;
  if (b.preset === true) return true;
  try {
    return PRACTICE_PRESETS.some(
      (p) =>
        p.n === b.name && b.cols === 10 && JSON.stringify(b.grid) === JSON.stringify(presetGrid(p)),
    );
  } catch (_) {
    return false;
  }
}

export function syncPracticeToBoard(b) {
  if (!b || !b.cols || !b.vis) return;
  const w = clamp(Math.round(b.cols), 4, 20),
    h = clamp(Math.round(b.vis), 4, 40);
  if (configState.practice.width !== w || configState.practice.height !== h) {
    configState.practice.width = w;
    configState.practice.height = h;
    clampPractice();
    savePractice();
    try {
      refreshPractice();
    } catch (_) {
      log.debug("practice/board-library.syncPracticeToBoard", _);
    }
  }
}

function moveBoard(i, d) {
  const L = configState.practice.boards,
    j = i + d;
  if (!Array.isArray(L) || j < 0 || j >= L.length) return;
  const t = L[i];
  L[i] = L[j];
  L[j] = t;
  if (configState.practice.boardSel === i) configState.practice.boardSel = j;
  else if (configState.practice.boardSel === j) configState.practice.boardSel = i;
  savePractice();
  renderBoardList();
}

export function toast(msg) {
  let t = $("tzToast");
  if (!t) {
    t = document.createElement("div");
    t.id = "tzToast";
    t.style.cssText =
      "position:fixed;left:50%;bottom:calc(120px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:120;background:rgba(18,24,38,.96);color:#fff;border:1px solid rgba(255,255,255,.22);padding:10px 16px;border-radius:12px;font:600 13px 'IBM Plex Mono',monospace;letter-spacing:.05em;max-width:86vw;text-align:center;pointer-events:none;opacity:0;transition:opacity .2s";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._t);
  t._t = setTimeout(() => {
    t.style.opacity = "0";
  }, 2600);
}

export function exportBoardsFile() {
  const list = (configState.practice.boards || []).filter((b) => b && b.grid && !isPresetBoard(b));
  if (!list.length) {
    showEditNote("No saved boards to export (presets are not included).", "list");
    return;
  }
  const data = {
    app: "TetriZZ",
    type: "boards",
    v: 1,
    boards: list.map((b) => ({
      name: b.name,
      cols: b.cols,
      vis: b.vis,
      rows: b.grid.map((r) => r.join("")),
      seq: b.seq || null,
      note: b.note || "",
    })),
  };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob),
    a = document.createElement("a"),
    d = new Date();
  a.href = url;
  a.download =
    "tetrizz-boards-" +
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0") +
    ".json";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1500);
  showEditNote(
    list.length +
      " board" +
      (list.length > 1 ? "s" : "") +
      " exported ✓ (presets are not included)",
    "list",
  );
}

export function importBoardsText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    showEditNote("That file is not valid JSON.", "list");
    return;
  }
  const arr = Array.isArray(data) ? data : data && Array.isArray(data.boards) ? data.boards : null;
  if (!arr) {
    showEditNote("No boards found in that file.", "list");
    return;
  }
  migrateBoards();
  let added = 0,
    skipped = 0;
  const clean = (a) =>
    Array.isArray(a)
      ? a
          .map((v) => Math.round(+v))
          .filter((t) => t >= 0 && t < 7)
          .slice(0, 14)
      : [];
  for (const b of arr.slice(0, 200)) {
    if (!b || typeof b !== "object") {
      skipped++;
      continue;
    }
    const cols = Math.round(+b.cols),
      vis = Math.round(+b.vis);
    if (
      !(cols >= 2 && cols <= 40 && vis >= 2 && vis <= 60) ||
      !Array.isArray(b.rows) ||
      b.rows.length !== vis
    ) {
      skipped++;
      continue;
    }
    const grid = [];
    let ok = true;
    for (const r of b.rows) {
      const s = String(r);
      if (s.length !== cols || /[^0-8]/.test(s)) {
        ok = false;
        break;
      }
      grid.push(s.split("").map(Number));
    }
    if (!ok) {
      skipped++;
      continue;
    }
    const name = String(b.name || "IMPORTED").slice(0, 18),
      sig = JSON.stringify(grid);
    if (
      configState.practice.boards.some((x) => x.name === name && JSON.stringify(x.grid) === sig)
    ) {
      skipped++;
      continue;
    }
    addBoardEntry(grid, cols, vis, false);
    const ent = configState.practice.boards[configState.practice.boards.length - 1];
    ent.name = name;
    if (b.note) ent.note = String(b.note).slice(0, 90);
    const sq = b.seq;
    if (sq && typeof sq === "object") {
      const q = clean(sq.q),
        rem = clean(sq.rem),
        h = typeof sq.h === "number" && sq.h >= 0 && sq.h < 7 ? Math.round(sq.h) : null;
      if (q.length || rem.length || h !== null) ent.seq = { q: q, rem: rem, h: h };
    }
    added++;
  }
  savePractice();
  renderBoardList();
  showEditNote(
    added +
      " board" +
      (added === 1 ? "" : "s") +
      " imported" +
      (skipped ? " · " + skipped + " skipped (invalid or already in your list)" : "") +
      " ✓",
    "list",
  );
}

export function saveCurrentPracticeBoard() {
  if (configState.mode !== "practice" || !game.board) return;
  const cols = configState.COLS,
    vis = configState.VIS,
    grid = [];
  let blocks = 0;
  for (let y = 0; y < vis; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      const v = (game.board[HID + y] && game.board[HID + y][x]) || 0;
      row.push(v);
      if (v) blocks++;
    }
    grid.push(row);
  }
  const q = [];
  if (game.piece && typeof game.piece.type === "number") q.push(game.piece.type);
  try {
    ensureStream(versusLobbyState.playerPtr + 6);
  } catch (_) {
    log.debug("practice/board-library.saveCurrentPracticeBoard", _);
  }
  for (const t of versusLobbyState.sharedStream.slice(
    versusLobbyState.playerPtr,
    versusLobbyState.playerPtr + 5,
  ))
    q.push(t);
  addBoardEntry(grid, cols, vis, false);
  const ent = configState.practice.boards[configState.practice.boards.length - 1];
  if (ent) {
    ent.name = "PRACTICE " + configState.practice.boards.length;
    ent.note = "Saved from a practice game — queue and hold included.";
    ent.seq = {
      q: q,
      rem: [],
      h: typeof game.hold === "number" && game.hold >= 0 ? game.hold : null,
    };
  }
  savePractice();
  renderBoardList();
  toast(blocks ? "Board saved to Board Library ✓" : "Empty board saved to Board Library ✓");
}

export function drawStyledGrid(c, grid, cols, vis, cs, ox, oy) {
  ox = ox || 0;
  oy = oy || 0;
  if (configState.blockShape === "flat") {
    const oc = configState.COLS,
      or = configState.ROWS;
    let comps = [];
    configState.COLS = cols;
    configState.ROWS = vis;
    try {
      comps = computeFlatComponents(grid);
    } catch (_) {
      log.debug("practice/board-library.drawStyledGrid", _);
    } finally {
      configState.COLS = oc;
      configState.ROWS = or;
    }
    c.save();
    c.translate(ox, oy);
    drawFlatComps(c, comps, cs);
    c.restore();
    return;
  }
  for (let y = 0; y < vis; y++) {
    const row = grid[y];
    if (!row) continue;
    for (let x = 0; x < cols; x++) {
      const v = row[x];
      if (v) drawCell(c, ox + x * cs, oy + y * cs, cs, v - 1, false);
    }
  }
}

export function pieceAt(c, cells, t, ox, oy, cs, x0, y0) {
  if (configState.blockShape === "flat") {
    const comp = makeComponent(cells, t + 1);
    c.save();
    c.translate(ox - comp.x0 * cs, oy - comp.y0 * cs);
    c.scale(cs, cs);
    paintFlatComponent(c, comp, themeState.COL[t] || themeState.COL[0]);
    c.restore();
  } else
    cells.forEach(([a, b]) => drawCell(c, ox + (a - x0) * cs, oy + (b - y0) * cs, cs, t, false));
}

export function boardThumb(grid, cols, vis) {
  const stdCols = Math.max(10, cols),
    stdVis = Math.max(20, vis);
  const c = document.createElement("canvas");
  c.width = 80;
  c.height = 160;
  const x = c.getContext("2d");
  x.fillStyle = "#05070c";
  x.fillRect(0, 0, 80, 160);
  const cell = Math.min(80 / stdCols, 160 / stdVis);
  const ox = (80 - cols * cell) / 2,
    oy = 160 - vis * cell;
  drawStyledGrid(x, grid, cols, vis, cell, ox, oy);
  try {
    return c.toDataURL();
  } catch (_) {
    return "";
  }
}

export const PRACTICE_PRESETS = [
  {
    n: "TETRIS WELL RIGHT",
    note: "Flat stack, well on the right: drop the I for a Tetris.",
    rows: ["...LOOJ...", "TTTLOOJJJ.", "LTTLLSSZJ.", "LTTTSSZZJ.", "LLIIIIZJJ."],
    q: "",
    rem: "IOSZ",
    cat: "TETRIS",
  },
  {
    n: "TETRIS WELL LEFT",
    note: "Flat stack, well on the left: drop the I for a Tetris.",
    rows: ["...LOOJ...", ".LLLOOJTTT", ".LSZZJJTTJ", ".LSSZZTTTJ", ".LLSIIIIJJ"],
    q: "",
    rem: "IOZS",
    cat: "TETRIS",
  },
  {
    n: "TSD A",
    note: "T-spin double: slide the T under the overhang, rotate in.",
    rows: ["L..ZZ.S...", "L...ZZSSOO", "LL.IIIISOO"],
    q: "",
    rem: "JT",
    cat: "T-SPIN DOUBLE",
  },
  {
    n: "TSD A (MIRROR)",
    note: "Mirrored T-spin double.",
    rows: ["...Z.SS..J", "OOZZSS...J", "OOZIIII.JJ"],
    q: "",
    rem: "LT",
    cat: "T-SPIN DOUBLE",
  },
  {
    n: "TSD B",
    note: "T-spin double: slide the T under the overhang, rotate in.",
    rows: ["...S......", "L..SSOOZZ.", "L...SOOJZZ", "LL.IIIIJJJ"],
    q: "",
    rem: "T",
    cat: "T-SPIN DOUBLE",
  },
  {
    n: "TSD B (MIRROR)",
    note: "Mirrored T-spin double.",
    rows: ["......Z...", ".SSOOZZ..J", "SSLOOZ...J", "LLLIIII.JJ"],
    q: "",
    rem: "T",
    cat: "T-SPIN DOUBLE",
  },
  {
    n: "TSD C",
    note: "T-spin double: slide the T under the overhang, rotate in.",
    rows: [".....S....", "L..ZZSSJJ.", "L...ZZSJOO", "LL.IIIIJOO"],
    q: "",
    rem: "T",
    cat: "T-SPIN DOUBLE",
  },
  {
    n: "TSD D",
    note: "T-spin double: slide the T under the overhang, rotate in.",
    rows: ["...JJJ....", "L..ZZJS...", "L...ZZSSOO", "LL.IIIISOO"],
    q: "",
    rem: "T",
    cat: "T-SPIN DOUBLE",
  },
  {
    n: "TST A",
    note: "T-spin triple: slide the T over the gap, kick down into the slot.",
    rows: ["...SS..L..", "..SS...L..", "JJLL.ZZLLT", "JOOL..ZZTT", "JOOL.IIIIT"],
    q: "",
    rem: "IJOSTZ",
    cat: "T-SPIN TRIPLE",
  },
  {
    n: "TST A (MIRROR)",
    note: "Mirrored T-spin triple.",
    rows: ["..J..ZZ...", "..J...ZZ..", "TJJSS.JJLL", "TTSS..JOOL", "TIIII.JOOL"],
    q: "",
    rem: "ILOZTS",
    cat: "T-SPIN TRIPLE",
  },
  {
    n: "TST B",
    note: "T-spin triple: slide the T over the gap, kick down into the slot.",
    rows: ["...ZZ.I...", "....ZZI...", "TTT.OOISLL", "JT..OOISSL", "JJJ.IIIISL"],
    q: "",
    rem: "JLOSTZ",
    cat: "T-SPIN TRIPLE",
  },
  {
    n: "TST B (MIRROR)",
    note: "Mirrored T-spin triple.",
    rows: ["...I.SS...", "...ISS....", "JJZIOO.TTT", "JZZIOO..TL", "JZIIII.LLL"],
    q: "",
    rem: "LJOZTS",
    cat: "T-SPIN TRIPLE",
  },
  {
    n: "TST C",
    note: "T-spin triple: slide the T over the gap, kick down into the slot.",
    rows: ["...IIII...", "....OO....", "LLL.OOSSZJ", "LT..JSSZZJ", "TTT.JJJZJJ"],
    q: "",
    rem: "ILOSTZ",
    cat: "T-SPIN TRIPLE",
  },
  {
    n: "PC SETUP 1",
    note: "Perfect clear: the next 3 pieces complete it — hold helps.",
    rows: ["...IIII...", "...LLLZZ.J", "OO.LSSTZZJ", "OO.SSTTTJJ"],
    q: "OTIJLSZ",
    rem: "",
    cat: "PERFECT CLEAR",
  },
  {
    n: "PC SETUP 2",
    note: "Perfect clear: the next 3 pieces complete it — hold helps.",
    rows: ["IIIIL.....", "ZZLLL...S.", "JZZOO..TSS", "JJJOO.TTTS"],
    q: "TJILOSZ",
    rem: "",
    cat: "PERFECT CLEAR",
  },
  {
    n: "4-WIDE START",
    note: "Start a 4-wide combo: keep clearing inside the centre well.",
    rows: ["..I.......", ".ZI....JJJ", "ZZI....LSJ", "ZTI....LSS", "TTT....LLS"],
    q: "",
    rem: "O",
    cat: "4-WIDE",
  },
  {
    n: "CLEAN GARBAGE",
    note: "Holes line up in stretches — dig it out with few pieces.",
    rows: [
      "#.########",
      "#.########",
      "######.###",
      "######.###",
      "######.###",
      "###.######",
      "###.######",
      "###.######",
    ],
    q: "",
    rem: "",
    cat: "DOWNSTACK",
  },
  {
    n: "CHEESE GARBAGE",
    note: "Messy single holes — practice downstacking.",
    rows: [
      ".#########",
      "######.###",
      "###.######",
      "#########.",
      "#####.####",
      "#.########",
      "########.#",
      "##.#######",
      "#######.##",
      "####.#####",
    ],
    q: "",
    rem: "",
    cat: "DOWNSTACK",
  },
];

export function selectedBoard() {
  if (configState.practice.boardSel === -2) return configState.practice.tempBoard || null;
  if (!Array.isArray(configState.practice.boards)) return null;
  if (typeof configState.practice.boardSel !== "number" || configState.practice.boardSel < 0)
    return null;
  return configState.practice.boards[configState.practice.boardSel] || null;
}

export function migrateBoards() {
  if (configState.practice.startBoard) {
    try {
      if (!Array.isArray(configState.practice.boards)) configState.practice.boards = [];
      if (!configState.practice.boards.length) {
        configState.practice.boards.push({
          name: "BOARD 1",
          cols: configState.practice.startBoard.cols,
          vis: configState.practice.startBoard.vis,
          grid: configState.practice.startBoard.grid.map((r) => r.slice()),
          thumb: boardThumb(
            configState.practice.startBoard.grid,
            configState.practice.startBoard.cols,
            configState.practice.startBoard.vis,
          ),
        });
        configState.practice.boardSel = 0;
      }
      configState.practice.startBoard = null;
      savePractice();
    } catch (_) {
      log.debug("practice/board-library.migrateBoards", _);
    }
  }
  if (!Array.isArray(configState.practice.boards)) configState.practice.boards = [];
  if (typeof configState.practice.boardSel !== "number") configState.practice.boardSel = -1;
}

export function addBoardEntry(grid, cols, vis, select) {
  migrateBoards();
  const entry = {
    name: "BOARD " + (configState.practice.boards.length + 1),
    cols: cols,
    vis: vis,
    grid: grid.map((r) => r.slice()),
    thumb: boardThumb(grid, cols, vis),
    fixedSize: true,
  };
  configState.practice.boards.push(entry);
  while (configState.practice.boards.length > 100) configState.practice.boards.shift();
  if (select) {
    configState.practice.boardSel = configState.practice.boards.length - 1;
    syncPracticeToBoard(configState.practice.boards[configState.practice.boardSel]);
  }
  configState.practice.startExtras = null;
  savePractice();
  renderBoardList();
}

export function renderBoardList() {
  const el = $("capBoardList");
  if (!el) return;
  migrateBoards();
  const list = configState.practice.boards;
  const selNone = $("capSelNoneBtn");
  if (selNone) selNone.style.display = list.length ? "" : "none";
  const note = $("capListNote");
  if (note)
    note.textContent =
      configState.practice.boardSel === -2
        ? "A replay position is loaded for START — tap a board to replace it."
        : list.length
          ? configState.practice.boardSel >= 0
            ? "The selected board loads on every START and Practice switches to its size — tap it again to deselect."
            : "No board selected — START uses the Garbage Lines setting."
          : "";
  if (!list.length) {
    el.innerHTML =
      '<div class="cbl-empty">No saved boards yet — capture an image, import a fumen, create an empty board, or add the presets.</div>';
    return;
  }
  el.innerHTML = list
    .map((b, i) => {
      const blocks = b.grid ? b.grid.reduce((s, r) => s + r.filter((v) => v).length, 0) : 0;
      const dims = b.cols !== 10 || b.vis !== 20 ? b.cols + "×" + b.vis + " · " : "",
        tag = isPresetBoard(b) ? "PRESET" + (b.cat ? " · " + b.cat : "") + " · " : "";
      return (
        '<div class="cbl-item' +
        (i === configState.practice.boardSel ? " sel" : "") +
        '" data-bi="' +
        i +
        '">' +
        '<div class="cbl-mv"><button class="cbl-mvb" data-bact="up" title="Move up" type="button"' +
        (i === 0 ? " disabled" : "") +
        '>▲</button><div class="cbl-grip" title="Drag to reorder"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="9" cy="6" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="9" cy="18" r="1.8"/><circle cx="15" cy="18" r="1.8"/></svg></div><button class="cbl-mvb" data-bact="down" title="Move down" type="button"' +
        (i === list.length - 1 ? " disabled" : "") +
        ">▼</button></div>" +
        '<img alt="" src="' +
        (b.thumb || "") +
        '">' +
        '<div class="cbl-info"><span class="cbl-name">' +
        escapeHtml(b.name) +
        '</span><span class="cbl-meta">' +
        escapeHtml(tag + dims) +
        blocks +
        " BLOCKS" +
        (b.seq ? " · " + escapeHtml(boardBagText(b)) : "") +
        "</span>" +
        (b.note ? '<span class="cbl-meta cbl-note">' + escapeHtml(b.note) + "</span>" : "") +
        "</div>" +
        '<button class="cbl-ic" data-bact="view" title="View & edit" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></button>' +
        '<button class="cbl-ic" data-bact="name" title="Rename" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>' +
        '<button class="cbl-ic del" data-bact="del" title="Delete" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>' +
        "</div>"
      );
    })
    .join("");
}

export function animMove(i, d) {
  const l = $("capBoardList"),
    A = l && l.children[i],
    B = l && l.children[i + d];
  if (!A || !B) {
    moveBoard(i, d);
    return;
  }
  const dist = B.getBoundingClientRect().top - A.getBoundingClientRect().top;
  A.style.zIndex = 2;
  [A, B].forEach((x) => (x.style.transition = "transform .2s ease"));
  A.style.transform = "translateY(" + dist + "px)";
  B.style.transform = "translateY(" + -dist + "px)";
  setTimeout(() => moveBoard(i, d), 210);
}

export function dragMoveBoard(from, to) {
  const b = configState.practice.boards.splice(from, 1)[0];
  configState.practice.boards.splice(to, 0, b);
  const sel = configState.practice.boardSel;
  if (sel === from) configState.practice.boardSel = to;
  else if (sel >= 0) {
    if (from < sel && to >= sel) configState.practice.boardSel--;
    else if (from > sel && to <= sel) configState.practice.boardSel++;
  }
  savePractice();
  renderBoardList();
}

export function renameBoard(i) {
  const b = configState.practice.boards && configState.practice.boards[i];
  if (!b) return;
  askConfirm(
    'Rename this board:<br><input id="boardNameInput" type="text" maxlength="18" class="tp-name" style="margin-top:10px;width:100%" value="' +
      escapeHtml(b.name) +
      '">',
    "SAVE",
    () => {
      const inp = $("boardNameInput");
      const nm = (inp && inp.value.trim() ? inp.value.trim() : b.name).toUpperCase().slice(0, 18);
      b.name = nm;
      savePractice();
      renderBoardList();
    },
  );
}

export function deleteBoard(i) {
  const b = configState.practice.boards && configState.practice.boards[i];
  if (!b) return;
  askConfirm(
    "Delete <b>" + escapeHtml(b.name) + "</b>?<br>This cannot be undone.",
    "DELETE",
    () => {
      configState.practice.boards.splice(i, 1);
      if (configState.practice.boardSel === i) configState.practice.boardSel = -1;
      else if (configState.practice.boardSel > i) configState.practice.boardSel--;
      savePractice();
      renderBoardList();
    },
  );
}

function bvPad(b) {
  if (b && b.grid && !b.fixedSize && b.cols === 10 && b.vis < 20) {
    while (b.grid.length < 20) b.grid.unshift(new Array(10).fill(0));
    b.vis = 20;
    b.thumb = boardThumb(b.grid, b.cols, b.vis);
    savePractice();
  }
}

function bvqChip(t, cls, attr) {
  return (
    '<button type="button" class="bvq-chip ' +
    cls +
    '" ' +
    attr +
    ' style="background:' +
    PIECES[t].c +
    '">' +
    PIECES[t].n +
    "</button>"
  );
}

export function bvqRender() {
  const hold = $("bvqHold"),
    nx = $("bvqNext"),
    th = $("bvqThen"),
    pal = $("bvqPal");
  if (!hold) return;
  let h =
    '<button type="button" class="bvq-chip none' +
    (boardLibraryState.bvSeq.h < 0 ? " sel" : "") +
    '" data-bvh="-1">—</button>';
  for (let t = 0; t < 7; t++)
    h += bvqChip(t, boardLibraryState.bvSeq.h === t ? "sel" : "", 'data-bvh="' + t + '"');
  hold.innerHTML = h;
  nx.innerHTML = boardLibraryState.bvSeq.rem.length
    ? boardLibraryState.bvSeq.rem
        .map((t, i) => bvqChip(t, "", 'data-bvrm="rem:' + i + '" title="Remove"'))
        .join("")
    : '<span class="bvq-empty">NONE</span>';
  th.innerHTML = boardLibraryState.bvSeq.q.length
    ? boardLibraryState.bvSeq.q
        .map((t, i) => bvqChip(t, "", 'data-bvrm="q:' + i + '" title="Remove"'))
        .join("")
    : '<span class="bvq-empty">EMPTY — RANDOM BAG</span>';
  pal.innerHTML = [0, 1, 2, 3, 4, 5, 6]
    .map((t) => bvqChip(t, "pal", 'data-bvadd="' + t + '"'))
    .join("");
  const a = $("bvqTgtQ"),
    r = $("bvqTgtR");
  if (a) a.classList.toggle("active", boardLibraryState.bvqTgt === "q");
  if (r) r.classList.toggle("active", boardLibraryState.bvqTgt === "rem");
}

function bvqLoad(b) {
  const sz = $("bvSize");
  if (sz) sz.textContent = "BOARD IS " + b.cols + "×" + b.vis;
  const s = b && b.seq;
  boardLibraryState.bvSeq = {
    q: s && Array.isArray(s.q) ? s.q.slice() : [],
    rem: s && Array.isArray(s.rem) ? s.rem.slice() : [],
    h: s && typeof s.h === "number" ? s.h : -1,
  };
  boardLibraryState.bvqTgt = "q";
  bvqRender();
}

export function bvqCommit(b) {
  if (
    boardLibraryState.bvSeq.q.length ||
    boardLibraryState.bvSeq.rem.length ||
    boardLibraryState.bvSeq.h >= 0
  )
    b.seq = {
      q: boardLibraryState.bvSeq.q.slice(),
      rem: boardLibraryState.bvSeq.rem.slice(),
      h: boardLibraryState.bvSeq.h >= 0 ? boardLibraryState.bvSeq.h : null,
    };
  else delete b.seq;
}

function bvSnap() {
  const b = configState.practice.boards && configState.practice.boards[boardLibraryState.bvIdx];
  return b && b.grid ? b.grid.map((r) => r.slice()) : null;
}

function bvUpdateBtns() {
  const u = $("bvUndoBtn"),
    r = $("bvRedoBtn"),
    p = $("bvPaintBtn"),
    e = $("bvEraseBtn");
  if (u) u.disabled = !boardLibraryState.bvHist.length;
  if (r) r.disabled = !boardLibraryState.bvRedo2.length;
  if (p) p.classList.toggle("active", boardLibraryState.bvTool === "paint");
  if (e) e.classList.toggle("active", boardLibraryState.bvTool === "erase");
}

function bvPush() {
  const s = bvSnap();
  if (!s) return;
  boardLibraryState.bvHist.push(s);
  if (boardLibraryState.bvHist.length > 80) boardLibraryState.bvHist.shift();
  boardLibraryState.bvRedo2.length = 0;
  bvUpdateBtns();
}

export function bvUndo() {
  if (!boardLibraryState.bvHist.length) return;
  const cur = bvSnap();
  if (cur) boardLibraryState.bvRedo2.push(cur);
  const s = boardLibraryState.bvHist.pop();
  const b = configState.practice.boards && configState.practice.boards[boardLibraryState.bvIdx];
  if (b && s) {
    b.grid = s;
    b.thumb = boardThumb(s, b.cols, b.vis);
  }
  bvDraw();
  bvUpdateBtns();
}

export function bvRedo() {
  if (!boardLibraryState.bvRedo2.length) return;
  const cur = bvSnap();
  if (cur) boardLibraryState.bvHist.push(cur);
  const s = boardLibraryState.bvRedo2.pop();
  const b = configState.practice.boards && configState.practice.boards[boardLibraryState.bvIdx];
  if (b && s) {
    b.grid = s;
    b.thumb = boardThumb(s, b.cols, b.vis);
  }
  bvDraw();
  bvUpdateBtns();
}

export function bvMirror() {
  const b = configState.practice.boards && configState.practice.boards[boardLibraryState.bvIdx];
  if (!b || !b.grid) return;
  bvPush();
  for (const row of b.grid) row.reverse();
  boardLibraryState.bvDirty = true;
  bvDraw();
}

export function bvSetTool(t) {
  boardLibraryState.bvTool = t;
  bvUpdateBtns();
}

export function bvOpen(i) {
  bvqMount("bv");
  const b = configState.practice.boards && configState.practice.boards[i];
  if (!b) return;
  bvPad(b);
  boardLibraryState.bvIdx = i;
  boardLibraryState.bvHist = [];
  boardLibraryState.bvRedo2 = [];
  boardLibraryState.bvTool = "paint";
  boardLibraryState.bvDown = false;
  boardLibraryState.bvDirty = false;
  const ov = $("ovBoardView");
  if (!ov) return;
  ov.classList.remove("hidden");
  ov.removeAttribute("inert");
  const t = $("bvTitle");
  if (t) t.textContent = b.name;
  const bn = $("bvName");
  if (bn) bn.value = b.name;
  bvqLoad(b);
  bvDraw();
  bvUpdateBtns();
}

export function bvSave() {
  if (boardLibraryState.bvDraft && boardLibraryState.bvDraft.i === boardLibraryState.bvIdx)
    boardLibraryState.bvDraft = null;
  if (boardLibraryState.bvIdx >= 0) {
    const b = configState.practice.boards[boardLibraryState.bvIdx];
    if (b && b.grid) {
      const bn = $("bvName");
      if (bn && bn.value.trim() && bn.value.trim().toUpperCase().slice(0, 18) !== b.name) {
        b.name = bn.value.trim().toUpperCase().slice(0, 18);
        const t = $("bvTitle");
        if (t) t.textContent = b.name;
      }
      if (boardLibraryState.bvDirty) {
        b.edited = true;
        delete b.preset;
      }
      bvqCommit(b);
      b.thumb = boardThumb(b.grid, b.cols, b.vis);
      savePractice();
      renderBoardList();
      toast("Board saved ✓");
    }
  }
  boardLibraryState.bvDirty = false;
}

export function bvClose(force) {
  if (!force && boardLibraryState.bvDirty) {
    askConfirm(
      "You have <b>unsaved changes</b>.<br>Save them before leaving?",
      "SAVE & EXIT",
      () => {
        bvSave();
        bvClose(true);
      },
      {
        cancelLabel: "DISCARD",
        onCancel: () => {
          boardLibraryState.bvDirty = false;
          bvClose(true);
        },
        stayLabel: "KEEP EDITING",
      },
    );
    return;
  }
  if (boardLibraryState.bvDraft && boardLibraryState.bvDraft.i === boardLibraryState.bvIdx) {
    const d = boardLibraryState.bvDraft;
    boardLibraryState.bvDraft = null;
    configState.practice.boards.splice(d.i, 1);
    configState.practice.boardSel = d.pv.sel;
    configState.practice.width = d.pv.w;
    configState.practice.height = d.pv.h;
    configState.practice.startExtras = d.pv.ex;
    clampPractice();
    savePractice();
    try {
      refreshPractice();
    } catch (_) {
      log.debug("practice/board-library.bvClose", _);
    }
    renderBoardList();
  }
  boardLibraryState.bvIdx = -1;
  boardLibraryState.bvHist = [];
  boardLibraryState.bvRedo2 = [];
  boardLibraryState.bvDirty = false;
  const ov = $("ovBoardView");
  if (ov) {
    ov.classList.add("hidden");
    ov.setAttribute("inert", "");
  }
}

function bvDraw() {
  const b = configState.practice.boards && configState.practice.boards[boardLibraryState.bvIdx];
  const cv = $("bvCanvas");
  if (!b || !cv) return;
  const stdCols = b.cols,
    stdVis = b.vis;
  const availW = Math.min(innerWidth * 0.92, 900),
    availH = innerHeight * 0.62;
  boardLibraryState.bvCell = Math.max(6, Math.min(availW / stdCols, availH / stdVis));
  const w = Math.round(stdCols * boardLibraryState.bvCell),
    h = Math.round(stdVis * boardLibraryState.bvCell);
  cv.style.width = w + "px";
  cv.style.height = h + "px";
  const d = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(w * d);
  cv.height = Math.round(h * d);
  const c = cv.getContext("2d");
  c.setTransform(d, 0, 0, d, 0, 0);
  c.fillStyle = "#05070c";
  c.fillRect(0, 0, w, h);
  c.strokeStyle = "rgba(148,170,210,.12)";
  c.lineWidth = 1;
  for (let x = 1; x < stdCols; x++) {
    c.beginPath();
    c.moveTo(x * boardLibraryState.bvCell + 0.5, 0);
    c.lineTo(x * boardLibraryState.bvCell + 0.5, h);
    c.stroke();
  }
  for (let y = 1; y < stdVis; y++) {
    c.beginPath();
    c.moveTo(0, y * boardLibraryState.bvCell + 0.5);
    c.lineTo(w, y * boardLibraryState.bvCell + 0.5);
    c.stroke();
  }
  drawStyledGrid(c, b.grid, b.cols, b.vis, boardLibraryState.bvCell, 0, 0);
}

function bvCellAt(e) {
  const cv = $("bvCanvas");
  const b = configState.practice.boards && configState.practice.boards[boardLibraryState.bvIdx];
  if (!cv || !b) return null;
  const r = cv.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / boardLibraryState.bvCell),
    y = Math.floor((e.clientY - r.top) / boardLibraryState.bvCell);
  const offsetY = 0;
  const srcY = y - offsetY;
  if (x < 0 || x >= b.cols || srcY < 0 || srcY >= b.vis) return null;
  return { x: x, y: srcY };
}

function bvApplyCell(c, val) {
  const b = configState.practice.boards && configState.practice.boards[boardLibraryState.bvIdx];
  if (!b || !b.grid) return;
  if (c.x < 0 || c.x >= b.cols || c.y < 0 || c.y >= b.vis) return;
  if (b.grid[c.y][c.x] !== val) {
    b.grid[c.y][c.x] = val;
    boardLibraryState.bvDirty = true;
  }
}

export function bvPointerDown(e) {
  if (boardLibraryState.bvIdx < 0) return;
  const b = configState.practice.boards[boardLibraryState.bvIdx];
  if (!b) return;
  e.preventDefault();
  const c = bvCellAt(e);
  if (!c) return;
  bvPush();
  boardLibraryState.bvDown = true;
  const erase = (e.button === 2) !== (boardLibraryState.bvTool === "erase");
  boardLibraryState.bvPaintVal = erase ? 0 : 8;
  bvApplyCell(c, boardLibraryState.bvPaintVal);
  bvDraw();
  try {
    e.target.setPointerCapture(e.pointerId);
  } catch (_) {
    log.debug("practice/board-library.bvPointerDown", _);
  }
}

export function bvPointerMove(e) {
  if (!boardLibraryState.bvDown || boardLibraryState.bvIdx < 0) return;
  const b = configState.practice.boards[boardLibraryState.bvIdx];
  if (!b) return;
  e.preventDefault();
  const c = bvCellAt(e);
  if (!c) return;
  if (b.grid[c.y][c.x] !== boardLibraryState.bvPaintVal) {
    bvApplyCell(c, boardLibraryState.bvPaintVal);
    bvDraw();
  }
}

export function bvPointerUp() {
  boardLibraryState.bvDown = false;
  const b = configState.practice.boards && configState.practice.boards[boardLibraryState.bvIdx];
  if (b && b.grid) {
    b.thumb = boardThumb(b.grid, b.cols, b.vis);
    savePractice();
  }
  bvUpdateBtns();
}
