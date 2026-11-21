"""Two real pages join one relay room through an in-browser fake MQTT broker (real time).

Usage: python3 tests/harness/check_relay_handshake.py <dist-dir>

The page loads the MQTT library from a CDN, which the sandbox cannot reach, and the public
brokers are not reachable either. A small stand-in for `window.mqtt` passes every publish to all
pages of the browser context through a BroadcastChannel, which is all the relay code needs. The
page must be served over http (file:// pages cannot share a channel), so this check takes the
multi-file build directory.

Checks:
  1. a guest that sends no version (every build before the version field) joins and is seated;
  2. a guest that announces the current version joins and is seated;
  3. a guest that announces a newer version is denied with reason "version" and gets the alert;
  4. a host that answers with a newer version makes the guest give up with the same alert;
  5. a host that sends no version (every earlier build) seats a current guest.
"""
import functools, http.server, pathlib, sys, threading, time
from playwright.sync_api import sync_playwright
from lib import player_key, slow_down_waits
slow_down_waits()

FAKE_MQTT = """
(() => {
  const bus = new BroadcastChannel('fake-mqtt');
  const clients = new Set();
  const deliver = (topic, text) => {
    for (const c of clients) if (c.subs.has(topic)) setTimeout(() => c.handlers.message && c.handlers.message(topic, { toString: () => text }), 0);
  };
  bus.onmessage = (e) => deliver(e.data.topic, e.data.text);
  window.__published = [];
  window.mqtt = { connect() {
    const c = { subs: new Set(), handlers: {}, connected: true };
    c.on = (ev, fn) => { c.handlers[ev] = fn; return c; };
    c.subscribe = (t) => { c.subs.add(t); };
    c.unsubscribe = (t) => { c.subs.delete(t); };
    c.publish = (topic, payload) => {
      const text = String(payload);
      window.__published.push({ topic, text });
      bus.postMessage({ topic, text });
      deliver(topic, text);
    };
    c.end = () => { clients.delete(c); };
    clients.add(c);
    setTimeout(() => c.handlers.connect && c.handlers.connect(), 20);
    return c;
  } };
})();
"""

HOOK = "window.__h = window.__h || {};"


def serve(root):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args, **kwargs):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def open_page(ctx, url, name):
    page = ctx.new_page()
    page.add_init_script("try{sessionStorage.setItem('tetris_pkey','%s')}catch(e){}" % player_key(name.lower()))
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.route("**/*", lambda r: r.continue_() if r.request.url.startswith(("http://127.0.0.1:", "data:", "blob:")) else r.fulfill(status=200, body="", content_type="text/css"))
    page.goto(url, wait_until="load")
    page.wait_for_timeout(400)
    page.evaluate("(n) => { const el = document.getElementById('onlineUsername'); if (el) el.value = n; try { localStorage.setItem('tetris_username', n); } catch (e) {} }", name)
    return page


def to_lobby(page):
    page.evaluate("() => __h.showScreen('online-lobby')")
    page.wait_for_selector("#btnCreateRoom", state="attached", timeout=5000)


def create_room(page):
    page.evaluate("() => { const n = document.getElementById('onlineUsername'); if (n) n.value = 'HOSTY'; document.getElementById('btnCreateRoom').click(); }")
    page.wait_for_timeout(1500)
    code = page.evaluate("() => { const m = (window.__published || []).map(p => p.topic.split('/')[1]).find(Boolean); return m || null; }")
    if not code:
        code = page.evaluate("() => { const t = document.body.innerText.match(/\\b[A-HJ-NP-Z]{6}\\b/g); return t ? t[0] : null; }")
    return code


def join_room(page, code):
    page.evaluate("(c) => { const i = document.getElementById('onlineRoomCodeInput'); i.value = c; document.getElementById('btnConfirmJoin').click(); }", code)


