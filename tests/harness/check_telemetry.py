"""Pages talk telemetry to the REAL own server (built Node process, SQLite file, real sockets).

Usage: python3 tests/harness/check_telemetry.py <dist-dir> [<server-dist>/index.js]   (real time, ~2 min)

The page build must name the server at build time (its Content Security Policy only allows hosts
the build knew about), on the port this check uses (SERVER_PORT):

    TETRIZZ_SERVER_URL=http://127.0.0.1:18795 npm run build -w @tetrizz/web -- --outDir /tmp/dist-telemetry
    npm run build -w @tetrizz/server

Unlike the other server checks this one does NOT switch telemetry off in its pages: it is about
what reaches the server's database, and about the page showing nothing of it to the player. Groups:

  A. first start: no dialog is shown, the client starts at once, the server gets the player and an
     app_start event
  B. Options: no privacy rows and no text about usage data anywhere in the screen
  C. a solo game reaches the database
  D. a page whose storage says `tetris_telemetry=off` (what the other harness checks use): it sends
     nothing at all, so the server never hears of it
  E. two pages in one online room: room_create and room_join arrive, and the match is ONE game
     with one row per player
"""
import atexit, json, os, pathlib, shutil, sqlite3, subprocess, sys, tempfile, time, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright
from check_relay_handshake import FAKE_MQTT, HOOK, join_room, open_page, serve, to_lobby
from check_server_room import CODE, confirm, wait_for

SERVER_PORT = 18795
CF_SHOWN = "() => { const m = document.getElementById('cfModal'); return !!m && !m.hidden; }"
CF_TEXT = "() => { const m = document.getElementById('cfModal'); return m && !m.hidden ? document.getElementById('cfText').innerText : ''; }"
PRIVACY_TRACES = "() => document.querySelectorAll('[data-privgrp], [data-telemetry], [data-privacyinfo], [data-erasedata]').length"
PRIVACY_WORDS = "() => /usage data|privacy|erase my data|what is sent/i.test(document.body.innerText)"

def healthy(port):
    try:
        urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=1).read()
        return True
    except Exception:
        return False


class Db:
    def __init__(self, path):
        self.path = path
        # Waiting must go through the browser connection: the pages' requests are served by route
        # handlers that only run while it is being pumped, so a plain sleep stalls the pages.
        self.pump = lambda seconds: time.sleep(seconds)

    def q(self, sql, args=()):
        con = sqlite3.connect("file:%s?mode=ro" % self.path, uri=True, timeout=5)
        try:
            return con.execute(sql, args).fetchall()
        finally:
            con.close()

    def n(self, sql, args=()):
        return self.q(sql, args)[0][0]

    def wait(self, sql, ok, timeout=15.0, args=()):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                last = self.q(sql, args)
                if ok(last):
                    return True, last
            except sqlite3.Error as e:
                last = str(e)
            self.pump(0.4)
        return False, last


