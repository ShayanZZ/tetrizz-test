"""Pages play rooms on the REAL own server: the built Node process, real sockets, real timers.

Usage: python3 tests/harness/check_server_real.py <dist-dir> [<server-dist>/index.js]   (real time, ~2 min)

The page build must name the server at build time (its Content Security Policy only allows hosts
the build knew about), on the port this check uses (PROXY_PORT):

    TETRIZZ_SERVER_URL=http://127.0.0.1:18790 npm run build -w @tetrizz/web -- --outDir /tmp/dist-real
    npm run build -w @tetrizz/server

Between the pages and the server sits a small TCP proxy (below) that can cut every connection and
refuse new ones, which is how the check drops a player without any hook in the server. The server
is started with a 3 s seat hold and with the static site's origin as its only allowed origin, so
a page from any other origin is refused (group E). Groups, as in check_server_room.py (which runs
the same page against a fake server):

  A. create, join, READY, START MATCH     B. a password room        C. the host leaves
  D. the host kicks the guest             E. a page from an origin the server does not allow
  F. a guest's connection is cut in the lobby and the page gets the same seat back
  G. the host changes and removes the password
  H. a cut host returns as host; after the hold ends the guest is host and the host returns as a guest
  I. the server unreachable past the hold: failure panel, then RETRY
  J. the server's own log and statistics, and a clean stop on SIGTERM
"""
import asyncio, atexit, json, os, pathlib, shutil, signal, subprocess, sys, tempfile, threading, time, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright
from check_relay_handshake import FAKE_MQTT, HOOK, join_room, open_page, serve, to_lobby
from check_server_room import CODE, IN_ROOM, SUBMIT_PROMPT, confirm, in_room_of, squash, wait_for
from lib import GUESTY_ID, HOSTY_ID

PROXY_PORT = 18790
SERVER_PORT = 18791
GRACE_S = 3


def hello_id(frames):
    """The player id inside the first masked WebSocket text frame (the page's `hello`), or None."""
    if len(frames) < 2:
        return None
    n, at = frames[1] & 0x7F, 2
    if n == 126:
        if len(frames) < 4:
            return None
        n, at = int.from_bytes(frames[2:4], "big"), 4
    mask, body = frames[at:at + 4], frames[at + 4:at + 4 + n]
    if len(mask) < 4 or len(body) < n:
        return None
    try:
        return json.loads(bytes(b ^ mask[i % 4] for i, b in enumerate(body)))["id"]
    except Exception:
        return None


class Proxy:
    """Forwards TCP to the server. It reads the player id out of each page's `hello`, so the check can
    cut one player's connections (`sever`) and refuse that player's new ones (`block`) while the rest play on.
    `blocked = True` refuses everyone, as a server that is down would."""

    def __init__(self, target_port):
        self.target, self.blocked, self.blocked_ids, self.statuses, self.pairs = target_port, False, set(), [], []
        self.loop = asyncio.new_event_loop()
        ready = threading.Event()

        def run():
            asyncio.set_event_loop(self.loop)
            self.server = self.loop.run_until_complete(asyncio.start_server(self.handle, "127.0.0.1", PROXY_PORT))
            ready.set()
            self.loop.run_forever()

        threading.Thread(target=run, daemon=True).start()
        ready.wait(5)

    async def handle(self, cr, cw):
        if self.blocked:
            cw.transport.abort()
            return
        try:
            sr, sw = await asyncio.open_connection("127.0.0.1", self.target)
        except OSError:
            cw.transport.abort()
            return
        pair = {"cw": cw, "sw": sw, "id": None}
        self.pairs.append(pair)
        seen = []

        async def up():  # page -> server: the upgrade request goes through at once, later frames wait for the id
            head, held = b"", b""
            try:
                while True:
                    data = await cr.read(65536)
                    if not data:
                        break
                    if pair["id"] is not None:
                        sw.write(data)
                    elif not head.endswith(b"\r\n\r\n") and b"\r\n\r\n" not in head:
                        head += data
                        cut = head.find(b"\r\n\r\n")
                        if cut < 0:
                            sw.write(data)
                            continue
                        sw.write(data[: len(data) - (len(head) - cut - 4)])
                        held = head[cut + 4:]
                    else:
                        held += data
                    if pair["id"] is None and held:
                        pair["id"] = hello_id(held)
                        if pair["id"] is not None:
                            if pair["id"] in self.blocked_ids:
                                break
                            sw.write(held)
                    await sw.drain()
            except Exception:
                pass
            finally:
                cw.transport.abort()
                sw.transport.abort()

        async def down():  # server -> page
            try:
                while True:
                    data = await sr.read(65536)
                    if not data:
                        break
                    if not seen:
                        seen.append(1)
                        self.statuses.append(data.split(b"\r\n", 1)[0].decode("latin1"))
                    cw.write(data)
                    await cw.drain()
            except Exception:
                pass
            finally:
                cw.transport.abort()
                sw.transport.abort()

        await asyncio.gather(up(), down())

    def sever(self, *ids):
        """Cuts the connections of these player ids, or every connection when none are named."""
        def cut():
            for pair in list(self.pairs):
                if not ids or pair["id"] in ids:
                    pair["cw"].transport.abort()
                    pair["sw"].transport.abort()
                    self.pairs.remove(pair)

        self.loop.call_soon_threadsafe(cut)


