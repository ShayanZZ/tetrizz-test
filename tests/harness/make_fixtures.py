"""Build data-compatibility fixtures from the v1.2.0 reference build.
Writes tests/fixtures/legacy/{profile-full.json, profile-full.expected.json, replays/*.tzzreplay, replay-sizes.json}."""
import base64, gzip, json, pathlib, sys
from playwright.sync_api import sync_playwright
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import Game, ROOT
from screens import play_pieces
from record_vs import BOT

VS_2P = {"diff": 10, "pps": 5, "rounds": 1, "submode": "battle", "autoPps": False,
         "players": [{"type": "user", "dev": "key"}, dict(BOT)]}

OUT = ROOT / "tests" / "fixtures" / "legacy"
TARGET = str(ROOT / "legacy" / "TetriZZ.html")
CUSTOM = {
    "tetris_theme": "light", "tetris_das": "120", "tetris_arr": "20", "tetris_sdf": "5",
    "tetris_clearfx": "40", "tetris_fx": "30", "tetris_grid": "30", "tetris_ghost": "color",
    "tetris_ghostOpacity": "70", "tetris_vol": "55", "tetris_mouse": "0", "tetris_muted": "1",
    "tetris_mode": "sprint",
}
EXPECT_JS = """()=>{
  const q=(n)=>{showScreen($('ovStart'),n);const s=document.querySelector('.menu-screen.active');return s?s.innerText.replace(/\\s+/g,' ').trim():''};
  return {opts: snapOpts(), mode, scores: q('scores'), replays: q('replays')};
}"""


def save_replay(g):
    g.ev("()=>document.getElementById('saveReplayBtn').click()")
    g.page.wait_for_function("()=>(localStorage.getItem('tetris_replays')||'[]').length>2", timeout=10000)
    n = len(json.loads(g.ev("()=>localStorage.getItem('tetris_replays')")))
    return n


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "replays").mkdir(exist_ok=True)
    with sync_playwright() as pw:
        g = Game(pw, TARGET, seed=21, storage=dict(CUSTOM, tetris_bg="0"))
        g.run(500)
        g.ev("()=>__h.startSolo('sprint')"); g.run(5000)
        play_pieces(g, 130, g.ev("()=>__h.shapes()"))
        g.run(2500)
        if g.ev("()=>state") != "over":
            g.ev("()=>gameOver()"); g.run(2000)
        print('solo end:', g.ev("()=>({st:state,lines,scores:localStorage.getItem('tetris_scores')!==null,btn:!!document.getElementById('saveReplayBtn')})"))
        save_replay(g)
        print('after solo save: replays', len(json.loads(g.ev("()=>localStorage.getItem('tetris_replays')"))))
        g.reload()
        print('after reload: replays', len(json.loads(g.ev("()=>localStorage.getItem('tetris_replays')||'[]'"))), 'scores', g.ev("()=>localStorage.getItem('tetris_scores')!==null"))
        g.ev("(c)=>__h.startVs(c)", VS_2P)
        for _ in range(30):
            g.run(2000)
            if not g.ev("()=>__h.vsSnap().active"):
                break
        g.run(3000)
        has_btn = g.ev("()=>!!document.getElementById('saveReplayBtn')")
        if has_btn:
            save_replay(g)
        profile = g.ev("()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k!=='tetris_ipop').map(k=>[k,localStorage.getItem(k)]))")
        g.close()
    profile["tetris_bg"] = "1"
    (OUT / "profile-full.json").write_text(json.dumps(profile, indent=1, sort_keys=True))

    sizes = []
    for i, e in enumerate(json.loads(profile["tetris_replays"])):
        raw = base64.b64decode(e["data"]) if e.get("gz") else json.dumps(e["data"]).encode()
        name = f"replay-{i}-{(e['meta'].get('modeName') or e['meta'].get('mode') or 'x')}.tzzreplay".replace(" ", "")
        (OUT / "replays" / name).write_bytes(raw)
        txt = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
        sizes.append({"file": name, "durationMs": e.get("dur"), "rounds": e.get("nR"),
                      "gzipBytes": len(raw), "jsonBytes": len(txt), "multi": e["meta"].get("multi")})
    (OUT / "replay-sizes.json").write_text(json.dumps(sizes, indent=1))
    print("profile keys", len(profile), "replays", sizes)


if __name__ == "__main__":
    main()
