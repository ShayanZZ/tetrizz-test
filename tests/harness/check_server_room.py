"""Pages play rooms on the own server, which is a fake hosted by Playwright (`route_web_socket`).

Usage: python3 tests/harness/check_server_room.py <dist-dir>   (real time; the multi-file build)

The build is served with a `config.json` that names a server on its own origin, so the page opens
`ws://127.0.0.1:<port>/ws`. Playwright answers that socket with `FakeServer` below, which follows the
wire protocol of `packages/protocol/src/server.ts` and the room rules of `server-room.ts` (the
reference model). The page runs its own transport, dispatch and lobby code. No network is used; the
in-browser fake MQTT of check_relay_handshake.py stands in for the fallback relay.

  A. create, join, READY, START MATCH, both pages publish match state
  B. a password room: no password and a wrong password are refused, the right one gets in
  C. the host leaves and the guest becomes host
  D. the host kicks the guest
  E. a server that cannot be reached falls back to the relay
  F. the connection drops in the lobby: the page shows the reconnect panel and gets back in
  G. the host changes the room password after the room is made, and removes it
  H. a dropped player's seat is held: a returning host is still host; after the grace period the
     room has moved on and the player comes back as a new seat
  I. the server stays unreachable for a while: the page keeps trying, then shows the failure panel,
     and RETRY gets the seat back
"""
import json, pathlib, shutil, sys, tempfile
from playwright.sync_api import sync_playwright
from check_relay_handshake import FAKE_MQTT, HOOK, create_room, join_room, open_page, serve, to_lobby
from lib import GUESTY_ID, HOSTY_ID, id_from_key, player_key

try:
    # Playwright 1.63.0 for Python reads event["code"] when a page closes a mocked socket, and a page
    # that closes without a code (the game leaving a room) does not send one. Same work, `.get` instead.
    from playwright._impl import _network

    def _close_from_page(self, event):
        if self._on_page_close:
            self._on_page_close(event.get("code"), event.get("reason"))
        else:
            self._channel.send_may_fail("closeServer", None, event)

    _network.WebSocketRoute._channel_close_page = _close_from_page
except (ImportError, AttributeError):
    pass

NAMES = "() => document.getElementById('onlinePlayerList').innerText"
IN_ROOM = "() => { const l = document.getElementById('onlineLobby'); return !!l && l.offsetParent !== null; }"
CODE = "() => (document.getElementById('displayRoomCode') || {}).textContent || ''"
SUBMIT_PROMPT = "(v) => { document.getElementById('cfPwd').value = v; document.getElementById('cfOk').click(); }"


