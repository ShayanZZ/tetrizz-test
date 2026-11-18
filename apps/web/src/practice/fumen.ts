// @ts-nocheck
import { PIECES } from "@tetrizz/core";
import { log } from "../core/logger";
import { configState } from "../core/config";
import { $, savePractice } from "../ui/layout";
import { showEditNote } from "../ui/settings";
import { addBoardEntry, renderBoardList, selectedBoard } from "./board-library";

const fumenState = {
  FUMEN_LIB: null,
  FUMEN_LOADING: null,
};

async function fumenLib() {
  if (fumenState.FUMEN_LIB) return fumenState.FUMEN_LIB;
  if (fumenState.FUMEN_LOADING) return fumenState.FUMEN_LOADING;
  fumenState.FUMEN_LOADING = (async () => {
    let ns;
    try {
      ns = await import("https://cdn.jsdelivr.net/npm/tetris-fumen@1.1.3/+esm");
    } catch (e) {
      fumenState.FUMEN_LOADING = null;
      throw new Error("Could not load the fumen library (internet connection needed).");
    }

    let decode = null,
      encode = null,
      Field = null;
    const pools = [ns, ns && ns.default, ns && ns.default && ns.default.default];
    for (const o of pools) {
      if (!o) continue;
      if (!decode && o.decoder && typeof o.decoder.decode === "function")
        decode = o.decoder.decode.bind(o.decoder);
      if (!encode && o.encoder && typeof o.encoder.encode === "function")
        encode = o.encoder.encode.bind(o.encoder);
      if (!decode && typeof o.decode === "function") decode = o.decode.bind(o);
      if (!encode && typeof o.encode === "function") encode = o.encode.bind(o);
      if (!Field && o.Field && typeof o.Field.create === "function") Field = o.Field;
    }
    if (!decode || !encode) {
      fumenState.FUMEN_LOADING = null;
      throw new Error("Unexpected fumen library API.");
    }
    fumenState.FUMEN_LIB = { encode: encode, decode: decode, Field: Field };
    fumenState.FUMEN_LOADING = null;
    return fumenState.FUMEN_LIB;
  })();
  return fumenState.FUMEN_LOADING;
}

function valToFumenChar(v) {
  if (!v) return "_";
  if (v === 8) return "X";
  return PIECES[v - 1].n;
}

function fumenCharToVal(ch) {
  if (!ch || ch === "_" || ch === " ") return 0;
  if (ch === "X" || ch === "x") return 8;
  for (let i = 0; i < 7; i++) if (PIECES[i].n === ch) return i + 1;
  return 0;
}

function fumenReadFieldGrid(field, cols, vis) {
  const grid = [];
  for (let y = 0; y < vis; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      let ch = "_";
      try {
        ch = field.at(x, vis - 1 - y);
      } catch (_) {
        log.debug("practice/fumen.fumenReadFieldGrid", _);
      }
      row.push(fumenCharToVal(ch));
    }
    grid.push(row);
  }
  return grid;
}

function fumenQuizComment(sq) {
  if (!sq) return "";
  const L = "IJLOSTZ";
  const qs = (sq.rem || []).concat(sq.q || []).filter((t) => t >= 0 && t < 7);
  if (!qs.length) return "";
  const hold = typeof sq.h === "number" && sq.h >= 0 && sq.h < 7 ? L[sq.h] : "";
  return (
    "#Q=[" +
    hold +
    "](" +
    L[qs[0]] +
    ")" +
    qs
      .slice(1)
      .map((t) => L[t])
      .join("")
  );
}

