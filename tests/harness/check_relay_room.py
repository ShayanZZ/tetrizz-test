"""Two real pages play a relay room from lobby to match through an in-browser fake MQTT broker.

Usage: python3 tests/harness/check_relay_room.py <dist-dir>   (real time; the multi-file build)

No network is used: the stand-in for `window.mqtt` from check_relay_handshake.py passes every
publish between the pages. The check goes through the game's own transport and dispatch code:

  1. the host creates a room and the guest joins it; each page lists the other player;
  2. the guest presses READY and the host's list shows the guest as READY (`ready` event);
  3. the host presses START MATCH and both pages go into an online match (`start` event);
  4. during the match both pages publish `state` events and neither page raises an error;
  5. an event name that is not in the dispatch table (`constructor`) sent into a page does nothing.
"""
import json, pathlib, sys
from playwright.sync_api import sync_playwright
from check_relay_handshake import FAKE_MQTT, HOOK, create_room, join_room, open_page, serve, to_lobby


def events(page, name=None):
    out = []
    for p in page.evaluate("() => window.__published || []"):
        try:
            m = json.loads(p["text"])
        except ValueError:
            continue
        if m.get("t") == "ev" and (name is None or m.get("event") == name):
            out.append(m)
    return out


def main(dist):
    root = pathlib.Path(dist).resolve()
    srv = serve(root)
    url = "http://127.0.0.1:%d/index.html" % srv.server_address[1]
    results = []

    def record(name, ok, detail=""):
        results.append(ok)
        print(("[PASS] " if ok else "[FAIL] ") + name + (" - " + detail if detail else ""))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--disable-gpu"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 720})
        ctx.add_init_script(HOOK + FAKE_MQTT + "try{localStorage.setItem('tetris_ipop','9999999999999')}catch(e){}")
        host = open_page(ctx, url, "HOSTY")
        to_lobby(host)
        code = create_room(host)
        guest = open_page(ctx, url, "GUESTY")
        to_lobby(guest)
        join_room(guest, code or "")
        guest.wait_for_timeout(2500)
        names = "() => document.getElementById('onlinePlayerList').innerText"
        record("host lists the guest", "GUESTY" in host.evaluate(names).upper(), "room " + str(code))
        record("guest lists the host", "HOSTY" in guest.evaluate(names).upper())

        guest.evaluate("() => document.getElementById('btnReady').click()")
        host.wait_for_timeout(1500)
        ready = [e for e in events(guest, "ready") if e["payload"].get("ready") is True]
        shown = " ".join(host.evaluate(names).upper().split())
        record("guest's READY is received by the host", bool(ready) and "GUESTY" in shown and "✓ READY" in shown, shown)

        host.evaluate("() => document.getElementById('btnStartOnlineGame').click()")
        host.wait_for_timeout(4000)
        playing = lambda pg: pg.evaluate("() => document.body.classList.contains('online-play')")
        record("host's START puts both pages into the match", playing(host) and playing(guest), "host=%s guest=%s" % (playing(host), playing(guest)))
        host.wait_for_timeout(2500)
        senders = {e["from"] for e in events(host, "state")} | {e["from"] for e in events(guest, "state")}
        record("both pages publish match state", {"pid-hosty", "pid-guesty"} <= senders, str(sorted(senders)))

        for pg in (host, guest):
            pg.evaluate("""() => {
              const bus = new BroadcastChannel('fake-mqtt');
              const topic = [...(window.__published || [])].map(p => p.topic).find(Boolean);
              for (const event of ['constructor', '__proto__', 'toString'])
                bus.postMessage({ topic, text: JSON.stringify({ t: 'ev', from: 'pid-x', event, payload: {} }) });
            }""")
        host.wait_for_timeout(500)
        errors = host.errors + guest.errors
        record("unknown event names are ignored and no page error is raised", not errors, "; ".join(errors)[:300])
        ctx.close()
        browser.close()
    srv.shutdown()
    print("relay room: %s" % ("PASS" if all(results) and results else "FAIL"))
    return 0 if all(results) and results else 1


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).parent))
    sys.exit(main(sys.argv[1]))
