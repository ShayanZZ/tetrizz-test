"""Real-time performance baseline (wall clock, CPU throttled).
Usage: perf_baseline.py <target.html | dist-dir> <out.json> [thread|worker|both] [throttles, e.g. 1,4]
Measures frame pacing, the PPS the bots reach per game second, and how much game time passes per real
second (1.0 = real time) in a 4-player match. Machine-dependent: compare numbers only between runs on
the same machine; the throttle factor emulates a slow phone. `thread` plans bot moves on the page
thread (the only mode before Phase 6), `worker` in web workers."""
import json, sys, pathlib
from playwright.sync_api import sync_playwright
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import Game

BOT = {"type": "bot", "dev": "key", "diff": 10, "autoPps": False, "pps": 8}
CFG = {"diff": 10, "pps": 8, "rounds": 1, "submode": "battle", "autoPps": False,
       "players": [{"type": "user", "dev": "key"}, dict(BOT), dict(BOT), dict(BOT)]}
FRAME_PROBE = """()=>{window.__f=[];let l=performance.now();const t=(n)=>{window.__f.push(n-l);l=n;requestAnimationFrame(t)};requestAnimationFrame(t)}"""
SECONDS = 15


def measure(pw, target, throttle, bot_worker):
    storage = {"tetris_bg": "0", "tetris_botworker": "auto" if bot_worker else "0"}
    g = Game(pw, target, seed=3, storage=storage, cpu_throttle=throttle, virtual_clock=False)
    g.run(800)
    g.ev("(c)=>__h.startVs(c)", CFG)
    g.run(4000)  # countdown
    g.ev(FRAME_PROBE)
    s0 = g.ev("()=>__h.vsSnap()")
    g.run(SECONDS * 1000)
    s1 = g.ev("()=>__h.vsSnap()")
    f = sorted(g.ev("()=>window.__f.slice(2)"))
    dt = (s1["stations"][1]["timeMs"] - s0["stations"][1]["timeMs"]) / 1000
    bots = [(b["pieces"] - a["pieces"]) / max(dt, 0.001) for a, b in zip(s0["stations"][1:], s1["stations"][1:])]
    out = {"botWorker": bot_worker, "cpuThrottle": throttle, "gameTimePerRealSecond": round(dt / SECONDS, 2), "frames": len(f), "frameMsMedian": round(f[len(f) // 2], 1),
           "frameMsP95": round(f[int(len(f) * .95)], 1), "frameMsMax": round(f[-1], 1),
           "botPpsTarget": 8, "botPpsReached": [round(x, 2) for x in bots], "errors": g.errors[:2]}
    g.close()
    return out


if __name__ == "__main__":
    modes = {"thread": [False], "worker": [True], "both": [False, True]}[sys.argv[3] if len(sys.argv) > 3 else "thread"]
    throttles = [int(x) for x in (sys.argv[4] if len(sys.argv) > 4 else "1,4").split(",")]
    with sync_playwright() as pw:
        res = {"target": sys.argv[1], "runs": [measure(pw, sys.argv[1], t, w) for w in modes for t in throttles]}
    pathlib.Path(sys.argv[2]).write_text(json.dumps(res, indent=1))
    print(json.dumps(res["runs"]))
