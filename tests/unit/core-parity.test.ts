import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMBO_ATK,
  PIECES,
  blitzGravMsForLevel,
  blitzLevelForLines,
  calcAttack,
  calcLockScore,
  collideOn,
  detectSpinOn,
  findFullRows,
  mulberry32,
  pcAfterClear,
  speedFor,
  tryRotateOn,
  type Board,
  type RotateKind,
  type SpinResult,
} from "@tetrizz/core";

/**
 * Parity with the original v1.2.0 page. The fixture holds the inputs and what the old code
 * returned for them (recorded by tests/harness/record_parity.py); packages/core must agree
 * on every case.
 */

interface Dim {
  cols: number;
  rows: number;
  board: string[];
}
interface CollideCase extends Dim {
  probes: [number, number, number, number][];
  clear: number[];
}
interface PieceCase extends Dim {
  type: number;
  rot: number;
  x: number;
  y: number;
}
interface Fixture {
  cases: {
    collide: CollideCase[];
    spin: (PieceCase & { lk: [number, number] | null })[];
    rotate: (PieceCase & { kind: RotateKind })[];
    lock: [number, SpinResult, number, number, number, boolean][];
    attack: [number, SpinResult, boolean, number, number][];
    seeds: number[];
  };
  expected: {
    collide: { hits: boolean[]; full: number[]; pc: boolean }[];
    spin: SpinResult[];
    rotate: ({ x: number; y: number; rot: number; kick: number; dir: number } | null)[];
    lock: unknown[];
    attack: number[];
    tables: { speed: number[]; blitzLevel: number[]; blitzGrav: number[]; comboAtk: number[] };
    rng: number[][];
  };
}

const fx = JSON.parse(
  readFileSync(new URL("../golden/parity/core-parity.json", import.meta.url), "utf8"),
) as Fixture;

const decode = (rows: string[]): Board => rows.map((r) => Array.from(r, (ch) => Number(ch)));

describe("parity with v1.2.0", () => {
  it("fixture is not empty", () => {
    expect(fx.cases.collide.length).toBeGreaterThan(100);
    expect(fx.cases.spin.length).toBeGreaterThan(100);
    expect(fx.cases.rotate.length).toBeGreaterThan(100);
  });

  it("collision, full rows and perfect clears", () => {
    fx.cases.collide.forEach((c, i) => {
      const bd = decode(c.board);
      const dims = { cols: c.cols, rows: c.rows };
      const want = fx.expected.collide[i]!;
      const got = c.probes.map(([t, rot, x, y]) =>
        collideOn(bd, dims, PIECES[t]!.cells[rot]!, x, y),
      );
      expect(got).toEqual(want.hits);
      expect(findFullRows(bd, dims)).toEqual(want.full);
      expect(pcAfterClear(bd, dims, c.clear)).toBe(want.pc);
    });
  });

  it("spin detection", () => {
    fx.cases.spin.forEach((c, i) => {
      const p = {
        type: c.type,
        rot: c.rot,
        x: c.x,
        y: c.y,
        lastRotate: c.lk ? { kick: c.lk[0], dir: c.lk[1] } : null,
      };
      expect(detectSpinOn(decode(c.board), { cols: c.cols, rows: c.rows }, p)).toEqual(
        fx.expected.spin[i],
      );
    });
  });

  it("rotation and kicks", () => {
    let moved = 0;
    fx.cases.rotate.forEach((c, i) => {
      const p = { type: c.type, rot: c.rot, x: c.x, y: c.y };
      const r = tryRotateOn(decode(c.board), { cols: c.cols, rows: c.rows }, p, c.kind);
      const got = r && { x: r.x, y: r.y, rot: r.rot, kick: r.kick, dir: r.dir };
      expect(got).toEqual(fx.expected.rotate[i]);
      if (got) moved++;
    });
    expect(moved).toBeGreaterThan(100);
  });

  it("lock scores and attacks", () => {
    fx.cases.lock.forEach((a, i) => {
      expect(calcLockScore(a[0], a[1], a[2], a[3], a[4], a[5])).toEqual(fx.expected.lock[i]);
    });
    fx.cases.attack.forEach((a, i) => {
      expect(calcAttack(a[0], a[1], a[2], a[3], a[4])).toBe(fx.expected.attack[i]);
    });
    expect([...COMBO_ATK]).toEqual(fx.expected.tables.comboAtk);
  });

  it("level and gravity tables", () => {
    fx.expected.tables.speed.forEach((v, i) => expect(speedFor(i + 1)).toBe(v));
    fx.expected.tables.blitzLevel.forEach((v, i) => expect(blitzLevelForLines(i)).toBe(v));
    fx.expected.tables.blitzGrav.forEach((v, i) => expect(blitzGravMsForLevel(i)).toBe(v));
  });

  it("seeded generator", () => {
    fx.cases.seeds.forEach((s, i) => {
      const r = mulberry32(s);
      expect(fx.expected.rng[i]!.map(() => r())).toEqual(fx.expected.rng[i]);
    });
  });
});
