import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { mulberry32 } from "@tetrizz/core";
import { botPlanPureGen, botPlanPureWideGen, cc2Board, setBotContext, wBoard } from "@tetrizz/bot";

/**
 * How long the bot planners take on the recorded boards (tests/harness/record_bot_plans.py),
 * split by board family and by the strongest bot level, which searches the most. Run with
 * `npm run bench` (a plain timed test run, since Vitest 5 has no bench mode); compare numbers
 * only between runs on the same machine.
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

const { cases } = JSON.parse(
  readFileSync(new URL("../golden/parity/bot-plans.json", import.meta.url), "utf8"),
) as { cases: PlanCase[] };

function planAll(subset: PlanCase[]): void {
  for (const c of subset) {
    const board = c.board.map((r) => Array.from(r, (ch) => Number(ch)));
    setBotContext({ cols: c.cols, rows: c.rows, submode: c.submode, random: mulberry32(c.seed) });
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
    const gen = c.wide ? botPlanPureWideGen(cfg) : botPlanPureGen(cfg);
    while (!gen.next().done);
  }
}

/** Median milliseconds per plan over several passes of `subset`, after one warm-up pass. */
function msPerPlan(subset: PlanCase[]): number {
  planAll(subset);
  const passes: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    planAll(subset);
    passes.push(performance.now() - t0);
  }
  passes.sort((a, b) => a - b);
  return (passes[3] ?? 0) / subset.length;
}

describe("bot planning", () => {
  const ten = cases.filter((c) => !c.wide);
  const wide = cases.filter((c) => c.wide);
  const top = ten.filter((c) => c.diff === 10);
  const groups: [string, PlanCase[]][] = [
    ["10-wide, all levels", ten],
    ["10-wide, level 10", top],
    ["4-wide, all levels", wide],
  ];
  for (const [name, subset] of groups) {
    it(
      name,
      () => {
        console.log(
          `${name}: ${msPerPlan(subset).toFixed(2)} ms per plan (${subset.length} boards)`,
        );
      },
      120000,
    );
  }
});
