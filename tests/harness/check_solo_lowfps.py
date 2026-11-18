"""Checks that a solo game keeps real time when frames are slow (real time, wall clock).
Usage: check_solo_lowfps.py <build.html> [throttles, default 1,4,8]
Starts ultra (a 2:00 countdown in game time), lets it run for 30 s of wall clock with the CPU throttled,
and compares the countdown's drop with the wall time. The countdown shows whole seconds, so the ratio is
good to about +-0.07. Before the stepped loop a frame longer than 50 ms advanced the game by only 50 ms,
so the ratio fell with the frame rate. Exit code 0 = ratio at least 0.85 for every throttle."""
import re, sys, pathlib
from playwright.sync_api import sync_playwright
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import Game

WALL_S = 30
COUNT_FRAMES = "()=>{window.__n=0;const f=()=>{window.__n++;requestAnimationFrame(f)};requestAnimationFrame(f)}"
REMAINING = "()=>document.getElementById('stTime').textContent"


def seconds(text):
    m = re.match(r"(\d+):(\d+)", text or "")
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def measure(pw, target, throttle):
    g = Game(pw, target, seed=3, storage={"tetris_bg": "0"}, cpu_throttle=throttle, virtual_clock=False)
    g.run(500)
    g.ev("()=>__h.startSolo('ultra')")
    g.run(6000)
    g.ev(COUNT_FRAMES)
    first = seconds(g.ev(REMAINING))
    g.run(WALL_S * 1000)
    last = seconds(g.ev(REMAINING))
    frames = g.ev("()=>window.__n")
    errors = g.errors[:2]
    g.close()
    return first, last, frames, errors


def main(target, throttles):
    ok = True
    with sync_playwright() as pw:
        for t in throttles:
            first, last, frames, errors = measure(pw, target, t)
            ratio = (first - last) / WALL_S if first is not None and last is not None else None
            good = ratio is not None and ratio >= 0.85 and not errors
            ok = ok and good
            print("[%s] CPU x%d: %.1f fps, game time per wall second %s, countdown %s -> %s %s" % (
                "PASS" if good else "FAIL", t, frames / WALL_S,
                "%.2f" % ratio if ratio is not None else "?", first, last, errors or ""))
    return 0 if ok else 1


if __name__ == "__main__":
    levels = [int(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 else [1, 4, 8]
    sys.exit(main(sys.argv[1], levels))
