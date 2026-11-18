import { SPIN_BASE } from "./pieces";
import type { SpinResult } from "./types";

/** Garbage lines sent for a combo of the given length (the last entry applies to longer combos). */
export const COMBO_ATK: readonly number[] = [
  0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 9, 10,
];

/** Score and chain updates for one piece lock. */
export interface LockScore {
  readonly difficult: boolean;
  /** Back-to-back chain length after this lock. */
  readonly nb: number;
  /** Combo counter after this lock (`-1` when no line was cleared). */
  readonly nc: number;
  readonly base: number;
  readonly pts: number;
  readonly comboPts: number;
  readonly pcBonus: number;
  readonly b2bUsed: boolean;
}

/** Points for locking a piece that clears `nRows` lines, with the chains it continues or breaks. */
export function calcLockScore(
  nRows: number,
  spin: SpinResult,
  lvl: number,
  combo: number,
  b2b: number,
  willPC: boolean,
): LockScore {
  const difficult = nRows === 4 || (!!spin && nRows >= 1);
  let nb = b2b;
  if (nRows || spin) {
    if (difficult) nb = b2b + 1;
    else if (nRows) nb = 0;
  }
  let base = 0;
  if (spin) {
    if (spin.mini) base = [100, 200, 400, 800][nRows] || 0;
    else base = nRows === 0 ? 400 : SPIN_BASE[Math.min(nRows, 3)]!;
  } else if (nRows === 4) base = 800;
  else if (nRows) base = [0, 100, 300, 500][nRows]!;
  const nc = nRows ? combo + 1 : -1;
  let pts = base * lvl;
  const b2bUsed = difficult && nb >= 2;
  if (b2bUsed) pts = Math.floor(pts * 1.5);
  const comboPts = nRows && nc >= 1 ? 50 * nc * lvl : 0;
  let pcBonus = 0;
  if (willPC && nRows) pcBonus = [800, 1200, 1800, 2000][nRows - 1]! * lvl;
  pts += comboPts + pcBonus;
  return { difficult, nb, nc, base, pts, comboPts, pcBonus, b2bUsed };
}

/** Garbage lines sent for a lock, before the versus multiplier. `b2bAfter` and `comboAfter` are the counters after the lock. */
export function calcAttack(
  lines: number,
  spin: SpinResult,
  pc: boolean,
  b2bAfter: number,
  comboAfter: number,
): number {
  let base: number;
  if (spin) {
    if (spin.mini) base = 0;
    else base = [0, 2, 4, 6][lines] || 0;
  } else {
    base = [0, 0, 1, 2, 4][lines] || 0;
  }
  if (base === 0 && !pc) return 0;
  let atk = base;
  if (b2bAfter >= 2) atk += 1;
  if (lines > 0) atk += COMBO_ATK[Math.min(comboAfter, COMBO_ATK.length - 1)]!;
  if (pc) atk += 10;
  return atk;
}
