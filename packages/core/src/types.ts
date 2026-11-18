/** A cell offset `[x, y]` inside a piece's bounding box. */
export type Cell = readonly [number, number];

/** Playfield rows from the top (row 0) down; `0` is empty, `1..7` is a piece type plus one, other values are garbage. */
export type Board = number[][];

/** Playfield size. Passed explicitly so the same rules serve every board size. */
export interface Dims {
  readonly cols: number;
  readonly rows: number;
}

/** Static description of one tetromino: letter, colour, and the cells of its four rotations. */
export interface PieceDef {
  readonly n: string;
  readonly c: string;
  readonly cells: readonly (readonly Cell[])[];
}

/** Kick tests keyed `"<from>><to>"` (for example `"0>1"`), tried in order as `[dx, dy]` with y pointing up. */
export type KickTable = Readonly<Record<string, readonly Cell[]>>;

/** Rotation request: `1` clockwise, `-1` counter-clockwise, `2` half turn. */
export type RotateKind = -1 | 1 | 2;

/** How the last successful rotation moved the piece. `dir` is 0 for a half turn. */
export interface LastRotate {
  readonly kick: number;
  readonly dir: number;
}

/** The part of a falling piece the rules need to read. */
export interface PieceState {
  type: number;
  rot: number;
  x: number;
  y: number;
  lastRotate?: LastRotate | null;
}

/** Result of spin detection: `null` means no spin, otherwise whether it only counts as a mini. */
export type SpinResult = { readonly mini: boolean } | null;
