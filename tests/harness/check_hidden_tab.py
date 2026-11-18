"""Checks how the match behaves while the tab is hidden and after it is shown again.
Usage: check_hidden_tab.py <target.html | dist-dir> [--seconds 10] [--pps 10] [--bots 1]

The page is told it is hidden (document.hidden and visibilityState are overridden and a
visibilitychange event is sent), which is what starts the page's own background timer. A real
background tab is not needed: only the page's reaction to `document.hidden` is under test.
Runs in real time. For level-10 bots at the asked PPS it prints, for each phase (visible, hidden,
visible again), the game time that passed per real second and the pieces each bot placed per
second of game time. A phase passes when every bot is within 10 % of the PPS it was asked for and
the game clock keeps within 10 % of real time. A solo game is checked last: its clock must also
keep real time while hidden."""
import pathlib, sys
from playwright.sync_api import sync_playwright
from lib import Game
from verify import serve

HIDE = """()=>{
  Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
  Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
  document.dispatchEvent(new Event('visibilitychange'));
}"""
SHOW = """()=>{
  delete document.hidden;
  delete document.visibilityState;
  document.dispatchEvent(new Event('visibilitychange'));
}"""


def phase(g, seconds):
    a = g.ev("()=>__h.vsSnap()")["stations"][1:]
    g.run(int(seconds * 1000))
    b = g.ev("()=>__h.vsSnap()")["stations"][1:]
    game_s = (b[0]["timeMs"] - a[0]["timeMs"]) / 1000
    rates = [(y["pieces"] - x["pieces"]) / max(game_s, 0.001) for x, y in zip(a, b)]
    return {"pieces": [y["pieces"] - x["pieces"] for x, y in zip(a, b)], "gameS": game_s, "pps": min(rates), "ppsMax": max(rates),
            "speed": game_s / seconds, "shown": g.ev("()=>document.getElementById('botPps')?.textContent")}


def solo_clock(pw, target, seconds):
    g = Game(pw, target, seed=3, storage={"tetris_bg": "0"}, virtual_clock=False)
    g.run(800)
    g.ev("()=>__h.startSolo('endless')")
    g.run(5000)
    g.ev(HIDE)
    t0 = g.ev("()=>document.getElementById('stTime').textContent")
    g.run(int(seconds * 1000))
    t1 = g.ev("()=>document.getElementById('stTime').textContent")
    g.close()
    secs = lambda t: int(t.split(":")[0]) * 60 + int(t.split(":")[1])
    return t0, t1, secs(t1) - secs(t0)


def run(pw, target, seconds, pps, bots=1, storage_extra=None):
    cfg = {"diff": 10, "pps": pps, "rounds": 1, "submode": "endless", "autoPps": False,
           "players": [{"type": "user", "dev": "key"}] + [{"type": "bot", "dev": "key", "diff": 10, "autoPps": False, "pps": pps} for _ in range(bots)]}
    storage = {"tetris_bg": "0", "tetris_botworker": "auto"}
    storage.update(storage_extra or {})
    g = Game(pw, target, seed=3, storage=storage, virtual_clock=False)
    g.run(800)
    g.ev("(c)=>__h.startVs(c)", cfg)
    g.run(5000)
    out = {"visible": phase(g, seconds)}
    g.ev(HIDE)
    out["hidden"] = phase(g, seconds)
    g.ev(SHOW)
    g.run(500)
    out["back"] = phase(g, seconds)
    errors = g.errors[:2]
    g.close()
    return out, errors


if __name__ == "__main__":
    seconds, pps, bots = 10, 10, 1
    if "--bots" in sys.argv:
        bots = int(sys.argv[sys.argv.index("--bots") + 1])
    if "--seconds" in sys.argv:
        seconds = float(sys.argv[sys.argv.index("--seconds") + 1])
    if "--pps" in sys.argv:
        pps = float(sys.argv[sys.argv.index("--pps") + 1])
    target = sys.argv[1]
    if pathlib.Path(target).is_dir():
        target = f"http://127.0.0.1:{serve(pathlib.Path(target).resolve()).server_address[1]}/index.html"
    ok = True
    with sync_playwright() as pw:
        res, errors = run(pw, target, seconds, pps, bots)
        solo = solo_clock(pw, target, seconds)
    for name, r in res.items():
        good = abs(r["pps"] - pps) <= 0.1 * pps and abs(r["speed"] - 1) <= 0.1
        ok &= good
        print(f"[{'PASS' if good else 'FAIL'}] {name:8s} bots {r['pps']:.2f}-{r['ppsMax']:.2f} PPS (asked {pps}), game clock {r['speed']:.2f}x real time, pieces {r['pieces']} in {r['gameS']:.1f} game s, panel shows {r['shown']}")
    good = abs(solo[2] - seconds) <= max(1.5, 0.1 * seconds)
    ok &= good
    print(f"[{'PASS' if good else 'FAIL'}] solo     clock {solo[0]} -> {solo[1]} after {seconds:g} s hidden")
    if errors:
        ok = False
        print("page errors:", errors)
    sys.exit(0 if ok else 1)