class FakeServer:
    """What the real server must do, as far as these checks need it."""

    def __init__(self):
        self.conns = {}  # player id -> connection
        self.rooms = {}  # code -> room
        self.frames = []  # (player id, message) as the pages sent them
        self.arrivals = 0
        self.grace_s = 30  # what `welcome` announces; the check ends a hold itself with expire_held()
        self.bad_hellos = []  # ids whose hello did not carry their key
        self.down = False  # True: sockets open but nobody answers `hello`

    def handle(self, ws):
        conn = {"ws": ws, "id": "", "room": None, "seat": None, "held": False}
        if self.down:
            return
        ws.on_message(lambda raw: self.on_message(conn, raw))
        ws.on_close(lambda *args: self.dropped(conn))

    def send(self, conn, message):
        try:
            conn["ws"].send(json.dumps(message))
        except Exception:
            pass

    def everyone(self, room, message, but=None):
        for c in list(room["seats"]):
            if c is not but and not c["held"]:
                self.send(c, message)

    def push_roster(self, room):
        ordered = sorted(room["seats"], key=lambda c: 0 if c["id"] == room["host"] else 1)  # stable: arrival order
        self.everyone(room, {"t": "roster", "host": room["host"], "players": [c["seat"] for c in ordered]})

    def seat(self, conn, name, room):
        players = sum(1 for c in room["seats"] if c["seat"]["state"]["role"] == "player")
        self.arrivals += 1
        conn["seat"] = {"id": conn["id"], "username": name.upper(), "state": {"role": "player" if players < 4 else "spec", "joined": self.arrivals}}
        conn["room"] = room
        room["seats"].append(conn)

    def held_seat(self, room, player_id):
        return next((c for c in room["seats"] if c["id"] == player_id and c["held"]), None)

    def take_back(self, conn, name, room, old):
        """The returning player gets the held seat (same place in the roster, away flag cleared)."""
        conn["seat"] = dict(old["seat"], username=name.upper(), state={k: v for k, v in old["seat"]["state"].items() if k != "away"})
        conn["room"] = room
        room["seats"][room["seats"].index(old)] = conn

    def refuse_request(self, conn, m, reason):
        self.send(conn, {"t": "refused", "rid": m.get("rid"), "reason": reason})

    def on_message(self, conn, raw):
        m = json.loads(raw)
        kind = m.get("t")
        if kind == "hello":
            conn["id"] = m["id"]
            self.conns[m["id"]] = conn
        self.frames.append((conn["id"], m))
        if kind == "hello":
            # What the real server does: a page must send the key its id is derived from.
            if id_from_key(str(m.get("key"))) != m["id"]:
                self.bad_hellos.append(m["id"])
                self.send(conn, {"t": "refused", "reason": "identity"})
                return
            self.send(conn, {"t": "welcome", "v": m["v"], "grace": self.grace_s})
            return
        room = conn["room"]
        if kind == "create":
            code = str(m["room"]).upper()
            if code in self.rooms:
                return self.refuse_request(conn, m, "exists")
            if room:
                return self.refuse_request(conn, m, "busy")
            room = {"code": code, "host": conn["id"], "pwd": m.get("password") or "", "seed": 4242, "settings": dict(m["settings"], seed=4242), "seats": []}
            self.rooms[code] = room
            self.seat(conn, m["name"], room)
            self.send(conn, {"t": "created", "rid": m["rid"], "room": code, "host": conn["id"]})
            self.push_roster(room)
        elif kind == "join":
            target = self.rooms.get(str(m["room"]).upper())
            if not target:
                return self.refuse_request(conn, m, "not-found")
            old = self.held_seat(target, conn["id"])
            known = old or any(c["id"] == conn["id"] for c in target["seats"])
            if target["pwd"] and not known and not m.get("password"):
                return self.refuse_request(conn, m, "password")
            if target["pwd"] and not known and m["password"] != target["pwd"]:
                return self.refuse_request(conn, m, "wrong-password")
            if old:
                self.take_back(conn, m["name"], target, old)
            else:
                self.seat(conn, m["name"], target)
            self.send(conn, {"t": "joined", "rid": m["rid"], "room": target["code"], "host": target["host"], "isHost": target["host"] == conn["id"], "seed": target["seed"], "settings": target["settings"]})
            self.push_roster(target)
        elif kind == "leave":
            self.leave(conn)
        elif not room:
            return
        elif kind == "ev":
            self.everyone(room, {"t": "ev", "from": conn["id"], "event": m["event"], "payload": m.get("payload")}, but=conn)
        elif kind == "settings" and room["host"] == conn["id"]:
            if "password" in m:
                room["pwd"] = m["password"] or ""
            room["settings"] = dict(m["settings"], seed=room["seed"])
            self.everyone(room, {"t": "ev", "from": conn["id"], "event": "settings", "payload": room["settings"]}, but=conn)
        elif kind == "state":
            conn["seat"]["state"].update({k: v for k, v in m["state"].items() if k != "away"})
            self.push_roster(room)
        elif kind == "host" and room["host"] == conn["id"] and any(c["id"] == m["newHost"] for c in room["seats"]):
            room["host"] = m["newHost"]
            self.everyone(room, {"t": "host", "host": m["newHost"]})
            self.push_roster(room)
        elif kind == "kick" and room["host"] == conn["id"]:
            victim = next((c for c in room["seats"] if c["id"] == m["target"] and c is not conn), None)
            if victim:
                self.send(victim, {"t": "kicked"})
                victim["room"] = None
                room["seats"].remove(victim)
                self.push_roster(room)

    def dropped(self, conn):
        """The socket ended: the seat is held (marked away) until expire_held() or the player returns."""
        if self.conns.get(conn["id"]) is conn:
            del self.conns[conn["id"]]
        room = conn["room"]
        if not room or conn["held"]:
            return
        conn["held"] = True
        conn["seat"]["state"]["away"] = True
        self.push_roster(room)

    def expire_held(self):
        """The grace period ends for every held seat."""
        for room in list(self.rooms.values()):
            for held in [c for c in room["seats"] if c["held"]]:
                self.remove(held)

    def leave(self, conn):
        self.remove(conn)

    def remove(self, conn):
        room = conn["room"]
        if not room or conn not in room["seats"]:
            return
        conn["room"] = None
        room["seats"].remove(conn)
        if not room["seats"]:
            self.rooms.pop(room["code"], None)
            return
        if room["host"] == conn["id"]:
            present = [c for c in room["seats"] if not c["held"] and c["seat"]["state"]["role"] != "spec"]
            if not present:
                self.everyone(room, {"t": "closed"})
                for c in room["seats"]:
                    c["room"] = None
                self.rooms.pop(room["code"], None)
                return
            room["host"] = present[0]["id"]
            self.everyone(room, {"t": "host", "host": room["host"]})
        self.push_roster(room)

    def sent(self, kind, player=None, **fields):
        return [m for (who, m) in self.frames if m.get("t") == kind and (player is None or who == player) and all(m.get(k) == v for k, v in fields.items())]


