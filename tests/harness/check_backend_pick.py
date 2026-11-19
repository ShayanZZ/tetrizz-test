"""Online backend order, the Options pick and the Supabase room channel (real time, fake Supabase client).

Usage: python3 tests/harness/check_backend_pick.py <dist-dir>   (a multi-file build made with no TETRIZZ_ variables)

A copy of the build is served with a `config.json` that configures Supabase, and a small in-memory
Supabase client (tables, filters and a realtime channel the test can push changes into) replaces the
library, next to the fake MQTT broker of check_relay_handshake.py. Checked on the page:
  1. the Options row SERVER is hidden without a second backend, cycles AUTO, SUPABASE, MQTT when there
     are two, and SAVE stores the pick;
  2. AUTO creates the room on Supabase and publishes nothing on the relay; the channel listens to the
     seats, the room update and the room delete; a new seat, a ready flag, a change of host and the
     room being deleted all show on the page;
  3. the pick MQTT creates the room on the relay and writes no Supabase row; a failing Supabase insert
     falls back to the relay under AUTO;
  4. joining on Supabase: a room, a protected room (wrong then right password), and a room that is not
     there, which is then asked of the relay and ends with the note that it was not found.
"""
import json, pathlib, shutil, sys, tempfile
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from check_relay_handshake import FAKE_MQTT, HOOK, open_page, players_text, serve, to_lobby  # noqa: E402
from lib import GUESTY_ID, HOSTY_ID

KEY = "sb_publishable_" + "x" * 41
FAKE_SUPABASE = """
(() => {
  const S = (window.__sb = { rows: { rooms: [], players: [] }, calls: [], channels: [], failInsert: false });
  const match = (row, filters) => filters.every(([op, col, v]) => (op === 'eq' ? row[col] === v : row[col] !== v));
  function query(name, op, vals) {
    const filters = [];
    const run = (single) => {
      S.calls.push([op, name]);
      const rows = S.rows[name].filter((r) => match(r, filters));
      if (op === 'delete') S.rows[name] = S.rows[name].filter((r) => !rows.includes(r));
      if (op === 'update') rows.forEach((r) => Object.assign(r, vals));
      const data = op === 'select' ? rows.map((r) => ({ ...r })) : null;
      return { data: single ? (data && data[0]) || null : data, error: null };
    };
    const q = {
      eq(c, v) { filters.push(['eq', c, v]); return q; },
      neq(c, v) { filters.push(['neq', c, v]); return q; },
      maybeSingle() { return Promise.resolve(run(true)); },
      then(res, rej) { return Promise.resolve(run(false)).then(res, rej); },
    };
    return q;
  }
  const table = (name) => ({
    select() { return query(name, 'select'); },
    insert(v) {
      S.calls.push(['insert', name]);
      if (S.failInsert) return Promise.resolve({ error: { message: 'down' } });
      S.rows[name].push({ ...v });
      return Promise.resolve({ data: null, error: null });
    },
    upsert(v) {
      S.calls.push(['upsert', name]);
      const i = S.rows[name].findIndex((r) => r.id === v.id);
      if (i >= 0) S.rows[name][i] = { ...S.rows[name][i], ...v }; else S.rows[name].push({ ...v });
      return Promise.resolve({ data: null, error: null });
    },
    delete() { return query(name, 'delete'); },
    update(v) { return query(name, 'update', v); },
  });
  window.supabase = { createClient() {
    return {
      from: table,
      channel(name) {
        const ch = { name, state: 'closed', listeners: [], sent: [],
          on(type, filter, cb) { ch.listeners.push({ type, filter, cb }); return ch; },
          subscribe(cb) { setTimeout(() => { ch.state = 'joined'; if (cb) cb('SUBSCRIBED'); }, 10); return ch; },
          send(m) { ch.sent.push(m); } };
        S.channels.push(ch);
        return ch;
      },
      removeChannel(ch) { const i = S.channels.indexOf(ch); if (i >= 0) S.channels.splice(i, 1); },
    };
  } };
  S.emit = (tbl, eventType, row, old) => {
    for (const ch of S.channels) for (const l of ch.listeners)
      if (l.type === 'postgres_changes' && l.filter.table === tbl && (l.filter.event === '*' || l.filter.event === eventType))
        l.cb({ eventType, new: row, old });
  };
})();
"""

SUBMIT_PROMPT = "(v) => { document.getElementById('cfPwd').value = v; document.getElementById('cfOk').click(); }"
OPEN_OPTIONS = "() => __h.showScreen('options')"
ROW_SHOWN = "() => { const b = document.querySelector('[data-netbackend]'); return !!b && b.closest('.step').style.display !== 'none'; }"
PICK_TEXT = "() => document.querySelector('[data-netbackend]').textContent"
CLICK_PICK = "() => document.querySelector('[data-netbackend]').click()"
SAVE_OPTIONS = (
    "() => [...document.querySelectorAll('.sticky-bar')]"
    ".find(b => b.textContent.includes('Options')).querySelector('.save-btn').click()"
)
BODY = "() => document.body.innerText"


