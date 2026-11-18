#!/usr/bin/env python3
"""The VPS stack's front door with the real parts: Caddy, the built server and the built page.

Usage: python3 tests/harness/check_front_door.py <dist-dir> <server-dist>/index.js

Needs `caddy` on PATH (skipped with exit code 0 when it is missing). It takes deploy/Caddyfile, points
it at the built page and a locally started server, and has Chromium open the page through Caddy
and make a room. The page must open its socket at exactly /ws on the page's own address, which is
the path Caddy forwards to the server; an address in /config.json that the page extends with /ws
a second time ends in /ws/ws and the page quietly falls back to the public relay.
"""
import os, pathlib, re, shutil, signal, subprocess, sys, tempfile, time, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright
from check_relay_handshake import HOOK, open_page, to_lobby

REPO = pathlib.Path(__file__).resolve().parents[2]
SITE_PORT, SERVER_PORT = 18080, 18791

if len(sys.argv) < 3:
    sys.exit(__doc__)
dist, server_js = pathlib.Path(sys.argv[1]).resolve(), pathlib.Path(sys.argv[2]).resolve()
caddy = shutil.which("caddy")
if caddy is None:
    print("  skip  caddy is not installed")
    sys.exit(0)

tmp = pathlib.Path(tempfile.mkdtemp())
site = tmp / "srv"
shutil.copytree(dist, site)
caddyfile = (REPO / "deploy" / "Caddyfile").read_text()
caddyfile = (
    caddyfile.replace("admin localhost:2019", "admin off")
    .replace("server:8787", f"127.0.0.1:{SERVER_PORT}")
    .replace("root * /srv", f"root * {site}")
)
(tmp / "Caddyfile").write_text(caddyfile)

procs: list[subprocess.Popen] = []


def start(cmd: list[str], env: dict) -> None:
    procs.append(subprocess.Popen(cmd, env={**os.environ, **env}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))


failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'}  {label}" + ("" if ok else f"  ({detail})"))
    if not ok:
        failures.append(label)


try:
    start(["node", str(server_js)], {"PORT": str(SERVER_PORT), "HOST": "127.0.0.1"})
    start([caddy, "run", "--config", str(tmp / "Caddyfile"), "--adapter", "caddyfile"], {"SITE_ADDRESS": f":{SITE_PORT}"})
    base = f"http://127.0.0.1:{SITE_PORT}"
    for _ in range(60):
        try:
            urllib.request.urlopen(f"{base}/healthz", timeout=1).read()
            break
        except Exception:
            time.sleep(0.25)
    else:
        sys.exit("the front door did not come up")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 720})
        ctx.add_init_script(HOOK)
        sockets: list[str] = []
        ctx.on("page", lambda pg: pg.on("websocket", lambda ws: sockets.append(ws.url)))
        page = open_page(ctx, f"{base}/", "HOSTY")
        to_lobby(page)
        page.evaluate("() => document.getElementById('btnCreateRoom').click()")
        code = ""
        for _ in range(30):
            page.wait_for_timeout(300)
            code = (page.evaluate("() => (document.getElementById('displayRoomCode') || {}).textContent || ''") or "").strip()
            if re.fullmatch(r"[A-Z]{6}", code):
                break
        browser.close()

    check("the page opened its socket at /ws on the page's own address", sockets == [f"ws://127.0.0.1:{SITE_PORT}/ws"], sockets)
    check("a room was made", bool(re.fullmatch(r"[A-Z]{6}", code)), code)
    check("the page raised no errors", not page.errors, page.errors)
finally:
    for p in procs:
        p.send_signal(signal.SIGTERM)
    for p in procs:
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            p.kill()
    shutil.rmtree(tmp, ignore_errors=True)

sys.exit(1 if failures else 0)
