import { collideOn } from "./board";
import { PIECES } from "./pieces";
import type { Board, Dims, PieceState, SpinResult } from "./types";

const T_FRONT_CORNERS: Readonly<Record<number, readonly [number, number]>> = {
  0: [0, 1],
  1: [1, 3],
  2: [2, 3],
  3: [0, 2],
};

const T_CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [2, 0],
  [0, 2],
  [2, 2],
];

/**
 * Spin detection for the piece in its current place.
 *
 * The T piece uses the three-corner rule (a mini unless both front corners are filled or the
 * last kick was the fifth test); every other piece counts as a spin when it cannot move in
 * any direction. The caller decides whether the last action was a rotation.
 */
export function detectSpinOn(bd: Board, dims: Dims, p: PieceState): SpinResult {
  const t = p.type;
  const cells = PIECES[t]!.cells[p.rot]!;
  const immobile =
    collideOn(bd, dims, cells, p.x - 1, p.y) &&
    collideOn(bd, dims, cells, p.x + 1, p.y) &&
    collideOn(bd, dims, cells, p.x, p.y - 1) &&
    collideOn(bd, dims, cells, p.x, p.y + 1);
  if (t === 5) {
    const x = p.x;
    const y = p.y;
    const occ = (X: number, Y: number): boolean =>
      X < 0 || X >= dims.cols || Y >= dims.rows || (Y >= 0 && !!bd[Y]![X]);
    const cn = T_CORNERS.map(([a, b]) => occ(x + a, y + b));
    if (cn.filter(Boolean).length >= 3) {
      const front = T_FRONT_CORNERS[p.rot]!;
      const both = cn[front[0]] && cn[front[1]];
      return { mini: !(both || (p.lastRotate && p.lastRotate.kick === 4)) };
    }
    return immobile ? { mini: true } : null;
  }
  return immobile ? { mini: false } : null;
}
