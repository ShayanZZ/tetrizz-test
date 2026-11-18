import { describe, expect, it } from "vitest";
import { mulberry32 } from "@tetrizz/core";
import { MAX_PACE_CARRY_MS, paceCarry, paceDeadline } from "@tetrizz/bot";

/** Pieces per second of a bot that drops on the first frame at or after each deadline. */
function simulate(budgetMs: number, frame: (i: number) => number, carryOn: boolean): number {
  let now = 0;
  let deadline = paceDeadline(0, budgetMs, 0);
  let pieces = 0;
  for (let i = 0; now < 60000; i++) {
    now += frame(i);
    if (now >= deadline) {
      pieces++;
      const carry = carryOn ? paceCarry(now, deadline) : 0;
      deadline = paceDeadline(now, budgetMs, carry);
    }
  }
  return pieces / (now / 1000);
}

function jittered(base: number, jitter: number, seed: number): (i: number) => number {
  const rng = mulberry32(seed);
  return () => base + (rng() * 2 - 1) * jitter;
}

describe("bot pacing", () => {
  for (const pps of [3, 5, 8, 10, 11]) {
    const budget = Math.max(90, 1000 / pps);
    for (const [name, frame] of [
      ["16 ms frames", () => 16],
      ["60 Hz with jitter", jittered(16.67, 0.6, 5)],
      ["30 fps", jittered(33.3, 1, 6)],
      ["uneven 7 to 50 ms frames", jittered(28, 21, 7)],
    ] as const) {
      it(`keeps ${pps} PPS on ${name}`, () => {
        const rate = simulate(budget, frame, true);
        expect(Math.abs(rate - 1000 / budget)).toBeLessThan((1000 / budget) * 0.01);
      });
    }
  }

  it("drifts below the setting without the carry, which is what the carry fixes", () => {
    const withoutCarry = simulate(100, () => 16, false);
    const withCarry = simulate(100, () => 16, true);
    expect(withoutCarry).toBeLessThan(9.1);
    expect(withCarry).toBeGreaterThan(9.9);
  });

  it("carries only lateness, never earliness", () => {
    expect(paceCarry(90, 100)).toBe(0);
    expect(paceCarry(100, 100)).toBe(0);
    expect(paceCarry(112, 100)).toBe(12);
    expect(paceCarry(Number.NaN, 100)).toBe(0);
  });

  it("limits what one stall can hand on to the next piece", () => {
    expect(paceCarry(1000, 100)).toBe(MAX_PACE_CARRY_MS);
    expect(paceDeadline(1000, 100, MAX_PACE_CARRY_MS)).toBe(1040);
  });
});