def healthy(port):
    try:
        return urllib.request.urlopen("http://127.0.0.1:%d/healthz" % port, timeout=1).status == 200
    except Exception:
        return False


def main(dist, server_js):
    work = pathlib.Path(tempfile.mkdtemp())
    root = work / "site"
    shutil.copytree(pathlib.Path(dist).resolve(), root)
    site = serve(root)  # the origin the server allows
    other = serve(root)  # an origin it does not
    url = "http://127.0.0.1:%d/index.html" % site.server_address[1]
    other_url = "http://127.0.0.1:%d/index.html" % other.server_address[1]
    log_path = work / "server.log"
    env = dict(os.environ, PORT=str(SERVER_PORT), HOST="127.0.0.1", LOG_LEVEL="info", STATS_LOG_SECONDS="1",
               SEAT_GRACE_SECONDS=str(GRACE_S), ALLOWED_ORIGINS="http://127.0.0.1:%d" % site.server_address[1],
               CONNECTS_PER_MINUTE_PER_IP="600", MAX_CONNECTIONS_PER_IP="50")
    if healthy(SERVER_PORT):
        print("port %d already answers: stop the other server first" % SERVER_PORT)
        return 2
    server = subprocess.Popen(["node", str(pathlib.Path(server_js).resolve())], env=env, stdout=open(log_path, "w"), stderr=subprocess.STDOUT)
    atexit.register(lambda: server.poll() is None and server.kill())  # also after a crash of this script
    for _ in range(50):
        if healthy(SERVER_PORT):
            break
        time.sleep(0.1)
    proxy = Proxy(SERVER_PORT)
    results = []

    def record(name, ok, detail=""):
        results.append(bool(ok))
        print(("[PASS] " if ok else "[FAIL] ") + name + (" - " + detail if detail else ""))

    errors = lambda *pages: "; ".join(e for pg in pages for e in pg.errors)[:300]
    visible = "(id) => { const b = document.getElementById(id); return !!b && b.offsetParent !== null; }"
    held_dot = "() => !!document.querySelector('#onlinePlayerList [title*=Reconnecting]')"
    pwd_text = "() => (document.getElementById('displayRoomPwd') || {}).textContent || ''"
    guest_is_host = "() => /GUESTY \\(YOU\\)\\s*★ HOST/i.test(document.getElementById('onlinePlayerList').innerText.replace(/\\s+/g, ' '))"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--disable-gpu"])
        ctxs = []

        def fresh():
            ctx = browser.new_context(viewport={"width": 1280, "height": 720})
            ctxs.append(ctx)
            ctx.add_init_script(HOOK + FAKE_MQTT + "try{localStorage.setItem('tetris_ipop','9999999999999');localStorage.setItem('tetris_telemetry','off')}catch(e){}")
            return ctx

        def close_all():
            for c in ctxs:
                c.close()
            ctxs.clear()
            proxy.blocked = False
            proxy.blocked_ids.clear()

        def new_room(name="HOSTY", password=None, page_url=url):
            host = open_page(fresh(), page_url, name)
            to_lobby(host)
            if password:
                host.evaluate("(p) => { document.getElementById('tglOnlinePwd').click(); document.getElementById('onlineRoomPassword').value = p; }", password)
            host.evaluate("() => document.getElementById('btnCreateRoom').click()")
            wait_for(host, "() => /^[A-Z]{6}$/.test(((document.getElementById('displayRoomCode') || {}).textContent || '').trim())", 6000)
            return host, host.evaluate(CODE).strip()

        def guest_joins(code, name="GUESTY"):
            guest = open_page(fresh(), url, name)
            to_lobby(guest)
            join_room(guest, code)
            return guest

        def room_of_two():
            host, code = new_room()
            guest = guest_joins(code)
            wait_for(host, "() => /GUESTY/i.test(document.getElementById('onlinePlayerList').innerText)")
            wait_for(guest, "() => /HOSTY/i.test(document.getElementById('onlinePlayerList').innerText)")
            return host, guest, code

        # A. create, join, ready, start
        host, code = new_room()
        record("A1 the room is made on the real server (the socket was upgraded)", len(code) == 6 and any("101" in s for s in proxy.statuses), "room %s, %s" % (code, proxy.statuses[:1]))
        guest = guest_joins(code)
        wait_for(host, "() => /GUESTY/i.test(document.getElementById('onlinePlayerList').innerText)")
        wait_for(guest, "() => /HOSTY/i.test(document.getElementById('onlinePlayerList').innerText)")
        record("A2 each page lists the other from the server's roster", "GUESTY" in squash(host) and "HOSTY" in squash(guest), squash(host))
        guest.evaluate("() => document.getElementById('btnReady').click()")
        wait_for(host, "() => /READY/.test(document.getElementById('onlinePlayerList').innerText)")
        record("A3 the guest's READY reaches the host through the server", "✓ READY" in squash(host), squash(host))
        host.evaluate("() => document.getElementById('btnStartOnlineGame').click()")
        wait_for(guest, "() => document.body.classList.contains('online-play')", 6000)
        playing = lambda pg: pg.evaluate("() => document.body.classList.contains('online-play')")
        record("A4 START MATCH puts both pages into the match", playing(host) and playing(guest))
        host.wait_for_timeout(3000)
        reconnecting = lambda pg: pg.evaluate(visible, "onlineReconnecting")
        record("A5 three seconds into the match neither page shows a connection problem", not reconnecting(host) and not reconnecting(guest))
        record("A6 no page error", not (host.errors + guest.errors), errors(host, guest))
        close_all()

        # B. password room
        host, code = new_room(password="SECRET")
        guest = guest_joins(code)
        guest.wait_for_selector("#cfPwd", timeout=5000)
        record("B1 a join without a password is answered with a prompt", not in_room_of(guest))
        guest.evaluate(SUBMIT_PROMPT, "WRONG")
        ok = wait_for(guest, "() => /wrong password/i.test((document.getElementById('cfText') || {}).innerText || '')")
        record("B2 a wrong password is refused and said so", ok and not in_room_of(guest))
        guest.evaluate(SUBMIT_PROMPT, "SECRET")
        record("B3 the right password gets in", wait_for(guest, IN_ROOM))
        record("B4 no page error", not (host.errors + guest.errors), errors(host, guest))
        close_all()

        # C. host leaves
        host, guest, code = room_of_two()
        host.evaluate("() => document.getElementById('onlineLeaveBtn').click()")
        confirm(host)
        took = wait_for(guest, guest_is_host, 6000)
        record("C1 the guest becomes host and stays in the room", took and guest.evaluate(IN_ROOM), squash(guest))
        record("C2 the host's page is out of the room, no page error", not host.evaluate(IN_ROOM) and not (host.errors + guest.errors), errors(host, guest))
        close_all()

        # D. kick
        host, guest, code = room_of_two()
        host.wait_for_selector('button[data-kick=GUESTY_ID]', state="attached", timeout=6000)
        host.evaluate("() => document.querySelector('button[data-kick=\"111a296b37f4ee803aed12a70ba15ac3\"]').click()")
        confirm(host)
        wait_for(guest, "() => !(document.getElementById('onlineLobby') || {}).offsetParent", 5000)
        wait_for(host, "() => !/GUESTY/i.test(document.getElementById('onlinePlayerList').innerText)", 5000)
        body = guest.evaluate("() => document.body.innerText").upper()
        record("D1 the kicked guest sees the alert and is out of the room", "KICKED" in body and not guest.evaluate(IN_ROOM), "in room=%s, text=%s" % (guest.evaluate(IN_ROOM), " ".join(body.split())[:160]))
        record("D2 the host's list drops the guest, no page error", "GUESTY" not in squash(host) and not (host.errors + guest.errors), squash(host))
        close_all()

        # E. a page from an origin the server does not allow
        before = len(proxy.statuses)
        host, code = new_room(page_url=other_url)
        host.wait_for_timeout(1500)
        refused = [s for s in proxy.statuses[before:] if "403" in s]
        record("E1 the server answers 403 to a page from another origin", bool(refused), str(proxy.statuses[before:]))
        record("E2 that page still gets a room, on the relay, and has no page error", len(code) == 6 and host.evaluate(IN_ROOM) and not host.errors, "room %s" % code)
        close_all()

        # F. a guest's connection is cut in the lobby
        host, guest, code = room_of_two()
        guest.wait_for_timeout(3500)  # the lobby refuses a second room action within 3 s of the first
        proxy.sever(GUESTY_ID)
        shown = wait_for(guest, "() => { const r = document.getElementById('onlineReconnecting'); return !!r && r.offsetParent !== null; }", 3000)
        back = wait_for(guest, IN_ROOM, 12000) and wait_for(host, "() => !document.querySelector('#onlinePlayerList [title*=Reconnecting]') && /GUESTY/i.test(document.getElementById('onlinePlayerList').innerText)", 8000)
        seats = squash(host).count("GUESTY")
        record("F1 the reconnect panel shows when the connection is cut", shown)
        record("F2 the page is back in the room and the host sees one GUESTY, not away", back and seats == 1, squash(host))
        record("F3 no page error", not (host.errors + guest.errors), errors(host, guest))
        close_all()

        # G. password change and removal
        host, guest, code = room_of_two()
        record("G1 CHANGE PASSWORD shows for the host, not for the guest", host.evaluate(visible, "btnChangePwd") and not guest.evaluate(visible, "btnChangePwd"))
        host.evaluate("() => document.getElementById('btnChangePwd').click()")
        host.wait_for_selector("#cfNewPwd", state="visible", timeout=3000)
        host.evaluate("() => { document.getElementById('cfNewPwd').value = 'NEWPASS'; document.getElementById('cfOk').click(); }")
        wait_for(guest, "() => /•/.test((document.getElementById('displayRoomPwd') || {}).textContent || '')", 4000)
        record("G2 the guest's page learns the room is protected, never the password", "•" in guest.evaluate(pwd_text) and "NEWPASS" not in guest.evaluate("() => document.body.innerText"), guest.evaluate(pwd_text))
        third = guest_joins(code, "THIRDY")
        third.wait_for_selector("#cfPwd", timeout=5000)
        third.evaluate(SUBMIT_PROMPT, "OLDPASS")
        ok = wait_for(third, "() => /wrong password/i.test((document.getElementById('cfText') || {}).innerText || '')")
        record("G3 a new player is asked, and a wrong password is refused", ok and not in_room_of(third))
        third.evaluate(SUBMIT_PROMPT, "NEWPASS")
        record("G4 the new password gets in", wait_for(third, IN_ROOM))
        host.evaluate("() => document.getElementById('btnChangePwd').click()")
        host.wait_for_selector("#cfNewPwd", state="visible", timeout=3000)
        host.evaluate("() => { document.getElementById('cfNewPwd').value = ''; document.getElementById('cfOk').click(); }")
        wait_for(guest, "() => /NONE/.test((document.getElementById('displayRoomPwd') || {}).textContent || '')", 4000)
        fourth = guest_joins(code, "FOURTHY")
        record("G5 once removed the guest's page says NONE and anyone can join", "NONE" in guest.evaluate(pwd_text) and wait_for(fourth, IN_ROOM), guest.evaluate(pwd_text))
        record("G6 no page error", not errors(host, guest, third, fourth), errors(host, guest, third, fourth))
        close_all()

        # H. a cut host: returns as host within the hold; after it, the guest is host
        host, guest, code = room_of_two()
        proxy.blocked_ids.add(HOSTY_ID)  # refuse the first retry so the marker stays up long enough to see
        proxy.sever(HOSTY_ID)
        hold = wait_for(guest, held_dot, 4000)
        proxy.blocked_ids.clear()
        record("H1 the guest sees the host's seat as reconnecting, and the host role stays", hold and "HOSTY ★ HOST" in squash(guest), squash(guest))
        back = wait_for(host, IN_ROOM, 12000) and wait_for(guest, "() => !document.querySelector('#onlinePlayerList [title*=Reconnecting]')", 6000)
        record("H2 the returning host takes the same seat and is still host", back and host.evaluate(visible, "btnStartOnlineGame") and "GUESTY (YOU) ★ HOST" not in squash(guest), squash(guest))
        close_all()

        host, guest, code = room_of_two()
        proxy.blocked_ids.add(HOSTY_ID)
        proxy.sever(HOSTY_ID)
        wait_for(guest, held_dot, 4000)
        took = wait_for(guest, guest_is_host, GRACE_S * 1000 + 4000)
        record("H3 when the real hold timer ends the guest becomes host", took, squash(guest))
        proxy.blocked_ids.clear()
        back = wait_for(host, IN_ROOM, 25000) and wait_for(guest, "() => /HOSTY/i.test(document.getElementById('onlinePlayerList').innerText)", 6000)
        record("H4 the late host comes back as a new seat, not as host", back and not host.evaluate(visible, "btnStartOnlineGame") and squash(guest).count("HOSTY") == 1, squash(host))
        record("H5 no page error", not errors(host, guest), errors(host, guest))
        close_all()

        # I. the server stays unreachable past the hold
        host, guest, code = room_of_two()
        proxy.blocked_ids.add(GUESTY_ID)
        proxy.sever(GUESTY_ID)
        failed = wait_for(guest, "() => /RECONNECT FAILED/.test((document.getElementById('rcTitle') || {}).textContent || '')", 25000)
        record("I1 past the hold plus a margin the failure panel is shown", failed)
        proxy.blocked_ids.clear()
        guest.evaluate("() => document.getElementById('btnRetryReconnect').click()")
        record("I2 RETRY gets the guest back into the room", wait_for(guest, IN_ROOM, 15000))
        record("I3 no page error", not errors(host, guest), errors(host, guest))
        close_all()
        browser.close()

    # J. the server's own record
    time.sleep(1.2)
    server.send_signal(signal.SIGTERM)
    try:
        code_out = server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
        code_out = None
    log = log_path.read_text()
    lines = [json.loads(l) for l in log.splitlines() if l.startswith("{")]
    stats = [l for l in lines if l.get("msg") == "stats"]
    last = stats[-1] if stats else {}
    record("J1 the server stopped cleanly on SIGTERM", code_out == 0 and any(l.get("msg") == "stopping" for l in lines), "exit %s" % code_out)
    record("J2 the log has no request lines and no client address", not any(k in log for k in ("remoteAddress", "reqId", "remotePort")) and not any(l.get("req") for l in lines))
    record("J3 the statistics saw the refused origin, the rooms, and no heartbeat or flood cut", last.get("refused", {}).get("origin", 0) >= 1 and last.get("accepted", 0) >= 10 and last.get("closed", {}).get("heartbeat", 1) == 0 and last.get("closed", {}).get("flood", 1) == 0 and last.get("messagesDropped", 1) == 0, json.dumps(last)[:260])
    if not all(results):
        print("--- server log tail ---\n" + "\n".join(log.splitlines()[-8:])[:1500])
    site.shutdown(); other.shutdown()
    shutil.rmtree(work, ignore_errors=True)
    print("real server: %s" % ("PASS" if all(results) and results else "FAIL"))
    return 0 if all(results) and results else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "apps/server/dist/index.js"))
