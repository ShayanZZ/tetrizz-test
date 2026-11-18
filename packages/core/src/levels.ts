/** Milliseconds per row at the fixed sprint and battle gravity. */
export const SPRINT_GRAV_MS = 833;
export const BATTLE_GRAV_MS = 833;

/** Milliseconds per row for the classic level curve; never faster than 8 ms. */
export const speedFor = (level: number): number =>
  Math.max(1000 * Math.pow(0.8 - (level - 1) * 0.007, level - 1), 8);

/** Total lines needed to reach each timed-mode level starting from level 2. */
const BLITZ_TOTAL: readonly number[] = [
  3, 8, 15, 24, 35, 48, 63, 80, 99, 120, 144, 170, 198, 228, 260,
];

/** Seconds per row for each timed-mode level. */
const BLITZ_GRAV_S: readonly number[] = [
  1, 0.643, 0.404, 0.249, 0.15, 0.088, 0.0505, 0.0283, 0.0155, 0.00827, 0.00431, 0.00219, 0.00108,
  0.00052, 0.00024,
];

/** Timed-mode level reached after `n` cleared lines. */
export function blitzLevelForLines(n: number): number {
  let lv = 1;
  for (let i = 0; i < BLITZ_TOTAL.length; i++) {
    if (n >= BLITZ_TOTAL[i]!) lv = i + 2;
    else break;
  }
  return lv;
}

/** Timed-mode gravity in milliseconds per row for a level; levels past the table use the fastest entry. */
export function blitzGravMsForLevel(lv: number): number {
  const s =
    lv >= 1 && lv <= BLITZ_GRAV_S.length
      ? BLITZ_GRAV_S[lv - 1]!
      : BLITZ_GRAV_S[BLITZ_GRAV_S.length - 1]!;
  return Math.max(1, Math.round(s * 1000));
}
