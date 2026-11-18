"""What a guest sees when a relay join does not work (real time, two real pages and a fake broker).

Usage: python3 tests/harness/check_relay_join_errors.py <dist-dir>

The lobby turns the relay backend's answer into screens and notes, so each refusal is checked on
the page:
  1. a room nobody hosts: after the join timeout the note says so and the button is usable again;
  2. a protected room: the guest is asked for the password, a wrong one asks again and says so, the
     right one seats the guest on the host's list;
  3. no broker reachable: the note says no server could be reached and the button is usable again;
  4. the MQTT library cannot be loaded: the button is usable again and nothing throws.
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from check_relay_handshake import FAKE_MQTT, HOOK, create_room, join_room, open_page, players_text, serve, to_lobby  # noqa: E402

DEAD_MQTT = """
(() => { window.mqtt = { connect() {
  const c = { handlers: {} };
  c.on = (ev, fn) => { c.handlers[ev] = fn; return c; };
  c.subscribe = c.unsubscribe = c.publish = () => {};
  c.end = () => {};
  setTimeout(() => c.handlers.error && c.handlers.error(new Error('down')), 20);
  return c;
} }; })();
"""

NOTE = "() => (document.getElementById('onlineStatusNote') || {}).textContent || ''"
BUTTON_FREE = "() => { const b = document.getElementById('btnConfirmJoin'); return !!b && !b.disabled && !b.classList.contains('busy'); }"
SUBMIT_PROMPT = "(v) => { document.getElementById('cfPwd').value = v; document.getElementById('cfOk').click(); }"


def main(dist):
    root = pathlib.Path(dist).resolve()
    srv = serve(root)
    url = "http://127.0.0.1:%d/index.html" % srv.server_address[1]
    results = []

    def record(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("[PASS] " if ok else "[FAIL] ") + name + (" - " + detail if detail else ""))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--disable-gpu"])

        def fresh(mqtt_script):
            ctx = browser.new_context(viewport={"width": 1280, "height": 720})
            ctx.add_init_script(HOOK + mqtt_script + "try{localStorage.setItem('tetris_ipop','9999999999999')}catch(e){}")
            return ctx

        # 1: a room nobody hosts
        ctx = fresh(FAKE_MQTT)
        guest = open_page(ctx, url, "GUESTY")
        to_lobby(guest)
        join_room(guest, "ZZZZZZ")
        guest.wait_for_timeout(11000)
        note = guest.evaluate(NOTE)
        record("unknown room: the note says it was not found", "not found" in note.lower(), note)
        record("unknown room: the button is usable again", guest.evaluate(BUTTON_FREE))
        record("unknown room: no page error", not guest.errors, "; ".join(guest.errors))
        ctx.close()

        # 2: a protected room
        ctx = fresh(FAKE_MQTT)
        host = open_page(ctx, url, "HOSTY")
        to_lobby(host)
        host.evaluate("() => { document.getElementById('tglOnlinePwd').click(); document.getElementById('onlineRoomPassword').value = 'SECRET'; }")
        code = create_room(host)
        guest = open_page(ctx, url, "GUESTY")
        to_lobby(guest)
        join_room(guest, code)
        guest.wait_for_selector("#cfPwd", timeout=5000)
        first = guest.evaluate("() => document.getElementById('cfText').innerText")
        record("protected room: the guest is asked for the password", "protected" in first, first.replace("\n", " "))
        record("protected room: the guest is not seated yet", "GUESTY" not in players_text(host).upper())
        guest.evaluate(SUBMIT_PROMPT, "WRONG")
        guest.wait_for_function("() => /wrong password/i.test(document.getElementById('cfText').innerText)", timeout=5000)
        record("protected room: a wrong password asks again and says so", True)
        guest.evaluate(SUBMIT_PROMPT, "SECRET")
        guest.wait_for_timeout(2500)
        record("protected room: the right password seats the guest", "GUESTY" in players_text(host).upper())
        record("protected room: no page error", not guest.errors and not host.errors, "; ".join(guest.errors + host.errors))
        ctx.close()

        # 3: no broker reachable
        ctx = fresh(DEAD_MQTT)
        guest = open_page(ctx, url, "GUESTY")
        to_lobby(guest)
        join_room(guest, "ABCDEF")
        guest.wait_for_timeout(2500)
        note = guest.evaluate(NOTE)
        record("no broker: the note says no server could be reached", "could not reach" in note.lower(), note)
        record("no broker: the button is usable again", guest.evaluate(BUTTON_FREE))
        ctx.close()

        # 4: the MQTT library cannot be loaded (no stand-in, the CDN is blocked)
        ctx = fresh("")
        guest = open_page(ctx, url, "GUESTY")
        to_lobby(guest)
        join_room(guest, "ABCDEF")
        guest.wait_for_timeout(6000)
        record("no library: the button is usable again", guest.evaluate(BUTTON_FREE))
        record("no library: no page error", not guest.errors, "; ".join(guest.errors))
        ctx.close()
        browser.close()
    srv.shutdown()
    bad = [r for r in results if not r[1]]
    print("relay join errors: %s" % ("PASS" if not bad and results else "FAIL"))
    return 1 if bad or not results else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
