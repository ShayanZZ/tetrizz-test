"""Checks the debug overlay and adaptive quality (real time, wall clock).
Usage: check_perf_overlay.py <build.html | dist-dir>
- five taps on the version label show the overlay, it survives a reload, five more taps hide it
- a 4-player match on a heavily throttled CPU lowers the quality tier; an unthrottled solo game stays at 0;
  with tetris_adaptive=0 it stays at 0 even when throttled
Exit code 0 = all checks pass. Machine dependent: the throttled run needs frames slower than 26 ms and the solo run faster."""
import re, sys, pathlib
from playwright.sync_api import sync_playwright
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import Game
from perf_baseline import CFG

TAP = "()=>{const e=document.getElementById('appVersion');for(let i=0;i<5;i++)e.click()}"
TEXT = "()=>{const e=document.getElementById('perfOverlay');return e?e.textContent:null}"


def tier_of(text):
    m = re.search(r"quality tier (\d)", text or "")
    return int(m.group(1)) if m else None


def match_tier(pw, target, throttle, storage, seconds, solo=False):
    g = Game(pw, target, seed=3, storage=dict({"tetris_bg": "0", "tetris_debug": "1"}, **storage),
             cpu_throttle=throttle, virtual_clock=False)
    g.run(800)
    if solo:
        g.ev("()=>__h.startSolo('endless')")
    else:
        g.ev("(c)=>__h.startVs(c)", CFG)
    g.run(4000 + seconds * 1000)
    tier = tier_of(g.ev(TEXT))
    errors = g.errors[:2]
    g.close()
    return tier, errors


def main(target):
    ok = True
    def check(name, cond, detail=""):
        nonlocal ok
        print(("[PASS] " if cond else "[FAIL] ") + name + (" " + str(detail) if detail else ""))
        ok = ok and cond
    with sync_playwright() as pw:
        g = Game(pw, target, seed=3, storage={"tetris_bg": "0"}, virtual_clock=False)
        g.run(500)
        check("overlay hidden at start", g.ev(TEXT) is None)
        g.ev(TAP); g.run(700)
        shown = g.ev(TEXT)
        check("five taps show it", shown is not None and "fps" in shown, (shown or "").splitlines()[:1])
        g.reload(); g.run(500)
        check("it stays after a reload", g.ev(TEXT) is not None)
        g.ev(TAP); g.run(300)
        check("five more taps hide it", g.ev(TEXT) is None)
        check("no page errors", not g.errors, g.errors[:2])
        g.close()
        t_full, e1 = match_tier(pw, target, 1, {}, 12, solo=True)
        check("an unthrottled solo game stays at tier 0", t_full == 0, t_full)
        t_slow, e2 = match_tier(pw, target, 6, {}, 30)
        check("throttled match lowers the tier", t_slow is not None and t_slow >= 1, t_slow)
        t_off, e3 = match_tier(pw, target, 6, {"tetris_adaptive": "0"}, 30)
        check("tetris_adaptive=0 keeps tier 0", t_off == 0, t_off)
        check("no page errors in the matches", not (e1 or e2 or e3), (e1 or e2 or e3))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
