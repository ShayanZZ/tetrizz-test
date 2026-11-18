"""Measures the pace bots actually reach against the PPS they were asked for.
Usage: check_bot_pps.py <target.html | dist-dir> [--max-gap 0.04]

Each scenario runs a match on the virtual clock (frames come every 16 ms, as in the other traces)
and counts pieces per second of game time between 4 s and 20 s into the round, per bot. A bot passes
when its pace is within the allowed share below the setting (default 4 %) and not above it by more
than the same share. Garbage-free `endless` matches keep the boards from changing the pace."""
import sys
from playwright.sync_api import sync_playwright
from lib import Game

SCENARIOS = [
    # name, submode, bots, pps
    ("1 bot  3 PPS", "endless", 1, 3),
    ("1 bot  5 PPS", "endless", 1, 5),
    ("1 bot  8 PPS", "endless", 1, 8),
    ("1 bot 10 PPS", "endless", 1, 10),
    ("3 bots 10 PPS", "endless", 3, 10),
    ("1 bot 10 PPS battle", "battle", 1, 10),
]
START_S, END_S = 4, 20


def run(pw, target, submode, bots, pps, seed=3):
    bot = {"type": "bot", "dev": "key", "diff": 10, "autoPps": False, "pps": pps}
    cfg = {"diff": 10, "pps": pps, "rounds": 1, "submode": submode, "autoPps": False,
           "players": [{"type": "user", "dev": "key"}] + [dict(bot) for _ in range(bots)]}
    g = Game(pw, target, seed=seed, storage={"tetris_bg": "0"})
    g.run(500)
    g.ev("(c)=>__h.startVs(c)", cfg)
    marks = {}
    for _ in range(END_S + 8):
        g.run(1000)
        snap = g.ev("()=>__h.vsSnap()")
        for i, st in enumerate(snap["stations"][1:], 1):
            t = st["timeMs"] / 1000
            if t >= START_S and ("a", i) not in marks:
                marks[("a", i)] = (t, st["pieces"])
            if t >= END_S and ("b", i) not in marks:
                marks[("b", i)] = (t, st["pieces"])
        if len([k for k in marks if k[0] == "b"]) == bots:
            break
    errors = g.errors[:2]
    g.close()
    rates = []
    for i in range(1, bots + 1):
        if ("a", i) in marks and ("b", i) in marks:
            (ta, pa), (tb, pb) = marks[("a", i)], marks[("b", i)]
            rates.append((pb - pa) / (tb - ta))
    return rates, errors


if __name__ == "__main__":
    gap = 0.04
    if "--max-gap" in sys.argv:
        gap = float(sys.argv[sys.argv.index("--max-gap") + 1])
    ok = True
    with sync_playwright() as pw:
        for name, submode, bots, pps in SCENARIOS:
            rates, errors = run(pw, sys.argv[1], submode, bots, pps)
            good = len(rates) == bots and not errors and all(abs(r - pps) <= pps * gap for r in rates)
            ok &= good
            shown = ", ".join(f"{r:.2f}" for r in rates)
            print(f"[{'PASS' if good else 'FAIL'}] {name}: asked {pps}, got {shown}", errors or "")
    sys.exit(0 if ok else 1)