function fumenParseQuiz(pages) {
  const L = "IJLOSTZ";
  for (const pg of pages) {
    const c = pg && typeof pg.comment === "string" ? pg.comment : "";
    const m = c.match(/#Q=\[([TIOSZJL]?)\]\(([TIOSZJL]?)\)([TIOSZJL]*)/i);
    if (!m) continue;
    const h = m[1] ? L.indexOf(m[1].toUpperCase()) : -1;
    const q = ((m[2] || "") + (m[3] || ""))
      .toUpperCase()
      .split("")
      .map((ch) => L.indexOf(ch))
      .filter((t) => t >= 0);
    if (q.length || h >= 0) return { q: q, rem: [], h: h >= 0 ? h : null };
  }
  return null;
}

export async function fumenExport() {
  const inp = $("fumenInput");
  const sb = selectedBoard();
  if (!sb || !sb.grid) {
    showEditNote("Tap a board in Saved Boards to select it, then press EXPORT SELECTED.");
    return;
  }
  const cols = sb.cols || 10,
    vis = sb.vis || sb.grid.length;
  let lib;
  try {
    lib = await fumenLib();
  } catch (e) {
    showEditNote(e.message);
    return;
  }
  if (!lib.Field) {
    showEditNote("Fumen export needs the Field class — library incomplete.");
    return;
  }
  const ox = Math.max(0, Math.floor((10 - cols) / 2));
  let code = "",
    ok = false;
  const comment = fumenQuizComment(sb.seq);
  try {
    const f = lib.Field.create();
    for (let i = 0; i < vis; i++) {
      const y = vis - 1 - i;
      if (y > 22) continue;
      for (let x = 0; x < cols && ox + x < 10; x++) {
        const v = sb.grid[i] && sb.grid[i][x];
        if (v) f.set(ox + x, y, valToFumenChar(v));
      }
    }
    code = lib.encode([
      comment ? { field: f, comment: comment, flags: { quiz: true } } : { field: f },
    ]);
    const back = lib.decode(code),
      bf = back && back[0] && back[0].field;
    ok = !!bf;
    if (ok) {
      verify: for (let i = 0; i < vis; i++) {
        const y = vis - 1 - i;
        if (y > 22) continue;
        for (let x = 0; x < cols && ox + x < 10; x++) {
          if (fumenCharToVal(bf.at(ox + x, y)) !== ((sb.grid[i] && sb.grid[i][x]) || 0)) {
            ok = false;
            break verify;
          }
        }
      }
    }
  } catch (e) {
    showEditNote("Fumen export failed.");
    return;
  }
  if (inp) inp.value = code;
  try {
    if (navigator.clipboard) navigator.clipboard.writeText(code);
  } catch (_) {
    log.debug("practice/fumen.fumenExport", _);
  }
  showEditNote(
    ok
      ? 'Fumen of "' + sb.name + '" copied ✓' + (comment ? " (includes queue/hold)" : "")
      : "Fumen exported (verify the code before sharing).",
  );
}

export async function fumenImport() {
  const inp = $("fumenInput");
  const raw = inp ? inp.value.trim() : "";
  if (!raw) {
    showEditNote("Paste a fumen code first.");
    return;
  }
  const m = raw.replace(/\s+/g, "").match(/[vmd]1[01]\d@[A-Za-z0-9+\/?]+/i);
  const code = m ? m[0] : raw;
  let lib;
  try {
    lib = await fumenLib();
  } catch (e) {
    showEditNote(e.message);
    return;
  }
  let pages;
  try {
    pages = lib.decode(code);
  } catch (_) {
    pages = null;
  }
  if (!pages || !pages.length) {
    showEditNote("Invalid fumen code.");
    return;
  }
  let pg0 = null;
  for (const pg of pages) {
    if (pg && pg.field) {
      pg0 = pg;
      break;
    }
  }
  if (!pg0) {
    showEditNote("That fumen has no board data.");
    return;
  }

  const g = fumenReadFieldGrid(pg0.field, 10, 23);
  const dropped = g.slice(0, g.length - 20).some((r) => r.some((v) => v));
  const grid = g.slice(g.length - 20);
  if (!grid.some((r) => r.some((v) => v))) {
    showEditNote("That fumen board is empty.");
    return;
  }
  addBoardEntry(grid, 10, 20, true);
  const ent = selectedBoard();
  let extra = "";
  if (ent) {
    ent.name = "FUMEN " + configState.practice.boards.length;
    const sq = fumenParseQuiz(pages);
    if (sq) {
      ent.seq = sq;
      extra = " · queue/hold loaded";
    }
    if (pages.length > 1) extra += " · page 1 of " + pages.length;
    savePractice();
    renderBoardList();
  }
  showEditNote(
    "Fumen imported & saved to boards list ✓" +
      extra +
      (dropped ? " · blocks above row 20 dropped" : ""),
  );
}
