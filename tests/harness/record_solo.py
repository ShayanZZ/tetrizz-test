"""Record a seeded, scripted solo session per mode. Usage: record_solo.py <target.html> <out_dir> [modes...]"""
import json, sys, pathlib
from playwright.sync_api import sync_playwright
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import Game
from player import plan

MODES = ["endless", "ultra", "sprint", "wide"]
PIECES = 160


def prng(seed):
    s = [seed & 0xFFFFFFFF]
    def nxt():
        s[0] = (s[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return s[0] / 4294967296
    return nxt


def session(pw, target, mode, seed):
    g = Game(pw, target, seed=seed, storage={"tetris_bg": "0"})
    g.run(500)
    g.ev("(m)=>__h.startSolo(m)", mode)
    g.run(5000)
    r = prng(seed * 7919 + len(mode))
    shapes = g.ev("()=>__h.shapes()")
    trace = [g.ev("()=>__h.snap()")]
    for _ in range(PIECES):
        if r() < 0.10:
            g.ev("()=>__h.act('hold')"); g.run(40)
        snap = g.ev("()=>__h.snap()")
        if snap["cur"] >= 0:
            rot, tx = plan(g.ev("()=>__h.board()"), shapes, snap["cur"])
            for _ in range(rot):
                g.ev("()=>__h.act('rotate',1)"); g.run(40)
            snap = g.ev("()=>__h.snap()")
            d = tx - snap["px"]
            for _ in range(abs(d)):
                g.ev("(d)=>__h.act('move',d)", 1 if d > 0 else -1); g.run(30)
            if r() < 0.3:
                g.ev("()=>__h.act('soft')"); g.run(30)
        g.ev("()=>__h.act('drop')"); g.run(200)
        trace.append(g.ev("()=>__h.snap()"))
        if trace[-1]["state"] != "playing":
            break
    out = {"mode": mode, "seed": seed, "trace": trace, "finalBoard": g.ev("()=>__h.board()"), "errors": g.errors}
    g.close()
    return out


if __name__ == "__main__":
    target, outdir = sys.argv[1], pathlib.Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    modes = sys.argv[3:] or MODES
    with sync_playwright() as pw:
        for m in modes:
            res = session(pw, target, m, seed=11)
            (outdir / f"solo-{m}.json").write_text(json.dumps(res))
            last = res["trace"][-1]
            print(m, "steps", len(res["trace"]) - 1, "state", last["state"], "score", last["score"], "lines", last["lines"], "errs", len(res["errors"]))
