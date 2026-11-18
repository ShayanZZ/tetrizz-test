"""Checks that bots keep playing when workers are missing, silent or broken.
Usage: check_bot_worker.py <target.html | dist-dir>
Each scenario starts a 4-player match in real time and expects every bot to place pieces and the page
to raise no errors. `workers answer` is the normal worker path; the others must fall back to planning
on the page thread."""
import sys
from playwright.sync_api import sync_playwright
from lib import Game
from perf_baseline import CFG

SCENARIOS = {
    "workers answer": ("auto", ""),
    "no Worker support": ("auto", "window.Worker = undefined;"),
    "workers never answer": ("auto", "window.Worker = class { postMessage() {} terminate() {} };"),
    "workers fail to start": ("auto", "window.Worker = class { constructor() { throw new Error('blocked'); } };"),
    "pool switched off": ("0", ""),
}
SECONDS = 9


def run(pw, target, setting, init):
    g = Game(pw, target, seed=3, storage={"tetris_bg": "0", "tetris_botworker": setting}, virtual_clock=False, extra_init=init)
    g.run(800)
    g.ev("(c)=>__h.startVs(c)", CFG)
    g.run(4000)
    s0 = g.ev("()=>__h.vsSnap()")
    g.run(SECONDS * 1000)
    s1 = g.ev("()=>__h.vsSnap()")
    placed = [b["pieces"] - a["pieces"] for a, b in zip(s0["stations"][1:], s1["stations"][1:])]
    errors = g.errors[:2]
    g.close()
    return placed, errors


if __name__ == "__main__":
    ok = True
    with sync_playwright() as pw:
        for name, (setting, init) in SCENARIOS.items():
            placed, errors = run(pw, sys.argv[1], setting, init)
            good = all(p >= 8 for p in placed) and not errors
            ok &= good
            print(f"[{'PASS' if good else 'FAIL'}] {name}: bot pieces in {SECONDS}s {placed}", errors or "")
    sys.exit(0 if ok else 1)
