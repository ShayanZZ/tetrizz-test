"""Smoke test for the paths the recorded traces do not cover (real time, real input events).
Usage: check_ui_smoke.py <build.html | legacy/TetriZZ.html>
- real keyboard events: move, rotate, hold and hard drop change the game as expected
- real touch taps on the on-screen buttons (phone viewport): hold and drop
- practice: the screen opens, START begins a game that accepts a hard drop, BOARD LIBRARY opens and closes
- replays: a saved replay (from the legacy fixture profile) plays and its picture changes
- no uncaught page error and no console error anywhere in the run (failed network requests excluded)
It runs the same way on the v1.2.0 page and on the new builds, so a failure can be compared.
Exit code 0 = all checks pass."""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import Game, ROOT

PROFILE = json.loads((ROOT / "tests/fixtures/legacy/profile-full.json").read_text())
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("[PASS] " if ok else "[FAIL] ") + name + (" - " + str(detail) if detail else ""))


def watch(g):
    g.console_errors = []

    def on_console(msg):
        text = msg.text
        if msg.type == "error" and "Failed to load resource" not in text and "net::ERR" not in text:
            g.console_errors.append(text)

    g.page.on("console", on_console)


def snap(g):
    return g.ev("()=>__h.snap()")


def wait_playing(g, seconds=9):
    for _ in range(seconds * 4):
        if snap(g)["state"] == "playing":
            return True
        g.run(250)
    return False


def keyboard_checks(pw, target):
    g = Game(pw, target, virtual_clock=False, storage=PROFILE, seed=5)
    watch(g)
    g.run(600)
    g.ev("()=>__h.startSolo('endless')")
    playing = wait_playing(g)
    check("keyboard: endless game starts", playing)
    if playing:
        g.page.bring_to_front()
        before = snap(g)
        g.page.keyboard.press("ArrowLeft")
        g.page.keyboard.press("ArrowLeft")
        g.run(120)
        moved = snap(g)
        check("keyboard: ArrowLeft moves the piece left", moved["px"] < before["px"], "%s -> %s" % (before["px"], moved["px"]))
        g.page.keyboard.press("ArrowUp")
        g.run(120)
        check("keyboard: ArrowUp rotates", snap(g)["rot"] != moved["rot"], "%s -> %s" % (moved["rot"], snap(g)["rot"]))
        s = snap(g)
        g.page.keyboard.press("KeyC")
        g.run(120)
        after = snap(g)
        check("keyboard: C holds the piece", after["hold"] is not None and after["hold"] != s["hold"], "hold=%s" % after["hold"])
        n = snap(g)["pieces"]
        g.page.keyboard.press("Space")
        g.run(200)
        check("keyboard: Space hard-drops and spawns the next piece", snap(g)["pieces"] == n + 1, "%s -> %s" % (n, snap(g)["pieces"]))
        g.page.keyboard.down("ArrowDown")
        g.run(400)
        g.page.keyboard.up("ArrowDown")
        check("keyboard: holding ArrowDown does not break the game", snap(g)["state"] == "playing")
        g.page.keyboard.press("KeyP")
        g.run(200)
        paused = snap(g)["state"]
        check("keyboard: P pauses", paused != "playing", paused)
    check("keyboard run: no page or console error", not g.errors and not g.console_errors, (g.errors + g.console_errors)[:3])
    g.close()


def touch_checks(pw, target):
    g = Game(pw, target, virtual_clock=False, storage=PROFILE, seed=6, viewport=(390, 844), mobile=True)
    watch(g)
    g.run(600)
    g.ev("()=>__h.startSolo('endless')")
    playing = wait_playing(g)
    check("touch: endless game starts on a phone viewport", playing)
    if playing:
        def tap(action):
            box = g.page.locator('.tbtn[data-a="%s"]' % action).first.bounding_box()
            if not box:
                return False
            g.page.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            return True

        before = snap(g)
        ok = tap("left")
        g.run(200)
        check("touch: LEFT button moves the piece", ok and snap(g)["px"] < before["px"], "%s -> %s" % (before["px"], snap(g)["px"]))
        ok = tap("hold")
        g.run(200)
        check("touch: HOLD button holds", ok and snap(g)["hold"] is not None, "hold=%s" % snap(g)["hold"])
        n = snap(g)["pieces"]
        ok = tap("hard")
        g.run(250)
        check("touch: DROP button hard-drops", ok and snap(g)["pieces"] == n + 1, "%s -> %s" % (n, snap(g)["pieces"]))
    check("touch run: no page or console error", not g.errors and not g.console_errors, (g.errors + g.console_errors)[:3])
    g.close()


def practice_checks(pw, target):
    g = Game(pw, target, virtual_clock=False, storage=PROFILE, seed=7)
    watch(g)
    g.run(600)
    g.ev("()=>__h.showScreen('practice')")
    g.run(500)
    has_lib = g.ev("()=>!!document.getElementById('capOpenBtn')")
    check("practice: screen opens with BOARD LIBRARY", has_lib)
    g.ev("()=>document.getElementById('capOpenBtn').click()")
    g.run(700)
    lib_text = g.ev("()=>document.body.innerText").upper()
    check("practice: board library opens", "BOARD" in lib_text and "FUMEN" in lib_text, "text mentions FUMEN=%s" % ("FUMEN" in lib_text))
    g.page.keyboard.press("Escape")
    g.run(500)
    g.ev("()=>__h.showScreen('practice')")
    g.run(400)
    g.ev("()=>[...document.querySelectorAll('.menu-screen.active button')].find(b=>b.textContent.trim()==='START').click()")
    playing = wait_playing(g, 10)
    check("practice: START begins a game", playing)
    if playing:
        n = snap(g)["pieces"]
        g.page.keyboard.press("Space")
        g.run(250)
        check("practice: hard drop works", snap(g)["pieces"] >= n + 1, "%s -> %s" % (n, snap(g)["pieces"]))
    check("practice run: no page or console error", not g.errors and not g.console_errors, (g.errors + g.console_errors)[:3])
    g.close()


def replay_checks(pw, target):
    g = Game(pw, target, virtual_clock=False, storage=PROFILE, seed=8)
    watch(g)
    g.run(600)
    g.ev("()=>__h.showScreen('replays')")
    g.run(500)
    started = g.ev("()=>{const b=[...document.querySelectorAll('.menu-screen.active button')].find(b=>b.textContent.trim()==='PLAY'); if(!b) return false; b.click(); return true;}")
    check("replays: a saved replay has a PLAY button", started)
    if started:
        g.run(1500)
        shot_a = g.page.screenshot()
        g.run(2500)
        shot_b = g.page.screenshot()
        check("replays: the replay is playing (picture changes)", shot_a != shot_b)
        shown = g.ev("()=>{const c=document.getElementById('replayControls'); return !!c && getComputedStyle(c).display!=='none';}")
        check("replays: playback controls are shown", shown)
        g.page.keyboard.press("Escape")
        g.run(600)
    check("replay run: no page or console error", not g.errors and not g.console_errors, (g.errors + g.console_errors)[:3])
    g.close()


def main(target):
    with sync_playwright() as pw:
        for part in (keyboard_checks, touch_checks, practice_checks, replay_checks):
            try:
                part(pw, target)
            except Exception as exc:
                check(part.__name__ + " finished", False, repr(exc)[:200])
    print("ui smoke: %s" % ("PASS" if all(results) and results else "FAIL"))
    return 0 if all(results) and results else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
