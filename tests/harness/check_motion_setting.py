"""Checks the REDUCE MOTION and ADAPTIVE QUALITY options (real time, wall clock).
Usage: check_motion_setting.py <build.html>
- the REDUCE MOTION button cycles AUTO, ON, OFF and SAVE stores it in tetris_motion; a reload restores it
- the ADAPTIVE QUALITY button toggles and SAVE stores it in tetris_adaptive
- floating background pieces: none when the system asks for reduced motion (AUTO) or the setting is ON,
  and they appear when the setting is OFF even though the system asks for reduced motion
Exit code 0 = all checks pass."""
import sys, pathlib
from playwright.sync_api import sync_playwright
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import Game

CLICK = "(sel)=>document.querySelector(sel).click()"
TEXT = "(sel)=>document.querySelector(sel).textContent"
STORED = "(k)=>localStorage.getItem(k)"
FLOATERS = "()=>document.querySelectorAll('.fpiece').length"
SAVE_OPTIONS = (
    "()=>[...document.querySelectorAll('.sticky-bar')]"
    ".find(b=>b.textContent.includes('Options')).querySelector('.save-btn').click()"
)
OPEN_OPTIONS = "()=>__h.showScreen('options')"


def floaters(pw, target, storage, os_reduce, seconds=9):
    g = Game(pw, target, seed=3, storage=storage, virtual_clock=False)
    g.page.emulate_media(reduced_motion="reduce" if os_reduce else "no-preference")
    g.reload()
    g.run(seconds * 1000)
    n = g.ev(FLOATERS)
    errors = g.errors[:2]
    g.close()
    return n, errors


def main(target):
    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        print(("[PASS] " if cond else "[FAIL] ") + name + (" " + str(detail) if detail else ""))
        ok = ok and cond

    with sync_playwright() as pw:
        g = Game(pw, target, seed=3, storage={"tetris_bg": "0"}, virtual_clock=False)
        g.run(500)
        g.ev(OPEN_OPTIONS)
        g.run(300)
        seen = [g.ev(TEXT, "[data-motion]")]
        for _ in range(3):
            g.ev(CLICK, "[data-motion]")
            seen.append(g.ev(TEXT, "[data-motion]"))
        check("REDUCE MOTION cycles AUTO, ON, OFF, AUTO", seen == ["AUTO", "ON", "OFF", "AUTO"], seen)
        g.ev(CLICK, "[data-motion]")
        check("ADAPTIVE QUALITY starts ON", g.ev(TEXT, "[data-adaptive]") == "ON")
        g.ev(CLICK, "[data-adaptive]")
        check("ADAPTIVE QUALITY toggles OFF", g.ev(TEXT, "[data-adaptive]") == "OFF")
        check("nothing is stored before SAVE", g.ev(STORED, "tetris_motion") is None)
        g.ev(SAVE_OPTIONS)
        g.run(300)
        check("SAVE stores the motion choice", g.ev(STORED, "tetris_motion") == "on", g.ev(STORED, "tetris_motion"))
        check("SAVE stores adaptive off", g.ev(STORED, "tetris_adaptive") == "0", g.ev(STORED, "tetris_adaptive"))
        g.reload()
        g.ev(OPEN_OPTIONS)
        g.run(300)
        check("a reload restores both", (g.ev(TEXT, "[data-motion]"), g.ev(TEXT, "[data-adaptive]")) == ("ON", "OFF"))
        check("no page errors in the options screen", not g.errors, g.errors[:2])
        g.close()

        n_auto, e1 = floaters(pw, target, {}, os_reduce=True)
        check("OS reduced motion + AUTO: no floating pieces", n_auto == 0, n_auto)
        n_on, e2 = floaters(pw, target, {"tetris_motion": "on"}, os_reduce=False)
        check("setting ON without the OS preference: no floating pieces", n_on == 0, n_on)
        n_off, e3 = floaters(pw, target, {"tetris_motion": "off"}, os_reduce=True)
        check("setting OFF overrides the OS preference: pieces appear", n_off > 0, n_off)
        n_plain, e4 = floaters(pw, target, {}, os_reduce=False)
        check("default without the OS preference: pieces appear", n_plain > 0, n_plain)
        errs = e1 or e2 or e3 or e4
        check("no page errors in the floater runs", not errs, errs)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
