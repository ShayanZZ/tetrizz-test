// @ts-nocheck
import { KJ, PIECES } from "@tetrizz/core";
import { botContext } from "./context";

/** Shared bitboard helpers for the 10-wide and 4-wide bot evaluators. */

/** `[type][rotation]` lists of the four cell offsets, split into x and y for the hot loops. */
const CELL_DX: Int8Array[][] = [];
const CELL_DY: Int8Array[][] = [];

export const bitboardState = {
  CC_CELLS: PIECES.map((p) => p.cells.map((rot) => rot.map((q) => [q[0], -q[1]]))),
};

for (const rotations of bitboardState.CC_CELLS) {
  CELL_DX.push(rotations.map((cells) => Int8Array.from(cells, (q) => q[0])));
  CELL_DY.push(rotations.map((cells) => Int8Array.from(cells, (q) => q[1])));
}

/** The two front corners of a T piece for each rotation, in bot coordinates (y points down). */
export const T_FRONT = {
  0: [
    [0, 0],
    [2, 0],
  ],
  1: [
    [2, 0],
    [2, -2],
  ],
  2: [
    [0, -2],
    [2, -2],
  ],
  3: [
    [0, -2],
    [0, 0],
  ],
};

/** Encodes a game board as one bit mask per column; bit 0 is the bottom row. */
export function encodeBoard(bd) {
  const c = new Array(botContext.cols).fill(0);
  for (let x = 0; x < botContext.cols; x++) {
    let b = 0;
    for (let y = botContext.rows - 1; y >= 0; y--) {
      const bit = botContext.rows - 1 - y;
      if (bit >= 31) continue;
      if (bd[y][x]) b |= 1 << bit;
    }
    c[x] = b >>> 0;
  }
  return c;
}

/** Cells of a piece in bot coordinates. */
export function pieceCells(type, rot) {
  return bitboardState.CC_CELLS[type][rot];
}

/** True when the piece at `(x, y)` fits: inside the walls and floor and not on a filled cell. */
export function isValid(c, type, rot, x, y) {
  const dxs = CELL_DX[type][rot];
  const dys = CELL_DY[type][rot];
  const cols = botContext.cols;
  const rows = botContext.rows;
  for (let i = 0; i < dxs.length; i++) {
    const bx = x + dxs[i];
    const by = y + dys[i];
    if (bx < 0 || bx >= cols || by < 0) return false;
    if (by < rows && c[bx] & (1 << by)) return false;
  }
  return true;
}

/** Height of column `x`: one more than its highest filled row, `0` when empty, a large value outside the board. `mask` limits the rows counted. */
export function columnHeight(c, x, mask) {
  if (x < 0 || x >= botContext.cols) return botContext.rows + 10;
  let v = (c[x] || 0) >>> 0;
  if (mask !== undefined) v &= mask;
  return 32 - Math.clz32(v);
}

/**
 * Builds the evaluator helpers that differ between the two board shapes.
 *
 * - `occRows()` is the row limit used by the occupancy test.
 * - `dropTop` is how far above the board a drop starts.
 * - `guarded` makes drops stop after a fixed number of steps and report failure.
 * - `heightMask()` limits which rows count for column heights (`undefined` for all rows).
 */
