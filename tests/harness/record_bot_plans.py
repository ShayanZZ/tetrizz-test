"""Records what the original v1.2.0 bot planners return for generated boards.

The unit test tests/unit/bot-parity.test.ts replays the same inputs on packages/bot and expects
identical plans. Run this only when the legacy page or the case generator changes:

    python tests/harness/record_bot_plans.py

It rewrites tests/golden/parity/bot-plans.json. Each case carries the seed that drives the planner's
random choices (evaluation noise and deliberate mistakes), so a replay draws the same numbers.
"""
import json
import pathlib
import random

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "tests" / "golden" / "parity" / "bot-plans.json"
LEGACY = ROOT / "legacy" / "TetriZZ.html"
SEED = 20261111

TEN = {"cols": 10, "rows": 23, "wide": False, "submodes": ["battle", "ultra", "sprint", "endless"], "count": 200}
WIDE = {"cols": 4, "rows": 29, "wide": True, "submodes": ["wide"], "count": 120}

RUN_JS = """
(cases) => cases.map((c) => {
  COLS = c.cols; ROWS = c.rows; vs.submode = c.submode;
  const bd = c.board.map((r) => Array.from(r, (ch) => +ch));
  const cfg = {
    c: c.wide ? wBoard(bd) : cc2Board(bd), type: c.type, queue: c.queue.slice(), hold: c.hold,
    holdUsed: c.holdUsed, holdAge: c.holdAge, skill: c.skill, b2b: c.b2b, combo: c.combo,
    diff: c.diff, stream: [], streamPtr: 0,
  };
  Math.random = mulberry32(c.seed);
  const g = c.wide ? botPlanPureWideGen(cfg) : botPlanPureGen(cfg);
  let r;
  while (!(r = g.next()).done) { /* run to completion */ }
  return r.value;
})
"""


def skill_for(diff):
    """Same numbers as botSkill() in the page: derived from the difficulty level only."""
    clamp = lambda v, lo, hi: max(lo, min(hi, v))
    sk = clamp((diff - 1) / 9, 0, 1)
    return {
        "sk": sk,
        "noise": max(0, (8 - diff) * 0.13),
        "mistake": max(0, (7 - diff) * 0.012),
        "spin": clamp((diff - 1) / 8, 0, 1) if diff >= 2 else 0,
        "pc": clamp((diff - 4) / 5, 0, 1) if diff >= 5 else 0,
        "hold": clamp((diff - 1) / 8, 0, 1) if diff >= 2 else 0,
    }


def make_board(rng, cols, rows):
    """A stack with random height, mixed colours, garbage rows and a few holes; never a full row."""
    heights = [0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 14, 18, 21, 24, 26]
    height = rng.choice([h for h in heights if h <= rows - 3])
    rows_out = []
    for _ in range(rows - height):
        rows_out.append("0" * cols)
    well = rng.randrange(cols)
    for i in range(height):
        garbage = rng.random() < 0.3
        cells = []
        for x in range(cols):
            if garbage:
                cells.append("0" if x == well else "8")
            else:
                cells.append(str(rng.randint(1, 7)) if rng.random() < 0.82 else "0")
        if "0" not in cells:
            cells[rng.randrange(cols)] = "0"
        rows_out.append("".join(cells))
    return rows_out


def make_cases(rng, spec, base_seed):
    out = []
    for i in range(spec["count"]):
        diff = 1 + (i % 10)
        queue = [rng.randrange(7) for _ in range(5)]
        hold_used = rng.random() < 0.2
        out.append({
            "cols": spec["cols"], "rows": spec["rows"], "wide": spec["wide"],
            "submode": spec["submodes"][i % len(spec["submodes"])],
            "board": make_board(rng, spec["cols"], spec["rows"]),
            "type": rng.randrange(7), "queue": queue,
            "hold": None if rng.random() < 0.4 else rng.randrange(7),
            "holdUsed": hold_used, "holdAge": rng.randrange(0, 5),
            "b2b": rng.choice([-1, 0, 0, 1, 2, 4]), "combo": rng.choice([-1, -1, 0, 1, 3, 5]),
            "diff": diff, "skill": skill_for(diff), "seed": base_seed + i,
        })
    return out


def main():
    rng = random.Random(SEED)
    cases = make_cases(rng, TEN, 1000) + make_cases(rng, WIDE, 5000)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.add_init_script("localStorage.setItem('tetris_ipop','9999999999999')")
        page.goto(LEGACY.as_uri())
        page.wait_for_timeout(500)
        results = page.evaluate(RUN_JS, cases)
        browser.close()
    empty = sum(1 for r in results if r and r.get("empty"))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"seed": SEED, "cases": cases, "results": results}, separators=(",", ":")))
    print(f"{len(cases)} cases, {empty} with no move, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