def players_text(page):
    return page.evaluate("() => document.body.innerText")


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

        def fresh():
            ctx = browser.new_context(viewport={"width": 1280, "height": 720})
            ctx.add_init_script(HOOK + FAKE_MQTT + "try{localStorage.setItem('tetris_ipop','9999999999999');localStorage.setItem('tetris_telemetry','off')}catch(e){}")
            return ctx

        # 1 and 2: legacy guest and current guest
        for label, patch in (("legacy guest (no version field)", True), ("current guest (version 1)", False)):
            ctx = fresh()
            host = open_page(ctx, url, "HOSTY")
            to_lobby(host)
            code = create_room(host)
            if not code:
                record(label, False, "no room code seen on the broker")
                ctx.close()
                continue
            guest = open_page(ctx, url, "GUESTY")
            if patch:
                # strip the version field from everything this guest publishes, as v1.2.0 did
                guest.evaluate("""() => {
                  const real = window.mqtt.connect;
                  window.mqtt.connect = function (...a) {
                    const c = real.apply(this, a);
                    const pub = c.publish;
                    c.publish = (t, p) => { try { const o = JSON.parse(p); delete o.v; p = JSON.stringify(o); } catch (e) {} return pub(t, p); };
                    return c;
                  };
                }""")
            to_lobby(guest)
            join_room(guest, code)
            guest.wait_for_timeout(2500)
            seated = "GUESTY" in players_text(host).upper()
            record(label + " is seated by the host", seated, "room " + code)
            ctx.close()

        # 3: newer guest is denied
        ctx = fresh()
        host = open_page(ctx, url, "HOSTY")
        to_lobby(host)
        code = create_room(host)
        guest = open_page(ctx, url, "NEWGUY")
        guest.evaluate("""() => {
          const real = window.mqtt.connect;
          window.mqtt.connect = function (...a) {
            const c = real.apply(this, a);
            const pub = c.publish;
            c.publish = (t, p) => { try { const o = JSON.parse(p); if (o.t === 'join') o.v = 99; p = JSON.stringify(o); } catch (e) {} return pub(t, p); };
            return c;
          };
        }""")
        to_lobby(guest)
        join_room(guest, code)
        guest.wait_for_timeout(2500)
        txt = players_text(guest)
        denied = any(p for p in guest.evaluate("() => window.__published") if '"join"' in p["text"])
        record("newer guest is not seated", "NEWGUY" not in players_text(host).upper())
        record("newer guest sees the version alert", "different version" in txt, "joined=" + str(denied))
        ctx.close()

        # 4: newer host is refused by the guest
        ctx = fresh()
        host = open_page(ctx, url, "HOSTY")
        host.evaluate("""() => {
          const real = window.mqtt.connect;
          window.mqtt.connect = function (...a) {
            const c = real.apply(this, a);
            const pub = c.publish;
            c.publish = (t, p) => { try { const o = JSON.parse(p); if (o.t === 'ack') o.v = 99; p = JSON.stringify(o); } catch (e) {} return pub(t, p); };
            return c;
          };
        }""")
        to_lobby(host)
        code = create_room(host)
        guest = open_page(ctx, url, "GUESTY")
        to_lobby(guest)
        join_room(guest, code)
        guest.wait_for_timeout(2500)
        record("guest refuses a newer host", "different version" in players_text(guest))
        ctx.close()
        # 5: a host without versions (every earlier build) still seats a current guest
        ctx = fresh()
        host = open_page(ctx, url, "HOSTY")
        host.evaluate("""() => {
          const real = window.mqtt.connect;
          window.mqtt.connect = function (...a) {
            const c = real.apply(this, a);
            const pub = c.publish;
            c.publish = (t, p) => { try { const o = JSON.parse(p); delete o.v; p = JSON.stringify(o); } catch (e) {} return pub(t, p); };
            return c;
          };
        }""")
        to_lobby(host)
        code = create_room(host)
        guest = open_page(ctx, url, "GUESTY")
        to_lobby(guest)
        join_room(guest, code)
        guest.wait_for_timeout(2500)
        record("legacy host seats a current guest", "GUESTY" in players_text(host).upper())
        ctx.close()
        browser.close()
    srv.shutdown()
    bad = [r for r in results if not r[1]]
    print("relay handshake: %s" % ("PASS" if not bad and results else "FAIL"))
    return 1 if bad or not results else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
