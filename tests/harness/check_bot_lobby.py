"""Checks the bot LEVEL and BOT PPS steppers in the versus lobby (real time).
Usage: check_bot_lobby.py <target.html | dist-dir>
Typed values must be stored and survive leaving the screen and reloading, one click must move a
value by exactly one step, and holding + or - must keep repeating."""
import json, sys
from playwright.sync_api import sync_playwright
from lib import Game

SEL = '[data-bot-step][data-slot="1"][data-key="%s"]'


def vis(g, css):
    return g.page.locator(css + ":visible").first


def text(g, key):
    return vis(g, SEL % key + " .val").inner_text().strip()


def stored(g):
    p = json.loads(g.ev("()=>localStorage.getItem('tetris_vsbot')"))["players"][1]
    return p["diff"], p["pps"], p["autoPps"]


def type_value(g, key, value):
    vis(g, SEL % key + " .val").click()
    inp = vis(g, SEL % key + " .val input")
    inp.fill(value)
    inp.press("Enter")
    g.run(150)


def hold(g, key, delta, ms):
    box = vis(g, SEL % key + ' button[data-d="%s"]' % delta).bounding_box()
    g.page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    g.page.mouse.down()
    g.run(ms)
    g.page.mouse.up()
    g.run(150)


def open_lobby(g):
    g.ev("()=>__h.showScreen('vsbot')")
    g.run(300)


def run(pw, target):
    g = Game(pw, target, seed=3, storage={"tetris_bg": "0"}, virtual_clock=False)
    results = []

    def check(name, ok, detail=""):
        results.append(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}", detail)

    g.run(800)
    open_lobby(g)
    vis(g, SEL % "autoPps" + " .tgl").click()
    g.run(150)
    type_value(g, "diff", "7")
    type_value(g, "pps", "6.5")
    check("typed values stay on screen", (text(g, "diff"), text(g, "pps")) == ("7", "6.5"), (text(g, "diff"), text(g, "pps")))
    check("typed values are stored", stored(g)[:2] == (7, 6.5), stored(g))
    g.ev("()=>__h.showScreen('menu-main')")
    g.run(200)
    open_lobby(g)
    check("typed values survive leaving the lobby", (text(g, "diff"), text(g, "pps")) == ("7", "6.5"), (text(g, "diff"), text(g, "pps")))
    g.reload()
    open_lobby(g)
    check("typed values survive a reload", (text(g, "diff"), text(g, "pps")) == ("7", "6.5"), (text(g, "diff"), text(g, "pps")))
    type_value(g, "pps", "99")
    check("an out of range number is refused", stored(g)[1] == 6.5 and vis(g, SEL % "pps" + " .val input").count() == 1)
    vis(g, SEL % "pps" + " .val input").press("Escape")
    g.run(150)
    type_value(g, "pps", "2")
    vis(g, SEL % "pps" + ' button[data-d="0.25"]').click()
    g.run(150)
    check("one click moves one step", stored(g)[1] == 2.25 and text(g, "pps") == "2.25", (stored(g)[1], text(g, "pps")))
    vis(g, SEL % "diff" + ' button[data-d="-1"]').click()
    g.run(150)
    check("one click moves LEVEL by one", stored(g)[0] == 6 and text(g, "diff") == "6", (stored(g)[0], text(g, "diff")))
    hold(g, "pps", "0.25", 1500)
    after = stored(g)[1]
    check("holding + keeps adding", after >= 4.0 and text(g, "pps") == (str(after)), (after, text(g, "pps")))
    hold(g, "pps", "-0.25", 1500)
    check("holding - keeps subtracting", stored(g)[1] <= after - 1.5, stored(g)[1])
    hold(g, "diff", "1", 1500)
    check("holding LEVEL + stops at the maximum", stored(g)[0] == 10 and text(g, "diff") == "10", stored(g)[0])
    errors = g.errors[:3]
    check("no page errors", not errors, errors)
    g.close()
    return all(results)


if __name__ == "__main__":
    with sync_playwright() as pw:
        sys.exit(0 if run(pw, sys.argv[1]) else 1)
