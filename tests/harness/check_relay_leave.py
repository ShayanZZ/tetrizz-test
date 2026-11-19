"""Two real pages leave, kick and hand over a relay room through the in-browser fake MQTT broker.

Usage: python3 tests/harness/check_relay_leave.py <dist-dir>   (real time; the multi-file build)

Each scenario starts a fresh browser context, so the rooms do not touch each other. The pages use the
game's own room backend (`net/room-backend.ts`), so this is the check that the relay's leave, drop,
kick and host-transfer paths still do what they did before they moved behind the RoomBackend interface:

  1. a guest leaves: its `left` event is published, the host's list drops it, the guest is back at the
     menu and the host is still host;
  2. the host leaves with a guest in the room: a `left` event and a `host-transfer` message naming the
     guest are published, the room stays open and the guest ends up as its host;
  3. the host leaves alone: `closed` is published and no host-transfer;
  4. the host kicks the guest: a `kick` event naming the guest is published, the host's list drops it,
     and the guest sees the kicked alert and is out of the room.
"""
import json, pathlib, sys
from playwright.sync_api import sync_playwright
from check_relay_handshake import FAKE_MQTT, HOOK, create_room, join_room, open_page, serve, to_lobby
from lib import GUESTY_ID, HOSTY_ID

NAMES = "() => document.getElementById('onlinePlayerList').innerText"


def published(page):
    out = []
    for p in page.evaluate("() => window.__published || []"):
        try:
            out.append(json.loads(p["text"]))
        except ValueError:
            pass
    return out


def events(page, name):
    return [m for m in published(page) if m.get("t") == "ev" and m.get("event") == name]


def confirm(page):
    page.wait_for_selector("#cfOk", state="visible", timeout=3000)
    page.evaluate("() => document.getElementById('cfOk').click()")


def room_of_two(browser, url):
    ctx = browser.new_context(viewport={"width": 1280, "height": 720})
    ctx.add_init_script(HOOK + FAKE_MQTT + "try{localStorage.setItem('tetris_ipop','9999999999999')}catch(e){}")
    host = open_page(ctx, url, "HOSTY")
    to_lobby(host)
    code = create_room(host)
    guest = open_page(ctx, url, "GUESTY")
    to_lobby(guest)
    join_room(guest, code or "")
    guest.wait_for_timeout(2500)
    return ctx, host, guest


def in_room(page):
    return page.evaluate("() => !!document.getElementById('onlinePlayerList') && document.getElementById('onlinePlayerList').offsetParent !== null")


def main(dist):
    srv = serve(pathlib.Path(dist).resolve())
    url = "http://127.0.0.1:%d/index.html" % srv.server_address[1]
    results = []

    def record(name, ok, detail=""):
        results.append(ok)
        print(("[PASS] " if ok else "[FAIL] ") + name + (" - " + detail if detail else ""))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--disable-gpu"])

        ctx, host, guest = room_of_two(browser, url)
        record("setup: both pages see two players", "GUESTY" in host.evaluate(NAMES).upper() and "HOSTY" in guest.evaluate(NAMES).upper())
        guest.evaluate("() => document.getElementById('onlineLeaveBtn').click()")
        confirm(guest)
        host.wait_for_timeout(1500)
        record("guest leaving publishes `left`", any(e["from"] == GUESTY_ID for e in events(guest, "left")))
        record("host's list drops the guest", "GUESTY" not in host.evaluate(NAMES).upper(), " ".join(host.evaluate(NAMES).upper().split()))
        record("host is still host and in the room", in_room(host))
        record("guest left the lobby", not in_room(guest))
        record("no page errors (guest leaves)", not (host.errors + guest.errors), "; ".join(host.errors + guest.errors)[:300])
        ctx.close()

        ctx, host, guest = room_of_two(browser, url)
        host.evaluate("() => document.getElementById('onlineLeaveBtn').click()")
        confirm(host)
        guest.wait_for_timeout(2000)
        transfers = [m for m in published(host) if m.get("t") == "host-transfer"]
        record("host leaving publishes `left`", any(e["from"] == HOSTY_ID for e in events(host, "left")))
        record("host leaving hands the room to the guest", any(m.get("newHost") == GUESTY_ID for m in transfers), json.dumps(transfers)[:200])
        record("the room does not close while a player can take over", not events(host, "closed"))
        try:
            guest.wait_for_function(
                "() => { const l = document.getElementById('onlinePlayerList'); "
                "return !!l && l.offsetParent !== null && /GUESTY \\(YOU\\)\\s*★ HOST/i.test(l.innerText.replace(/\\s+/g, ' ')); }",
                timeout=8000)
            took_over = True
        except Exception:
            took_over = False
        record("the guest becomes host and stays in the room", took_over, " ".join(guest.evaluate(NAMES).upper().split()))
        record("no page errors (host leaves)", not (host.errors + guest.errors), "; ".join(host.errors + guest.errors)[:300])
        ctx.close()

        ctx = browser.new_context(viewport={"width": 1280, "height": 720})
        ctx.add_init_script(HOOK + FAKE_MQTT + "try{localStorage.setItem('tetris_ipop','9999999999999')}catch(e){}")
        solo = open_page(ctx, url, "HOSTY")
        to_lobby(solo)
        create_room(solo)
        solo.wait_for_timeout(800)
        solo.evaluate("() => document.getElementById('onlineLeaveBtn').click()")
        confirm(solo)
        solo.wait_for_timeout(1000)
        record("a host leaving alone publishes `closed` and no hand-over", bool(events(solo, "closed")) and not [m for m in published(solo) if m.get("t") == "host-transfer"])
        record("no page errors (host leaves alone)", not solo.errors, "; ".join(solo.errors)[:300])
        ctx.close()

        ctx, host, guest = room_of_two(browser, url)
        host.evaluate("() => document.querySelector('button[data-kick=\"111a296b37f4ee803aed12a70ba15ac3\"]').click()")
        confirm(host)
        guest.wait_for_timeout(2000)
        record("kick publishes `kick` for the guest", any(e["payload"].get("target") == GUESTY_ID for e in events(host, "kick")))
        record("host's list drops the kicked guest", "GUESTY" not in host.evaluate(NAMES).upper(), " ".join(host.evaluate(NAMES).upper().split()))
        record("the kicked guest sees the alert and is out of the room", "KICKED" in guest.evaluate("() => document.body.innerText").upper() and not in_room(guest))
        record("no page errors (kick)", not (host.errors + guest.errors), "; ".join(host.errors + guest.errors)[:300])
        ctx.close()
        browser.close()
    srv.shutdown()
    ok = bool(results) and all(results)
    print("relay leave: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).parent))
    sys.exit(main(sys.argv[1]))