def main(dist, server_js):
    work = pathlib.Path(tempfile.mkdtemp(prefix="telemetry-"))
    atexit.register(lambda: shutil.rmtree(work, ignore_errors=True))
    root = work / "site"
    shutil.copytree(pathlib.Path(dist).resolve(), root)
    site = serve(root)
    url = "http://127.0.0.1:%d/index.html" % site.server_address[1]
    db_path = str(work / "t.db")
    env = dict(os.environ, PORT=str(SERVER_PORT), HOST="127.0.0.1", LOG_LEVEL="info", DB_DRIVER="sqlite",
               SQLITE_PATH=db_path, ALLOWED_ORIGINS="http://127.0.0.1:%d" % site.server_address[1],
               CONNECTS_PER_MINUTE_PER_IP="600", MAX_CONNECTIONS_PER_IP="50",
               TELEMETRY_REQUESTS_PER_MINUTE="600", NEW_PLAYERS_PER_HOUR_PER_IP="1000")
    if healthy(SERVER_PORT):
        print("port %d already answers: stop the other server first" % SERVER_PORT)
        return 2
    server = subprocess.Popen(["node", str(pathlib.Path(server_js).resolve())], env=env,
                              stdout=open(work / "server.log", "w"), stderr=subprocess.STDOUT)
    atexit.register(lambda: server.poll() is None and server.kill())
    for _ in range(60):
        if healthy(SERVER_PORT):
            break
        time.sleep(0.1)
    db = Db(db_path)
    results = []

    def record(name, ok, detail=""):
        results.append(bool(ok))
        print("[%s] %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else " - %s" % detail))

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        idle = browser.new_page()
        db.pump = lambda seconds: idle.wait_for_timeout(int(seconds * 1000))
        ctxs = []
        pages = []

        def fresh(off=False):
            ctx = browser.new_context(viewport={"width": 1280, "height": 720})
            ctxs.append(ctx)
            stored = "localStorage.setItem('tetris_ipop','9999999999999')"
            if off:
                stored += ";localStorage.setItem('tetris_telemetry','off')"
            ctx.add_init_script(HOOK + FAKE_MQTT + "try{" + stored + "}catch(e){}")
            return ctx

        def page_of(name, off=False):
            pg = open_page(fresh(off), url, name)
            pg.api = []
            pg.on("request", lambda r: pg.api.append(r.method + " " + r.url) if "/api/v1" in r.url else None)
            pg.resp = []
            pg.on("response", lambda r: pg.resp.append("%s %s -> %s" % (r.request.method, r.url.split("/api/v1")[-1], r.status)) if "/api/v1" in r.url else None)
            pg.failed = []
            pg.on("requestfailed", lambda r: pg.failed.append("%s %s %s" % (r.method, r.url, r.failure)))
            pg.console = []
            pg.on("console", lambda m: pg.console.append(m.text[:160]) if m.type in ("warning", "error") else None)
            pages.append(pg)
            return pg

        def play_solo(pg, drops=3):
            pg.evaluate("() => __h.startSolo('endless')")
            pg.wait_for_timeout(4500)  # the countdown
            for _ in range(drops):
                pg.evaluate("() => __h.act('drop')")
            pg.evaluate("() => __h.gameOver()")

        # A. first start
        a = page_of("NOTEY")
        ok, rows = db.wait("SELECT count(*) FROM players", lambda r: r[0][0] == 1, 20)
        record("A1 the client starts at once: the server has the player", ok, rows)
        ok, rows = db.wait("SELECT count(*) FROM events WHERE kind='app_start'", lambda r: r[0][0] >= 1)
        record("A2 an app_start event arrived", ok, rows)
        record("A3 no dialog was shown", not a.evaluate(CF_SHOWN), a.evaluate(CF_TEXT))
        record("A4 nothing about usage data is on the menu screen", not a.evaluate(PRIVACY_WORDS))
        record("A5 no notice key is stored", a.evaluate("() => localStorage.getItem('tetris_telemetry_notice')") is None)

        # B. options show nothing about it
        a.evaluate("() => __h.showScreen('options')")
        a.wait_for_timeout(300)
        record("B1 Options has no privacy rows", a.evaluate(PRIVACY_TRACES) == 0, a.evaluate(PRIVACY_TRACES))
        record("B2 Options has no text about usage data", not a.evaluate(PRIVACY_WORDS))
        games_before = db.n("SELECT count(*) FROM games")

        # C. a solo game reaches the database
        play_solo(a)
        ok, rows = db.wait("SELECT count(*) FROM games", lambda r: r[0][0] >= games_before + 1, 20)
        record("C1 a solo game reaches the database", ok, rows)
        ok, rows = db.wait("SELECT count(*) FROM events WHERE kind='perf_sample' OR kind='game_start'", lambda r: r[0][0] >= 1)
        record("C2 its events arrived", ok, rows)
        record("C3 no dialog and no page error in A to C", not a.evaluate(CF_SHOWN) and not a.errors, a.errors)
        for c in ctxs:
            c.close()
        ctxs.clear()

        # D. storage says off
        players_before = db.n("SELECT count(*) FROM players")
        games_before = db.n("SELECT count(*) FROM games")
        events_before = db.n("SELECT count(*) FROM events")
        e = page_of("OFFY", off=True)
        e.wait_for_timeout(5000)
        play_solo(e)
        e.wait_for_timeout(7000)
        record("D1 the page made no telemetry request", not e.api, e.api)
        record("D2 the server has no new player, event or game",
               db.n("SELECT count(*) FROM players") == players_before and db.n("SELECT count(*) FROM events") == events_before and db.n("SELECT count(*) FROM games") == games_before,
               "players %s->%s games %s->%s events %s->%s" % (players_before, db.n("SELECT count(*) FROM players"), games_before, db.n("SELECT count(*) FROM games"), events_before, db.n("SELECT count(*) FROM events")))
        record("D3 it still shows no dialog", not e.evaluate(CF_SHOWN))
        for c in ctxs:
            c.close()
        ctxs.clear()
        db_players_before = db.n("SELECT count(*) FROM players")
        games_before = db.n("SELECT count(*) FROM games")
        rows_before = db.n("SELECT count(*) FROM game_players")

        # E. an online room with two pages
        host = page_of("HOSTY")
        guest = page_of("GUESTY")
        to_lobby(host)
        host.evaluate("() => document.getElementById('btnCreateRoom').click()")
        wait_for(host, "() => /^[A-Z]{6}$/.test(((document.getElementById('displayRoomCode') || {}).textContent || '').trim())", 8000)
        code = host.evaluate(CODE).strip()
        to_lobby(guest)
        join_room(guest, code)
        wait_for(host, "() => /GUESTY/i.test(document.getElementById('onlinePlayerList').innerText)")
        if not wait_for(guest, "() => !!document.getElementById('btnReady')", 8000):
            print("guest lobby:", guest.evaluate("() => document.body.innerText.slice(0, 300)"))
        guest.evaluate("() => { const b = document.getElementById('btnReady'); if (b) b.click(); }")
        wait_for(host, "() => /READY/.test(document.getElementById('onlinePlayerList').innerText)")
        host.evaluate("() => document.getElementById('btnStartOnlineGame').click()")
        wait_for(guest, "() => document.body.classList.contains('online-play')", 8000)
        host.wait_for_timeout(3500)  # the countdown
        for _ in range(10):  # hard drops from the keyboard: pieces are placed on both boards
            for pg in (host, guest):
                pg.keyboard.press("Space")
            host.wait_for_timeout(350)
        for pg in (host, guest):
            pg.evaluate("() => { const b = document.querySelector('[data-nav=\"menu\"]'); if (b) b.click(); }")
            try:
                confirm(pg)
            except Exception:
                pass
            pg.wait_for_timeout(800)
        ok, rows = db.wait("SELECT count(*) FROM events WHERE kind='room_create'", lambda r: r[0][0] == 1)
        record("E1 one room_create event arrived", ok, rows)
        ok, rows = db.wait("SELECT payload FROM events WHERE kind='room_create'", lambda r: r and '"server"' in r[0][0])
        record("E2 it names the server backend", ok, rows)
        ok, rows = db.wait("SELECT count(*) FROM events WHERE kind='room_join'", lambda r: r[0][0] == 1)
        record("E3 one room_join event arrived", ok, rows)
        ok, rows = db.wait("SELECT count(*) FROM games", lambda r: r[0][0] >= games_before + 1, 25)
        record("E4 the match reached the database", ok, rows)
        db.wait("SELECT count(*) FROM game_players", lambda r: r[0][0] >= rows_before + 2, 35)  # a batch waits up to 20 s
        db.pump(1)
        games = db.n("SELECT count(*) FROM games") - games_before
        rows = db.n("SELECT count(*) FROM game_players") - rows_before
        record("E5 the match is ONE game with one row per player", games == 1 and rows == 2, "games+%s game_players+%s" % (games, rows))
        record("E6 no page error and no dialog", not (host.errors + guest.errors) and not host.evaluate(CF_SHOWN) and not guest.evaluate(CF_SHOWN), host.errors + guest.errors)
        record("E7 exactly the two pages' players were added", db.n("SELECT count(*) FROM players") - db_players_before == 2)

        if not all(results) or os.environ.get("DEBUG"):
            print("--- debug")
            for pg in pages:
                print("page", pg.url[-20:], pg.resp[:12], pg.errors, "FAILED:", pg.failed[:4], "CONSOLE:", pg.console[:4])
            for t in ("players", "sessions", "events", "games", "game_players"):
                try:
                    print(t, db.q("SELECT * FROM %s LIMIT 8" % t))
                except sqlite3.Error as err:
                    print(t, err)
            print((work / "server.log").read_text()[-1500:])
        browser.close()
    server.terminate()
    try:
        server.wait(timeout=8)
    except Exception:
        server.kill()
    print("telemetry: %s" % ("PASS" if all(results) else "FAIL"))
    return 0 if all(results) else 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    dist = sys.argv[1]
    js = sys.argv[2] if len(sys.argv) > 2 else str(pathlib.Path(__file__).resolve().parents[2] / "apps/server/dist/index.js")
    sys.exit(main(dist, js))
