import { describe, expect, it } from "vitest";
import {
  ManualClock,
  PIECES,
  emptyRow,
  fillBagStream,
  mulberry32,
  newBag,
  randomHole,
  randomInt,
  shuffleInPlace,
  spliceRows,
  systemRng,
  tryRotateOn,
  type Board,
} from "@tetrizz/core";
import { gameRandom, fxRandom, setFxRng, setGameRng } from "../../apps/web/src/core/random";
import { clock, setClock } from "../../apps/web/src/core/clock";

const dims = { cols: 10, rows: 23 };
const emptyBoard = (): Board => Array.from({ length: dims.rows }, () => emptyRow(dims.cols));

describe("bags and shuffles", () => {
  it("a bag holds every piece once", () => {
    for (let seed = 1; seed <= 50; seed++) {
      expect([...newBag(mulberry32(seed))].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  it("the same seed gives the same stream and a longer request only appends", () => {
    const a: number[] = [];
    const b: number[] = [];
    fillBagStream(a, 30, mulberry32(9));
    fillBagStream(b, 30, mulberry32(9));
    expect(a).toEqual(b);
    expect(a.length).toBe(35);
    const c = a.slice(0, 14);
    fillBagStream(c, 30, mulberry32(9));
    expect(c.slice(0, 14)).toEqual(a.slice(0, 14));
  });

  it("every consecutive block of seven in a stream is a permutation", () => {
    const s: number[] = [];
    fillBagStream(s, 70, mulberry32(5));
    for (let i = 0; i < s.length; i += 7)
      expect(s.slice(i, i + 7).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("draws one random number per swap, from the end of the list", () => {
    const calls: number[] = [];
    const rng = () => {
      calls.push(calls.length);
      return 0;
    };
    shuffleInPlace([1, 2, 3, 4], rng);
    expect(calls.length).toBe(3);
  });

  it("randomInt stays in range", () => {
    const r = mulberry32(3);
    for (let i = 0; i < 500; i++) {
      const v = randomInt(r, 6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
    }
  });
});

describe("garbage holes", () => {
  it("avoid the previous column when the board is wide enough", () => {
    const r = mulberry32(11);
    for (let i = 0; i < 300; i++) expect(randomHole(10, 4, r)).not.toBe(4);
  });

  it("gives up after eight tries instead of looping", () => {
    expect(randomHole(10, 3, () => 0.35)).toBe(3);
  });

  it("a one-column board always uses column 0", () => {
    expect(randomHole(1, 0, systemRng)).toBe(0);
  });
});

describe("board rows", () => {
  it("spliceRows removes rows and adds empty ones on top", () => {
    const bd = emptyBoard();
    bd[22] = Array(10).fill(1);
    bd[21] = Array(10).fill(2);
    bd[20]![0] = 3;
    spliceRows(bd, dims, [21, 22]);
    expect(bd.length).toBe(dims.rows);
    expect(bd[22]![0]).toBe(3);
    expect(bd[0]!.every((v) => v === 0)).toBe(true);
  });
});

describe("rotation", () => {
  it("the square piece never rotates", () => {
    expect(tryRotateOn(emptyBoard(), dims, { type: 3, rot: 0, x: 4, y: 5 }, 1)).toBeNull();
  });

  it("a clockwise turn on an open board uses the first test and keeps the position", () => {
    const r = tryRotateOn(emptyBoard(), dims, { type: 5, rot: 0, x: 4, y: 5 }, 1);
    expect(r).toMatchObject({ x: 4, y: 5, rot: 1, kick: 0, dir: 1 });
  });

  it("a half turn only tries the unkicked position (kept from v1.2.0)", () => {
    const bd = emptyBoard();
    // Block the half-turn target so that any kick would be needed to turn.
    const target = PIECES[0]!.cells[2]!;
    for (const [cx, cy] of target) bd[5 + cy]![4 + cx] = 8;
    const r = tryRotateOn(bd, dims, { type: 0, rot: 0, x: 4, y: 5 }, 2);
    expect(r).toBeNull();
  });
});

describe("injectable sources", () => {
  it("gameRandom and fxRandom are separate and replaceable", () => {
    const prevGame = setGameRng(() => 0.25);
    const prevFx = setFxRng(() => 0.75);
    try {
      expect(gameRandom()).toBe(0.25);
      expect(fxRandom()).toBe(0.75);
    } finally {
      setGameRng(prevGame);
      setFxRng(prevFx);
    }
  });

  it("the default source follows Math.random", () => {
    const original = Math.random;
    Math.random = () => 0.5;
    try {
      expect(systemRng()).toBe(0.5);
      expect(gameRandom()).toBe(0.5);
    } finally {
      Math.random = original;
    }
  });

  it("a manual clock only moves when told to", () => {
    const m = new ManualClock(100);
    expect(m.now()).toBe(100);
    m.advance(16);
    expect(m.now()).toBe(116);
    m.set(5);
    expect(m.now()).toBe(5);
  });

  it("the app clock can be replaced and restored", () => {
    const prev = setClock({ now: () => 42, wall: () => 4200 });
    try {
      expect(clock.now()).toBe(42);
      expect(clock.wall()).toBe(4200);
    } finally {
      setClock(prev);
    }
    expect(clock.wall()).toBeGreaterThan(1_000_000_000_000);
  });
});