export function createBotOps({ occRows, dropTop, guarded, heightMask }) {
  function occ(c, x, y) {
    if (x < 0 || x >= botContext.cols || y < 0 || y >= occRows()) return true;
    return !!(((c[x] || 0) >>> 0) & (1 << y));
  }

  function height(c, x) {
    return columnHeight(c, x, heightMask());
  }

  function drop(c, type, rot, x) {
    const dxs = CELL_DX[type][rot];
    const dys = CELL_DY[type][rot];
    const cols = botContext.cols;
    const rows = botContext.rows;
    for (let i = 0; i < dxs.length; i++) {
      const bx = x + dxs[i];
      if (bx < 0 || bx >= cols) return -1;
    }
    // The piece falls from above the board, so it stops at the first cell that meets a column's
    // highest filled row (or the floor). Starting just above that point gives the same answer as
    // starting at the top without stepping through the empty rows.
    const rowMask = rows >= 31 ? 0x7fffffff : (1 << rows) - 1;
    let firstHit = -Infinity;
    for (let i = 0; i < dxs.length; i++) {
      const v = (c[x + dxs[i]] || 0) & rowMask;
      const hit = 31 - Math.clz32(v) - dys[i];
      if (hit > firstHit) firstHit = hit;
    }
    let y = Math.min(rows + dropTop, firstHit + 1);
    let guard = rows + 16;
    while (y > -4 && (!guarded || guard-- > 0)) {
      let ok = true;
      for (let i = 0; i < dxs.length; i++) {
        const by = y + dys[i];
        if (by < 0) {
          ok = false;
          break;
        }
        if (by >= rows) continue;
        if (c[x + dxs[i]] & (1 << by)) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        y++;
        break;
      }
      y--;
    }
    if (guarded && guard < 0) return -1;
    if (!isValid(c, type, rot, x, y)) return -1;
    return y;
  }

  function dropFrom(c, type, rot, x, sy) {
    let y = sy;
    let guard = botContext.rows + 16;
    while (y > -4 && isValid(c, type, rot, x, y - 1) && (!guarded || guard-- > 0)) y--;
    if (guarded && guard < 0) return -1;
    if (!isValid(c, type, rot, x, y)) return -1;
    return y;
  }

  /** 0 for no spin, 1 for a mini, 2 for a full spin. `ki` is the kick test that placed the piece. */
  function spin(c, type, rot, x, y, ki) {
    if (type === 5) {
      const corners = [
        [0, 0],
        [2, 0],
        [0, -2],
        [2, -2],
      ];
      let filled = 0;
      for (const [a, b] of corners) if (occ(c, x + a, y + b)) filled++;
      if (filled < 3) return 0;
      const front = T_FRONT[rot];
      let ff = 0;
      for (const [a, b] of front) if (occ(c, x + a, y + b)) ff++;
      return ff === 2 || ki === 4 ? 2 : 1;
    }
    if (
      !isValid(c, type, rot, x - 1, y) &&
      !isValid(c, type, rot, x + 1, y) &&
      !isValid(c, type, rot, x, y + 1)
    )
      return 1;
    return 0;
  }

  function tSlotScore(c, W, tComing) {
    if (!tComing) return 0;
    let score = 0,
      found = 0;
    for (const fromRot of [0, 1, 2, 3]) {
      if (found >= 2) break;
      const cells = pieceCells(5, fromRot);
      let mn = 9,
        mx = -9;
      for (const [dx] of cells) {
        if (dx < mn) mn = dx;
        if (dx > mx) mx = dx;
      }
      for (let px = -mn; px <= botContext.cols - 1 - mx; px++) {
        if (found >= 2) break;
        const sy = drop(c, 5, fromRot, px);
        if (sy < 0) continue;
        for (const dir of [1, 3]) {
          const nr = (fromRot + dir) % 4;
          const kicks = KJ[fromRot + ">" + nr];
          if (!kicks) continue;
          for (let ki = 1; ki < kicks.length; ki++) {
            const nx = px + kicks[ki][0],
              ny = sy + kicks[ki][1];
            if (!isValid(c, 5, nr, nx, ny)) continue;
            let earlier = false;
            for (let ej = 0; ej < ki; ej++) {
              if (isValid(c, 5, nr, px + kicks[ej][0], sy + kicks[ej][1])) {
                earlier = true;
                break;
              }
            }
            if (earlier) continue;
            const fy = dropFrom(c, 5, nr, nx, ny);
            if (fy < 0) continue;
            const kind = spin(c, 5, nr, nx, fy, ki);
            if (kind > 0) {
              found++;
              score += kind === 2 ? W.tslot[2] : W.tslot[1];
              break;
            }
          }
        }
      }
    }
    return score;
  }

  /** Plays a move on the encoded board with the given `place` function and returns the new board with the chain state it leaves. */
  function makeSim(place) {
    return function sim(c, type, mv, b2b, combo) {
      const res = place(c, type, mv);
      const nc = res[0];
      const lines = res[1];
      const pc = nc.every((v) => (v || 0) >>> 0 === 0);
      const isDiff = lines === 4 || (mv.spin === 2 && lines > 0);
      const newB2B = lines > 0 ? isDiff : b2b;
      const usedB2B = lines > 0 && isDiff && b2b;
      const brokeB2B = lines > 0 && !isDiff && b2b;
      const newCombo = lines > 0 ? combo + 1 : -1;
      return {
        c: nc,
        info: {
          lines,
          spin: mv.spin,
          pc,
          b2b: usedB2B,
          hasB2B: newB2B,
          combo: newCombo,
          ptype: type,
          sd: mv.sd,
          brokeB2B,
        },
        nb: newB2B,
        nc2: newCombo,
      };
    };
  }

  return { occ, height, drop, dropFrom, spin, tSlotScore, makeSim };
}
