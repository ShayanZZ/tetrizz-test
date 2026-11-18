"""Screenshot every screen. Usage: screens.py <target.html> <out_dir> [--only substr] [--variant name]"""
import json, sys, pathlib
from playwright.sync_api import sync_playwright
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import Game
from player import plan

FREEZE_CSS = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}"
WAAPI_FREEZE = "(()=>{const o=Element.prototype.animate;Element.prototype.animate=function(k,opt){const a=o.call(this,k,opt);try{a.finish()}catch(e){try{a.cancel()}catch(_){}}return a}})();"
FREEZE_INIT = WAAPI_FREEZE + "document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=%s;document.head.appendChild(s)})" % json.dumps(FREEZE_CSS)
MENU_SCREENS = ["main", "singleplayer", "modes", "multiplayer", "vsbot", "practice", "options", "controls", "scores", "replays"]
VARIANTS = {
    "desktop-dark": dict(viewport=(1280, 720), theme="dark", mobile=False),
    "desktop-light": dict(viewport=(1280, 720), theme="light", mobile=False),
    "phone-dark": dict(viewport=(390, 844), theme="dark", mobile=True),
    "phone-light": dict(viewport=(390, 844), theme="light", mobile=True),
}
VS_CFG = {"diff": 6, "pps": 3, "rounds": 1, "submode": "battle", "autoPps": False,
          "players": [{"type": "user", "dev": "key"}, {"type": "bot", "dev": "key", "diff": 6, "autoPps": False, "pps": 3}]}


def play_pieces(g, n, shapes):
    for _ in range(n):
        snap = g.ev("()=>__h.snap()")
        if snap["cur"] < 0:
            break
        rot, tx = plan(g.ev("()=>__h.board()"), shapes, snap["cur"])
        for _ in range(rot):
            g.ev("()=>__h.act('rotate',1)"); g.run(40)
        d = tx - g.ev("()=>__h.snap()")["px"]
        for _ in range(abs(d)):
            g.ev("(d)=>__h.act('move',d)", 1 if d > 0 else -1); g.run(30)
        g.ev("()=>__h.act('drop')"); g.run(200)


def shot(g, out, name, log):
    g.page.add_style_tag(content=FREEZE_CSS)
    g.run(200)
    g.page.screenshot(path=str(out / f"{name}.png"))
    log.append(name)


def run_variant(pw, target, outroot, vname, v, only):
    out = outroot / vname
    out.mkdir(parents=True, exist_ok=True)
    storage = {"tetris_theme": v["theme"], "tetris_bg": "0", "tetris_fx": "0", "tetris_clearfx": "0"}
    log, fails = [], []
    g = Game(pw, target, viewport=v["viewport"], mobile=v["mobile"], storage=storage, seed=5, extra_init=FREEZE_INIT)
    g.run(500)

    def attempt(name, fn, reload_after=True):
        if only and only not in name:
            return
        try:
            fn()
            shot(g, out, name, log)
        except Exception as e:  # recorded, never fatal
            fails.append((name, str(e)[:120]))
        if reload_after:
            g.reload()

    for sc in MENU_SCREENS:
        attempt("menu-" + sc, lambda sc=sc: (g.ev("(n)=>__h.showScreen(n)", sc), g.run(300)), reload_after=False)
    g.reload()
    attempt("install-popup", lambda: (g.ev("()=>__h.openInstallPop()"), g.run(300)))
    shapes = None
    for mode in ["endless", "ultra", "sprint", "wide", "practice"]:
        def play(mode=mode):
            nonlocal shapes
            g.ev("(m)=>__h.startSolo(m)", mode); g.run(5000)
            shapes = shapes or g.ev("()=>__h.shapes()")
            play_pieces(g, 6, shapes)
        attempt("play-" + mode, play)
    def paused():
        g.ev("()=>__h.startSolo('sprint')"); g.run(5000); g.ev("()=>__h.togglePause()"); g.run(300)
    attempt("overlay-pause", paused)
    def over():
        g.ev("()=>__h.startSolo('sprint')"); g.run(5000); g.ev("()=>__h.gameOver()"); g.run(1500)
    attempt("overlay-gameover", over)
    def vs():
        g.ev("(c)=>__h.startVs(c)", VS_CFG); g.run(9000)
    attempt("play-versus", vs)
    g.close()
    return log, fails


if __name__ == "__main__":
    target, outroot = sys.argv[1], pathlib.Path(sys.argv[2])
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    only_variant = sys.argv[sys.argv.index("--variant") + 1] if "--variant" in sys.argv else None
    with sync_playwright() as pw:
        for vname, v in VARIANTS.items():
            if only_variant and vname != only_variant:
                continue
            log, fails = run_variant(pw, target, outroot, vname, v, only)
            print(vname, "shots", len(log), "fails", fails[:4])
