import type { Board, Cell, Dims } from "./types";

/** A new empty row for a board that is `cols` wide. */
export function emptyRow(cols: number): number[] {
  return Array(cols).fill(0);
}

/** True when any cell of the piece, placed at `(x, y)`, is outside the walls or floor or on a filled cell. Cells above the top are free. */
export function collideOn(
  bd: Board,
  dims: Dims,
  cells: readonly Cell[],
  x: number,
  y: number,
): boolean {
  for (const [cx, cy] of cells) {
    const X = x + cx;
    const Y = y + cy;
    if (X < 0 || X >= dims.cols || Y >= dims.rows) return true;
    if (Y >= 0 && bd[Y]![X]) return true;
  }
  return false;
}

/** Indices of the rows that have no empty cell, top to bottom. */
export function findFullRows(bd: Board, dims: Dims): number[] {
  const rows: number[] = [];
  for (let y = 0; y < dims.rows; y++) if (bd[y]!.every((v) => v)) rows.push(y);
  return rows;
}

/** Whether clearing `rows` would leave the board completely empty (a perfect clear). */
export function pcAfterClear(bd: Board, dims: Dims, rows: readonly number[]): boolean {
  if (!rows.length) return false;
  for (let y = 0; y < dims.rows; y++) {
    if (rows.indexOf(y) >= 0) continue;
    for (let x = 0; x < dims.cols; x++) if (bd[y]![x]) return false;
  }
  return true;
}

/** Removes `rows` in the given order and adds an empty row at the top for each, in place. */
export function spliceRows(bd: Board, dims: Dims, rows: readonly number[]): void {
  for (const r of rows) {
    bd.splice(r, 1);
    bd.unshift(emptyRow(dims.cols));
  }
}
