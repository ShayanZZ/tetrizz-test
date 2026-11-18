import { collideOn } from "./board";
import { K180, KI, KJ, PIECES } from "./pieces";
import type { Board, Cell, Dims, KickTable, PieceState, RotateKind } from "./types";

/** The rotation index a piece ends up in after turning `kind` from `from`. */
export function rotationTarget(from: number, kind: RotateKind): number {
  return kind === 2 ? (from + 2) % 4 : (from + (kind === 1 ? 1 : 3)) % 4;
}

/**
 * Kick tests for a rotation, in the order they are tried.
 *
 * The half-turn table is a plain list, not keyed by rotation, so the key lookup misses and a
 * half turn only ever tests the unkicked position. This is how the game has always played and
 * changing it would change every half-turn, so it is kept as is.
 */
export function kickTests(
  type: number,
  from: number,
  to: number,
  kind: RotateKind,
): readonly Cell[] {
  const table = (kind === 2 ? K180 : type === 0 ? KI : KJ) as unknown as KickTable;
  return table[from + ">" + to] || [[0, 0]];
}

/** Where a successful rotation puts the piece and which kick test passed (`kick`) with its turn direction (`dir`). */
export interface RotateResult {
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly cells: readonly Cell[];
  readonly kick: number;
  readonly dir: number;
}

/** Tries a rotation on `bd` without changing the piece. Returns `null` for the square piece or when every kick collides. */
export function tryRotateOn(
  bd: Board,
  dims: Dims,
  p: PieceState,
  kind: RotateKind,
): RotateResult | null {
  if (p.type === 3) return null;
  const to = rotationTarget(p.rot, kind);
  const tests = kickTests(p.type, p.rot, to, kind);
  const cells = PIECES[p.type]!.cells[to]!;
  for (let i = 0; i < tests.length; i++) {
    const nx = p.x + tests[i]![0];
    const ny = p.y - tests[i]![1];
    if (!collideOn(bd, dims, cells, nx, ny)) {
      return { x: nx, y: ny, rot: to, cells, kick: i, dir: kind === 1 ? 1 : kind === -1 ? -1 : 0 };
    }
  }
  return null;
}
