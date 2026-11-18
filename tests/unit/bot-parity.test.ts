import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mulberry32 } from "@tetrizz/core";
import {
  botContext,
  botPlanPureGen,
  botPlanPureWideGen,
  cc2Board,
  setBotContext,
  wBoard,
} from "@tetrizz/bot";

/**
 * Parity with the original v1.2.0 page. The fixture holds generated boards and the plan the old
 * planners returned for each (recorded by tests/harness/record_bot_plans.py); packages/bot must
 * return the same plan for the same board, queue, hold and random numbers.
 */
interface PlanCase {
  cols: number;
  rows: number;
  wide: boolean;
  submode: string;
  board: string[];
  type: number;
  queue: number[];
  hold: number | null;
  holdUsed: boolean;
  holdAge: number;
  b2b: number;
  combo: number;
  diff: number;
  skill: Record<string, number>;
  seed: number;
}

const fixture = JSON.parse(
  readFileSync(new URL("../golden/parity/bot-plans.json", import.meta.url), "utf8"),
) as { cases: PlanCase[]; results: unknown[] };

function runToEnd(gen: Generator<unknown, unknown>): unknown {
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
  }
}

describe("bot planners match the v1.2.0 page", () => {
  it("has recorded cases for both board families", () => {
    expect(fixture.cases.length).toBe(fixture.results.length);
    expect(fixture.cases.some((c) => c.wide)).toBe(true);
    expect(fixture.cases.some((c) => !c.wide)).toBe(true);
  });

  it("returns the recorded plan for every case", () => {
    const mismatches: number[] = [];
    fixture.cases.forEach((c, i) => {
      const board = c.board.map((r) => Array.from(r, (ch) => Number(ch)));
      setBotContext({
        cols: c.cols,
        rows: c.rows,
        submode: c.submode,
        random: mulberry32(c.seed),
      });
      const cfg = {
        c: c.wide ? wBoard(board) : cc2Board(board),
        type: c.type,
        queue: c.queue.slice(),
        hold: c.hold,
        holdUsed: c.holdUsed,
        holdAge: c.holdAge,
        skill: c.skill,
        b2b: c.b2b,
        combo: c.combo,
        diff: c.diff,
      };
      const got = runToEnd(c.wide ? botPlanPureWideGen(cfg) : botPlanPureGen(cfg));
      if (JSON.stringify(got) !== JSON.stringify(fixture.results[i])) mismatches.push(i);
    });
    setBotContext({ cols: 10, rows: 23, submode: "battle", random: () => Math.random() });
    expect(botContext.cols).toBe(10);
    expect(mismatches).toEqual([]);
  });
});
