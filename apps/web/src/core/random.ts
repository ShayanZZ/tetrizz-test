import { systemRng, type Rng } from "@tetrizz/core";

let gameSource: Rng = systemRng;
let fxSource: Rng = systemRng;

/** Randomness that decides play: piece bags, garbage holes and targets, bot choices, practice shuffles. */
export function gameRandom(): number {
  return gameSource();
}

/** Randomness for looks and identifiers only: particles, floating background, sound noise, short ids. */
export function fxRandom(): number {
  return fxSource();
}

/** Replaces the gameplay source, for example with a seeded generator in tests. Returns the previous one. */
export function setGameRng(next: Rng): Rng {
  const prev = gameSource;
  gameSource = next;
  return prev;
}

/** Replaces the cosmetic source. Returns the previous one. */
export function setFxRng(next: Rng): Rng {
  const prev = fxSource;
  fxSource = next;
  return prev;
}
