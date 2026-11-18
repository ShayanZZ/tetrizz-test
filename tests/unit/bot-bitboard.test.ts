import { describe, expect, it } from "vitest";
import { mulberry32, PIECES } from "@tetrizz/core";
import { setBotContext } from "@tetrizz/bot";
import { columnHeight, createBotOps, isValid } from "../../packages/bot/src/bitboard";

/**
 * The bot's board helpers were rewritten for speed. These reference versions are the original
 * step-by-step implementations; the fast ones must agree with them on every board.
 */
const CELLS = PIECES.map((p) =>
  p.cells.map((rot) => rot.map((q) => [q[0], -q[1]] as [number, number])),
);

interface Shape {
  cols: number;
  rows: number;
}

function refIsValid(
  s: Shape,
  c: number[],
  type: number,
  rot: number,
  x: number,
  y: number,
): boolean {
  const cells = CELLS[type]![rot]!;
  for (const [dx, dy] of cells) {
    const bx = x + dx;
    const by = y + dy;
    if (bx < 0 || bx >= s.cols || by < 0) return false;
    if (by < s.rows && ((c[bx] || 0) >>> 0) & (1 << by)) return false;
  }
  return true;
}

function refDrop(
  s: Shape,
  dropTop: number,
  guarded: boolean,
  c: number[],
  type: number,
  rot: number,
  x: number,
): number {
  const cells = CELLS[type]![rot]!;
  for (const [dx] of cells) {
    const bx = x + dx;
    if (bx < 0 || bx >= s.cols) return -1;
  }
  let y = s.rows + dropTop;
  let guard = s.rows + 16;
  while (y > -4 && (!guarded || guard-- > 0)) {
    let ok = true;
    for (const [dx, dy] of cells) {
      const by = y + dy;
      if (by < 0) {
        ok = false;
        break;
      }
      if (by >= s.rows) continue;
      if (((c[x + dx] || 0) >>> 0) & (1 << by)) {
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
  if (!refIsValid(s, c, type, rot, x, y)) return -1;
  return y;
}

function refHeight(s: Shape, c: number[], x: number, mask?: number): number {
  if (x < 0 || x >= s.cols) return s.rows + 10;
  let v = (c[x] || 0) >>> 0;
  if (mask !== undefined) v &= mask;
  let h = 0;
  while (v) {
    h++;
    v >>>= 1;
  }
  return h;
}

/** Columns with random heights, holes and overhangs; some are filled with arbitrary bits. */
function randomBoard(rand: () => number, s: Shape): number[] {
  const full = (1 << s.rows) - 1;
  return Array.from({ length: s.cols }, () => {
    const roll = rand();
    if (roll < 0.15) return 0;
    if (roll < 0.35) return Math.floor(rand() * 2 ** s.rows) & full;
    const h = Math.floor(rand() * (s.rows + 1));
    let v = (1 << h) - 1;
    if (rand() < 0.5) v &= ~(1 << Math.floor(rand() * Math.max(h, 1)));
    return v & full;
  });
}

describe("bot board helpers match the original implementations", () => {
  const shapes: Shape[] = [
    { cols: 10, rows: 23 },
    { cols: 4, rows: 29 },
    { cols: 7, rows: 20 },
    { cols: 12, rows: 25 },
  ];
  const variants = [
    { name: "10-wide", dropTop: 4, guarded: false },
    { name: "4-wide", dropTop: 3, guarded: true },
  ];

  for (const shape of shapes) {
    for (const variant of variants) {
      it(`${shape.cols}x${shape.rows} ${variant.name}`, () => {
        setBotContext(shape);
        const ops = createBotOps({
          occRows: () => shape.rows,
          dropTop: variant.dropTop,
          guarded: variant.guarded,
          heightMask: () => undefined,
        });
        const rand = mulberry32(shape.cols * 1000 + shape.rows);
        const failures: string[] = [];
        for (let b = 0; b < 120; b++) {
          const c = randomBoard(rand, shape);
          for (let type = 0; type < 7; type++) {
            for (let rot = 0; rot < 4; rot++) {
              for (let x = -3; x <= shape.cols + 2; x++) {
                const want = refDrop(shape, variant.dropTop, variant.guarded, c, type, rot, x);
                if (ops.drop(c, type, rot, x) !== want)
                  failures.push(`drop ${b}/${type}/${rot}/${x}`);
              }
              for (let x = -3; x <= shape.cols + 1; x += 2) {
                for (let y = -3; y <= shape.rows + 2; y++) {
                  if (isValid(c, type, rot, x, y) !== refIsValid(shape, c, type, rot, x, y)) {
                    failures.push(`valid ${b}/${type}/${rot}/${x}/${y}`);
                  }
                }
              }
            }
          }
          for (let x = -2; x <= shape.cols + 1; x++) {
            for (const mask of [undefined, (1 << 23) - 1]) {
              if (columnHeight(c, x, mask) !== refHeight(shape, c, x, mask))
                failures.push(`height ${b}/${x}`);
            }
          }
        }
        expect(failures.slice(0, 5)).toEqual([]);
      });
    }
  }
});
