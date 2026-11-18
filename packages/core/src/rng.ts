/** A source of numbers in `[0, 1)`, like `Math.random`. */
export type Rng = () => number;

/** The default source. It reads `Math.random` on every call, so tests that replace it still take effect. */
export const systemRng: Rng = () => Math.random();

/** Small seedable generator: the same seed always gives the same sequence. Online matches share one seed this way. */
export function mulberry32(seed: number): Rng {
  let a = seed;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in `[0, n)`. */
export function randomInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** Fisher-Yates shuffle in place; returns the same array. */
export function shuffleInPlace<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return arr;
}

/** One shuffled bag with every piece type exactly once (types 0 to 6). */
export function newBag(rng: Rng): number[] {
  return shuffleInPlace([0, 1, 2, 3, 4, 5, 6], rng);
}

/** Appends whole bags to `stream` until it holds at least `n` pieces. */
export function fillBagStream(stream: number[], n: number, rng: Rng): void {
  while (stream.length < n) for (const t of newBag(rng)) stream.push(t);
}

/**
 * Column for a new garbage hole, different from `exclude` where possible.
 * Gives up avoiding `exclude` after eight tries, which keeps tiny boards from looping.
 */
export function randomHole(cols: number, exclude: number, rng: Rng): number {
  if (cols <= 1) return 0;
  let h: number;
  let tries = 0;
  do {
    h = (rng() * cols) | 0;
    tries++;
  } while (h === exclude && tries < 8);
  return h;
}

/** A clock in milliseconds. Pass one in wherever timing matters so tests and servers can drive time. */
export interface Clock {
  now(): number;
}

/** A clock that only moves when told to; used by tests and simulations. */
export class ManualClock implements Clock {
  private t: number;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  set(ms: number): void {
    this.t = ms;
  }
}