def pwd_hash(text):
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return "%08x" % h


def main(dist):
    base = pathlib.Path(tempfile.mkdtemp())
    with_cfg, without_cfg = base / "with", base / "without"
    shutil.copytree(dist, with_cfg)
    shutil.copytree(dist, without_cfg)
    (with_cfg / "config.json").write_text(json.dumps({"supabase": {"url": "https://example-project.supabase.co", "anonKey": KEY}}))
    (without_cfg / "config.json").unlink(missing_ok=True)
    srv_with, srv_without = serve(with_cfg), serve(without_cfg)
    url_with = "http://127.0.0.1:%d/index.html" % srv_with.server_address[1]
    url_without = "http://127.0.0.1:%d/index.html" % srv_without.server_address[1]
    results = []

    def record(name, ok, detail=""):
        results.append(ok)
        print(("[PASS] " if ok else "[FAIL] ") + name + ((" - " + str(detail)) if detail and not ok else ""))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--disable-gpu"])

        def context(extra=""):
            ctx = browser.new_context(viewport={"width": 1280, "height": 720})
            ctx.add_init_script(HOOK + FAKE_MQTT + FAKE_SUPABASE + extra + "try{localStorage.setItem('tetris_ipop','9999999999999')}catch(e){}")
            return ctx

        def settle(page, ms=1200):
            page.wait_for_timeout(ms)

        # 1: the Options pick
        page = open_page(context(), url_without, "HOSTY")
        page.evaluate(OPEN_OPTIONS)
        record("one backend only: the pick is hidden", not page.evaluate(ROW_SHOWN))
        page.context.close()

        ctx = context()
        page = open_page(ctx, url_with, "HOSTY")
        settle(page)
        page.evaluate(OPEN_OPTIONS)
        record("two backends: the pick is shown", page.evaluate(ROW_SHOWN))
        seen = [page.evaluate(PICK_TEXT)]
        for _ in range(3):
            page.evaluate(CLICK_PICK)
            seen.append(page.evaluate(PICK_TEXT))
        record("the pick cycles AUTO, SUPABASE, MQTT and back", seen == ["AUTO", "SUPABASE", "MQTT", "AUTO"], seen)
        page.evaluate(CLICK_PICK)
        page.evaluate(CLICK_PICK)
        record("nothing is stored before SAVE", page.evaluate("() => localStorage.getItem('tetris_online_backend')") is None)
        page.evaluate(SAVE_OPTIONS)
        record("SAVE stores the pick", page.evaluate("() => localStorage.getItem('tetris_online_backend')") == "mqtt")
        page.reload(wait_until="load")
        settle(page)
        page.evaluate(OPEN_OPTIONS)
        record("a reload shows the saved pick", page.evaluate(PICK_TEXT) == "MQTT")
        record("no page errors in Options", not page.errors, page.errors)
        ctx.close()

        # 2: AUTO creates on Supabase, and the channel's handlers reach the page
        ctx = context()
        host = open_page(ctx, url_with, "HOSTY")
        settle(host)
        to_lobby(host)
        host.evaluate("() => document.getElementById('btnCreateRoom').click()")
        settle(host, 1800)
        rooms = host.evaluate("() => window.__sb.rows.rooms")
        record("AUTO creates the room row on Supabase", len(rooms) == 1 and rooms[0]["host_id"] == HOSTY_ID, rooms)
        record("the relay publishes nothing", host.evaluate("() => window.__published.length") == 0)
        listeners = host.evaluate("() => window.__sb.channels[0].listeners.map(l => l.type === 'postgres_changes' ? l.filter.table + ':' + l.filter.event : 'broadcast').filter((v, i, a) => v !== 'broadcast' || a.indexOf(v) === i)")
        record("the channel listens to seats, room update and room delete", listeners[:3] == ["players:*", "rooms:UPDATE", "rooms:DELETE"] and "broadcast" in listeners, listeners)
        room_id = rooms[0]["id"] if rooms else ""
        host.evaluate("(r) => { const S = window.__sb; const row = { id: '111a296b37f4ee803aed12a70ba15ac3', room_id: r, username: 'GUESTY', state: { role: 'player', joined: Date.now() } }; S.rows.players.push(row); S.emit('players', 'INSERT', row, null); }", room_id)
        settle(host, 600)
        record("a new seat shows on the list", "GUESTY" in players_text(host), players_text(host))
        host.evaluate("() => { const S = window.__sb; const row = S.rows.players.find(p => p.id === '111a296b37f4ee803aed12a70ba15ac3'); row.state = { ...row.state, ready: true }; S.emit('players', 'UPDATE', row, null); }")
        settle(host, 600)
        record("the guest's ready flag shows", "READY" in players_text(host).upper(), players_text(host))
        host.evaluate("() => { const S = window.__sb; S.rows.rooms[0].host_id = '111a296b37f4ee803aed12a70ba15ac3'; S.emit('rooms', 'UPDATE', S.rows.rooms[0], null); }")
        settle(host, 600)
        text = players_text(host)
        record(
            "a change of host moves the host mark and takes the host's controls away",
            "GUESTY\n\u2605 HOST" in text and "START MATCH" not in text and "Waiting for host" in text,
            text[:300],
        )
        host.evaluate("() => { const S = window.__sb; S.emit('rooms', 'DELETE', null, { id: S.rows.rooms[0].id }); }")
        settle(host, 800)
        record("the room being deleted sends the player out with a message", "closed" in host.evaluate(BODY).lower(), host.evaluate(BODY)[:200])
        record("no page errors on the channel", not host.errors, host.errors)
        ctx.close()

        # 3: the pick MQTT, and a failing Supabase under AUTO
        ctx = context("try{localStorage.setItem('tetris_online_backend','mqtt')}catch(e){}")
        page = open_page(ctx, url_with, "HOSTY")
        settle(page)
        to_lobby(page)
        page.evaluate("() => document.getElementById('btnCreateRoom').click()")
        settle(page, 1800)
        record("the pick MQTT creates the room on the relay", page.evaluate("() => window.__published.length") > 0)
        record("and writes no Supabase row", page.evaluate("() => window.__sb.rows.rooms.length + window.__sb.rows.players.length") == 0)
        ctx.close()

        ctx = context()
        page = open_page(ctx, url_with, "HOSTY")
        settle(page)
        page.evaluate("() => { window.__sb.failInsert = true; }")
        to_lobby(page)
        page.evaluate("() => document.getElementById('btnCreateRoom').click()")
        settle(page, 1800)
        tried = page.evaluate("() => window.__sb.calls.some(c => c[0] === 'insert' && c[1] === 'rooms')")
        record("a failing Supabase insert is tried, then the relay creates the room", tried and page.evaluate("() => window.__published.length") > 0)
        ctx.close()

        # 4: joining on Supabase
        seed = (
            "(() => { const S = window.__sb; S.rows.rooms.push({ id: 'OPENAB', host_id: 'pid-other', settings: { seed: 5 } });"
            "S.rows.players.push({ id: 'pid-other', room_id: 'OPENAB', username: 'OTHER', state: { role: 'player', joined: Date.now() } });"
            "S.rows.rooms.push({ id: 'LOCKAB', host_id: 'pid-other', settings: { seed: 6, pwdH: '%s' } });"
            "S.rows.players.push({ id: 'pid-lock', room_id: 'LOCKAB', username: 'LOCKED', state: { role: 'player', joined: Date.now() } }); })();"
        ) % pwd_hash("abc")

        def guest_page(ctx):
            page = open_page(ctx, url_with, "GUESTY")
            settle(page)
            page.evaluate(seed)
            to_lobby(page)
            return page

        def join(page, code):
            page.evaluate("(c) => { const i = document.getElementById('onlineRoomCodeInput'); i.value = c; document.getElementById('btnConfirmJoin').click(); }", code)

        ctx = context()
        page = guest_page(ctx)
        join(page, "OPENAB")
        settle(page, 1800)
        record("joining a room on Supabase seats the guest next to the host", "OTHER" in players_text(page) and "GUESTY" in players_text(page), players_text(page))
        record("the relay was not asked", page.evaluate("() => window.__published.length") == 0)
        ctx.close()

        ctx = context()
        page = guest_page(ctx)
        join(page, "LOCKAB")
        page.wait_for_selector("#cfPwd", timeout=5000)
        record("a protected room asks for the password and does not seat the guest", not any(p["id"] == GUESTY_ID for p in page.evaluate("() => window.__sb.rows.players")))
        page.evaluate(SUBMIT_PROMPT, "wrong")
        settle(page, 600)
        record("a wrong password is refused", "wrong password" in page.evaluate(BODY).lower())
        ctx.close()

        ctx = context()
        page = guest_page(ctx)
        join(page, "LOCKAB")
        page.wait_for_selector("#cfPwd", timeout=5000)
        page.evaluate(SUBMIT_PROMPT, "abc")
        settle(page, 1800)
        record("the right password seats the guest", "LOCKED" in players_text(page) and "GUESTY" in players_text(page), players_text(page))
        ctx.close()

        ctx = context()
        page = guest_page(ctx)
        join(page, "NOPEAB")
        page.wait_for_timeout(11500)
        asked = page.evaluate("() => window.__sb.calls.some(c => c[0] === 'select' && c[1] === 'rooms')")
        note = page.evaluate("() => (document.getElementById('onlineStatusNote') || {}).textContent || ''")
        record("an unknown room is asked on Supabase, then on the relay, and ends as not found", asked and page.evaluate("() => window.__published.length") > 0 and "not found" in note.lower(), note)
        record("no page errors while joining", not page.errors, page.errors)
        ctx.close()
        browser.close()

    srv_with.shutdown()
    srv_without.shutdown()
    print("backend pick: " + ("PASS" if all(results) else "FAIL"))
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main(sys.argv[1])
