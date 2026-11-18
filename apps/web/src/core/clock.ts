/** Time sources the game reads. Both default to the browser clocks and can be replaced for tests. */
export interface ClockSource {
  /** Monotonic milliseconds, like `performance.now()`. */
  now(): number;
  /** Wall-clock milliseconds since 1970, like `Date.now()`. */
  wall(): number;
}

const browserClock: ClockSource = {
  now: () => performance.now(),
  wall: () => Date.now(),
};

let source: ClockSource = browserClock;

/** The active clock. Read through this object so a replacement takes effect everywhere. */
export const clock: ClockSource = { now: () => source.now(), wall: () => source.wall() };

/** Replaces the clock source. Returns the previous one. */
export function setClock(next: ClockSource): ClockSource {
  const prev = source;
  source = next;
  return prev;
}
