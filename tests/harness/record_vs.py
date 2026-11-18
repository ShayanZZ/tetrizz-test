"""Record a seeded versus-vs-bots match. Usage: record_vs.py <target.html> <out_dir>"""
import json, sys, pathlib
from playwright.sync_api import sync_playwright
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import Game

BOT = {"type": "bot", "dev": "key", "diff": 10, "autoPps": False, "pps": 5}
CFG = {"diff": 10, "pps": 5, "rounds": 1, "submode": "battle", "autoPps": False,
       "players": [{"type": "user", "dev": "key"}, dict(BOT), dict(BOT), dict(BOT)]}
SECONDS, STEP = 40, 2000


def record(pw, target, seed=3):
    g = Game(pw, target, seed=seed, storage={"tetris_bg": "0"})
    g.run(500)
    g.ev("(c)=>__h.startVs(c)", CFG)
    trace = []
    for _ in range(SECONDS * 1000 // STEP):
        g.run(STEP)
        trace.append(g.ev("()=>__h.vsSnap()"))
        if not trace[-1]["active"]:
            break
    out = {"seed": seed, "cfg": CFG, "trace": trace, "errors": g.errors}
    g.close()
    return out


if __name__ == "__main__":
    target, outdir = sys.argv[1], pathlib.Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        res = record(pw, target)
    (outdir / "vs-4p-bots.json").write_text(json.dumps(res))
    last = res["trace"][-1]
    print("vs steps", len(res["trace"]), "stations", len(last["stations"]), "errs", len(res["errors"]), json.dumps(last["stations"])[:260])