def confirm(page):
    page.wait_for_selector("#cfOk", state="visible", timeout=3000)
    page.evaluate("() => document.getElementById('cfOk').click()")


def squash(page):
    return " ".join(page.evaluate(NAMES).upper().split())


def wait_for(page, expr, timeout=8000):
    try:
        page.wait_for_function(expr, timeout=timeout)
        return True
    except Exception:
        return False


def main(dist):
    work = pathlib.Path(tempfile.mkdtemp())
    root = work / "site"
    shutil.copytree(pathlib.Path(dist).resolve(), root)
    (root / "config.json").write_text(json.dumps({"supabase": None, "server": {"url": "/"}}))
    srv = serve(root)
    url = "http://127.0.0.1:%d/index.html" % srv.server_address[1]
    results = []

    def record(name, ok, detail=""):
        results.append(ok)
        print(("[PASS] " if ok else "[FAIL] ") + name + (" - " + detail if detail else ""))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--disable-gpu"])

        ctxs = []

        def fresh(fake):  # fake=None: no server answers, the page's socket meets the static file server
            # One context per page: pages of one context share localStorage, and a page that starts with
            # a saved room tries to rejoin it.
            ctx = browser.new_context(viewport={"width": 1280, "height": 720})
            ctxs.append(ctx)
            ctx.add_init_script(HOOK + FAKE_MQTT + "try{localStorage.setItem('tetris_ipop','9999999999999')}catch(e){}")
            if fake:
                ctx.route_web_socket("**/ws", fake.handle)
            return ctx

        def close_all():
            for c in ctxs:
                c.close()
            ctxs.clear()

        def new_room(fake, host_name="HOSTY", password=None):
            host = open_page(fresh(fake), url, host_name)
            to_lobby(host)
            if password:
                host.evaluate("(p) => { document.getElementById('tglOnlinePwd').click(); document.getElementById('onlineRoomPassword').value = p; }", password)
            host.evaluate("() => document.getElementById('btnCreateRoom').click()")
            wait_for(host, "() => /^[A-Z]{6}$/.test(((document.getElementById('displayRoomCode') || {}).textContent || '').trim())", 6000)
            return host, host.evaluate(CODE).strip()

        def guest_joins(fake, code, name="GUESTY"):
            guest = open_page(fresh(fake), url, name)
            to_lobby(guest)
            join_room(guest, code)
            return guest

        def room_of_two(fake):
            host, code = new_room(fake)
            guest = guest_joins(fake, code)
            wait_for(host, "() => /GUESTY/i.test(document.getElementById('onlinePlayerList').innerText)")
            return host, guest, code

        # A. create, join, ready, start, match state
        fake = FakeServer()
        host, code = new_room(fake)
        record("A1 the host's room is made on the server", bool(fake.sent("create", HOSTY_ID, room=code)) and len(code) == 6, "room %s" % code)
        record("A2 the hello carries the player's id, the key it derives from, and the name", any(m.get("name") == "HOSTY" and m.get("key") == player_key("hosty") for m in fake.sent("hello", HOSTY_ID)))
        record("A2b no page sent a key that does not belong to its id", fake.bad_hellos == [], str(fake.bad_hellos))
        guest = guest_joins(fake, code)
        wait_for(host, "() => /GUESTY/i.test(document.getElementById('onlinePlayerList').innerText)")
        wait_for(guest, "() => /HOSTY/i.test(document.getElementById('onlinePlayerList').innerText)")
        record("A3 each page lists the other from the server's roster", "GUESTY" in squash(host) and "HOSTY" in squash(guest), squash(host))
        guest.evaluate("() => document.getElementById('btnReady').click()")
        wait_for(host, "() => /READY/.test(document.getElementById('onlinePlayerList').innerText)")
        record("A4 the guest's READY reaches the server and the host's list", any(m["state"].get("ready") is True for m in fake.sent("state", GUESTY_ID)) and "✓ READY" in squash(host), squash(host))
        host.evaluate("() => document.getElementById('btnStartOnlineGame').click()")
        playing = lambda pg: pg.evaluate("() => document.body.classList.contains('online-play')")
        wait_for(guest, "() => document.body.classList.contains('online-play')", 6000)
        record("A5 START MATCH puts both pages into the match", playing(host) and playing(guest), "host=%s guest=%s" % (playing(host), playing(guest)))
        host.wait_for_timeout(2500)
        senders = {who for (who, m) in fake.frames if m.get("t") == "ev" and m.get("event") == "state"}
        record("A6 both pages send match state through the server", {HOSTY_ID, GUESTY_ID} <= senders, str(sorted(senders)))
        record("A7 no page error", not (host.errors + guest.errors), "; ".join(host.errors + guest.errors)[:300])
        close_all()

        # B. password room
        fake = FakeServer()
        host, code = new_room(fake, password="SECRET")
        record("B1 the create request carries the typed password", bool(fake.sent("create", HOSTY_ID, password="SECRET")))
        guest = guest_joins(fake, code)
        guest.wait_for_selector("#cfPwd", timeout=5000)
        record("B2 a join without a password is answered with a password prompt", not in_room_of(guest))
        guest.evaluate(SUBMIT_PROMPT, "WRONG")
        ok = wait_for(guest, "() => /wrong password/i.test((document.getElementById('cfText') || {}).innerText || '')")
        record("B3 a wrong password is refused and said so", ok and not in_room_of(guest))
        guest.evaluate(SUBMIT_PROMPT, "SECRET")
        ok = wait_for(guest, IN_ROOM)
        record("B4 the right password gets in", ok and bool(fake.sent("join", GUESTY_ID, password="SECRET")))
        record("B5 no page error", not (host.errors + guest.errors), "; ".join(host.errors + guest.errors)[:300])
        close_all()

        # C. host leaves
        fake = FakeServer()
        host, guest, code = room_of_two(fake)
        host.evaluate("() => document.getElementById('onlineLeaveBtn').click()")
        confirm(host)
        took = wait_for(guest, "() => { const l = document.getElementById('onlinePlayerList'); return !!l && l.offsetParent !== null && /GUESTY \\(YOU\\)\\s*★ HOST/i.test(l.innerText.replace(/\\s+/g, ' ')); }")
        record("C1 the host's leave reaches the server", bool(fake.sent("leave", HOSTY_ID)))
        record("C2 the guest becomes host and stays in the room", took and guest.evaluate(IN_ROOM), squash(guest))
        record("C3 the host's page is out of the room", not host.evaluate(IN_ROOM))
        record("C4 no page error", not (host.errors + guest.errors), "; ".join(host.errors + guest.errors)[:300])
        close_all()

        # D. kick
        fake = FakeServer()
        host, guest, code = room_of_two(fake)
        host.evaluate("() => document.querySelector('button[data-kick=\"111a296b37f4ee803aed12a70ba15ac3\"]').click()")
        confirm(host)
        wait_for(guest, "() => !(document.getElementById('onlineLobby') || {}).offsetParent", 5000)
        wait_for(host, "() => !/GUESTY/i.test(document.getElementById('onlinePlayerList').innerText)", 5000)
        record("D1 the kick request reaches the server", bool(fake.sent("kick", HOSTY_ID, target=GUESTY_ID)))
        record("D2 the kicked guest sees the alert and is out of the room", "KICKED" in guest.evaluate("() => document.body.innerText").upper() and not guest.evaluate(IN_ROOM))
        record("D3 the host's list drops the guest", "GUESTY" not in squash(host), squash(host))
        record("D4 no page error", not (host.errors + guest.errors), "; ".join(host.errors + guest.errors)[:300])
        close_all()

        # E. unreachable server falls back to the relay
        fake = FakeServer()
        host = open_page(fresh(None), url, "HOSTY")
        to_lobby(host)
        code = create_room(host)
        host.wait_for_timeout(1000)
        record("E1 with no server the room is made on the relay", bool(code) and host.evaluate(IN_ROOM) and not fake.frames, "room %s" % code)
        record("E2 no page error", not host.errors, "; ".join(host.errors)[:300])
        close_all()

        # F. the connection drops in the lobby
        fake = FakeServer()
        host, guest, code = room_of_two(fake)
        guest.wait_for_timeout(3500)  # the lobby refuses a second room action within 3 s of the first
        joins_before = len(fake.sent("join", GUESTY_ID))
        fake.conns[GUESTY_ID]["ws"].close()
        shown = wait_for(guest, "() => { const r = document.getElementById('onlineReconnecting'); return !!r && r.offsetParent !== null; }", 3000)
        back = wait_for(guest, IN_ROOM, 12000) and wait_for(host, "() => /GUESTY/i.test(document.getElementById('onlinePlayerList').innerText)", 6000)
        record("F1 the reconnect panel is shown when the socket drops", shown)
        record("F2 the page joins the room again and the host lists it", back and len(fake.sent("join", GUESTY_ID)) == joins_before + 1, squash(host))
        record("F3 no page error", not (host.errors + guest.errors), "; ".join(host.errors + guest.errors)[:300])
        close_all()

        errors = lambda *pages: "; ".join(e for pg in pages for e in pg.errors)[:300]
        visible = "(id) => { const b = document.getElementById(id); return !!b && b.offsetParent !== null; }"
        pwd_text = "() => (document.getElementById('displayRoomPwd') || {}).textContent || ''"
        held_dot = "() => !!document.querySelector('#onlinePlayerList [title*=Reconnecting]')"
        panel_title = "() => { const r = document.getElementById('onlineReconnecting'); return r && r.offsetParent !== null ? document.getElementById('rcTitle').textContent : ''; }"

        # G. the host changes the password after the room is made
        fake = FakeServer()
        host, guest, code = room_of_two(fake)
        record("G1 CHANGE PASSWORD shows for the host of a server room, not for a guest", host.evaluate(visible, "btnChangePwd") and not guest.evaluate(visible, "btnChangePwd"))
        host.evaluate("() => document.getElementById('btnChangePwd').click()")
        host.wait_for_selector("#cfNewPwd", state="visible", timeout=3000)
        host.evaluate("() => { document.getElementById('cfNewPwd').value = 'NEWPASS'; document.getElementById('cfOk').click(); }")
        wait_for(guest, "() => /•/.test((document.getElementById('displayRoomPwd') || {}).textContent || '')", 4000)
        frames = fake.sent("settings", HOSTY_ID, password="NEWPASS")
        record("G2 the new password reaches the server beside the rules, not inside them", bool(frames) and "NEWPASS" not in json.dumps(frames[-1]["settings"]), "%d frame(s)" % len(frames))
        record("G3 the guest's page learns the room is protected, and never the password", "•" in guest.evaluate(pwd_text) and "NEWPASS" not in guest.evaluate("() => document.body.innerText"), guest.evaluate(pwd_text))
        third = guest_joins(fake, code, "THIRDY")
        third.wait_for_selector("#cfPwd", timeout=5000)
        record("G4 a new player is now asked for the password", not in_room_of(third))
        third.evaluate(SUBMIT_PROMPT, "OLDPASS")
        ok = wait_for(third, "() => /wrong password/i.test((document.getElementById('cfText') || {}).innerText || '')")
        record("G5 a wrong password is refused", ok and not in_room_of(third))
        third.evaluate(SUBMIT_PROMPT, "NEWPASS")
        record("G6 the new password gets in", wait_for(third, IN_ROOM))
        host.evaluate("() => document.getElementById('btnChangePwd').click()")
        host.wait_for_selector("#cfNewPwd", state="visible", timeout=3000)
        host.evaluate("() => { document.getElementById('cfNewPwd').value = ''; document.getElementById('cfOk').click(); }")
        wait_for(guest, "() => /NONE/.test((document.getElementById('displayRoomPwd') || {}).textContent || '')", 4000)
        record("G7 an empty password removes it on the server and the guest's page says NONE", fake.rooms[code]["pwd"] == "" and "NONE" in guest.evaluate(pwd_text), guest.evaluate(pwd_text))
        fourth = guest_joins(fake, code, "FOURTHY")
        record("G8 anyone can join once it is removed", wait_for(fourth, IN_ROOM))
        record("G9 no page error", not errors(host, guest, third, fourth), errors(host, guest, third, fourth))
        close_all()

        # H. a dropped player's seat is held
        fake = FakeServer()
        host, guest, code = room_of_two(fake)
        fake.conns[HOSTY_ID]["ws"].close()
        hold = wait_for(guest, held_dot, 4000)
        record("H1 the others see the dropped seat as reconnecting, and the host role stays", hold and "HOSTY ★ HOST" in squash(guest), squash(guest))
        back = wait_for(host, IN_ROOM, 12000)
        seats = fake.rooms[code]["seats"]
        record("H2 the returning host takes the same seat back and is still host", back and fake.rooms[code]["host"] == HOSTY_ID and len(seats) == 2 and not any(c["held"] for c in seats) and host.evaluate(visible, "btnStartOnlineGame"), "seats=%d host=%s" % (len(seats), fake.rooms[code]["host"]))
        wait_for(guest, "() => !document.querySelector('#onlinePlayerList [title*=Reconnecting]')", 4000)
        record("H3 the guest's list shows no one away and the guest was never made host", not guest.evaluate(held_dot) and "GUESTY (YOU) ★ HOST" not in squash(guest), squash(guest))
        record("H4 no page error", not errors(host, guest), errors(host, guest))
        close_all()

        fake = FakeServer()
        host, guest, code = room_of_two(fake)
        fake.down = True
        fake.conns[HOSTY_ID]["ws"].close()
        wait_for(guest, held_dot, 4000)
        fake.expire_held()
        took = wait_for(guest, "() => /GUESTY \\(YOU\\)\\s*★ HOST/i.test(document.getElementById('onlinePlayerList').innerText.replace(/\\s+/g, ' '))", 4000)
        record("H5 when the grace period ends the guest becomes host", took and fake.rooms[code]["host"] == GUESTY_ID, squash(guest))
        fake.down = False
        back = wait_for(host, IN_ROOM, 25000) and wait_for(guest, "() => /HOSTY/i.test(document.getElementById('onlinePlayerList').innerText)", 6000)
        record("H6 the late player comes back as a new seat, not as host", back and fake.rooms[code]["host"] == GUESTY_ID and len(fake.rooms[code]["seats"]) == 2 and not host.evaluate(visible, "btnStartOnlineGame"), squash(host))
        record("H7 no page error", not errors(host, guest), errors(host, guest))
        close_all()

        # I. the server stays unreachable for a while
        fake = FakeServer()
        host, guest, code = room_of_two(fake)
        fake.down = True
        fake.conns[GUESTY_ID]["ws"].close()
        guest.wait_for_timeout(14000)
        title = guest.evaluate(panel_title)
        record("I1 after 14 s the page is still trying (the 12 s watchdog has not given up)", "RECONNECTING" in title, title)
        fake.down = False
        back = wait_for(guest, IN_ROOM, 20000)
        seats = fake.rooms[code]["seats"]
        record("I2 once the server answers the page has its seat back", back and len(seats) == 2 and not any(c["held"] for c in seats), "seats=%d" % len(seats))
        record("I3 no page error", not errors(host, guest), errors(host, guest))
        close_all()

        fake = FakeServer()
        fake.grace_s = 2
        host, guest, code = room_of_two(fake)
        fake.down = True
        fake.conns[GUESTY_ID]["ws"].close()
        failed = wait_for(guest, "() => /RECONNECT FAILED/.test((document.getElementById('rcTitle') || {}).textContent || '')", 25000)
        record("I4 past the grace period plus a margin the failure panel is shown", failed)
        fake.down = False
        guest.evaluate("() => document.getElementById('btnRetryReconnect').click()")
        back = wait_for(guest, IN_ROOM, 15000)
        record("I5 RETRY gets the seat back", back and len(fake.rooms[code]["seats"]) == 2, "seats=%d" % len(fake.rooms[code]["seats"]))
        record("I6 no page error", not errors(host, guest), errors(host, guest))
        close_all()
        browser.close()
    srv.shutdown()
    shutil.rmtree(work, ignore_errors=True)
    print("server room: %s" % ("PASS" if all(results) and results else "FAIL"))
    return 0 if all(results) and results else 1


def in_room_of(page):
    return page.evaluate(IN_ROOM)


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).parent))
    sys.exit(main(sys.argv[1]))
