"""Checks how the page reads its network settings.
Usage: check_network_config.py <dist-dir>   (a multi-file build made with no TETRIZZ_ variables)
Serves a copy of the build over HTTP and loads it with different `config.json` files, recording which
CDN libraries the page asks for (the requests fail in a sandbox without internet; only the asking counts). Nothing configured must download nothing; a valid Supabase entry must
ask for the pinned supabase-js; an invalid one must not; and a changed `config.json` must be picked up
on the next load even with the service worker in control."""
import functools, http.server, json, pathlib, shutil, sys, tempfile, threading
from playwright.sync_api import sync_playwright

KEY = "sb_publishable_" + "x" * 31
PINNED = "supabase-js@2.119.0/dist/umd/supabase.js"


def serve(directory):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(directory)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def load(pw, root, srv, config, reload_with=None):
    cfg = root / "config.json"
    cfg.unlink(missing_ok=True)
    if config is not None:
        cfg.write_text(json.dumps(config))
    browser = pw.chromium.launch()
    ctx = browser.new_context()
    ctx.add_init_script("try{localStorage.setItem('tetris_telemetry','off')}catch(e){}")
    page = ctx.new_page()
    cdn, errors, cfg_status = [], [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("response", lambda r: cfg_status.append(r.status) if r.url.endswith("/config.json") else None)

    page.on("request", lambda r: cdn.append(r.url) if r.url.startswith("https://cdn.jsdelivr.net/") else None)
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    page.goto(url)
    page.wait_for_timeout(1500)
    if reload_with is not None:
        page.evaluate("navigator.serviceWorker.ready.then(() => true)")
        cdn.clear()
        cfg.write_text(json.dumps(reload_with))
        page.reload()
        page.wait_for_timeout(1500)
    browser.close()
    return cdn, errors, cfg_status


def main(dist):
    root = pathlib.Path(tempfile.mkdtemp()) / "site"
    shutil.copytree(dist, root)
    srv = serve(root)
    results = []
    with sync_playwright() as pw:
        cdn, errors, status = load(pw, root, srv, None)
        results.append(("nothing configured: no library downloaded", not cdn and not errors, cdn or errors))
        results.append(("config.json was requested and is simply absent", 404 in status, status))

        cdn, errors, _ = load(pw, root, srv, {"supabase": {"url": "https://example-project.supabase.co", "anonKey": KEY + "y" * 10}})
        results.append(("valid Supabase entry: pinned supabase-js requested", any(PINNED in u for u in cdn) and not errors, cdn or errors))

        cdn, errors, _ = load(pw, root, srv, {"supabase": {"url": "http://example-project.supabase.co", "anonKey": KEY + "y" * 10}})
        results.append(("invalid Supabase entry: dropped, nothing downloaded", not cdn and not errors, cdn or errors))

        cdn, errors, _ = load(pw, root, srv, {"supabase": None, "server": {"url": "/"}})
        results.append(("server entry alone starts no download", not cdn and not errors, cdn or errors))

        cdn, errors, _ = load(pw, root, srv, None, reload_with={"supabase": {"url": "https://example-project.supabase.co", "anonKey": KEY + "y" * 10}})
        results.append(("config.json changed under the service worker is read on reload", any(PINNED in u for u in cdn) and not errors, cdn or errors))
    srv.shutdown()
    ok = True
    for name, good, detail in results:
        print(("[PASS] " if good else "[FAIL] ") + name + ("" if good else f"  -> {detail}"))
        ok = ok and good
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main(sys.argv[1])
