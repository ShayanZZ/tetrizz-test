"""Shared helpers: open a TetriZZ build with a virtual clock and a seeded RNG."""
import hashlib, json, os, pathlib
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ADAPTER = (HERE / "legacy_adapter.js").read_text()
T0 = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)  # fixed start of the virtual clock


def player_key(name):
    """The secret key a test page is given for `name` (the page derives its player id from it)."""
    return hashlib.sha256(("harness-player:" + name).encode()).hexdigest()


def id_from_key(key):
    """The player id that belongs to a key; mirrors `playerIdFromKey` in packages/protocol."""
    return hashlib.sha256(("tetrizz-player-id-v1:" + key).encode()).hexdigest()[:32]


def player_id(name):
    return id_from_key(player_key(name))


HOSTY_ID = player_id("hosty")
GUESTY_ID = player_id("guesty")

SEED_JS = """
(() => {
  let s = %d >>> 0;
  Math.random = function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < %d; i++) Math.random();
  try { if (!localStorage.getItem('tetris_ipop')) localStorage.setItem('tetris_ipop', '9999999999999'); } catch (e) {}
  %s
})();
"""


def boot_draws(target):
    """How many numbers the harness takes from the seeded Math.random before the page starts.

    The goldens (tests/golden) were recorded from the v1.2.0 page, which drew one number at start to
    make its random player id. Builds since Phase 8c-4b derive the id from a secret key made with
    crypto.getRandomValues, so they no longer draw. One number is skipped for them, which keeps
    every later draw (the piece bags, the bots) the sequence the goldens were recorded with. The
    legacy page itself draws its own.
    """
    return 0 if "legacy" in pathlib.Path(str(target)).parts else 1


class Game:
    """One browser page running a build. Time only moves when run() is called."""

    def __init__(self, pw, target, viewport=(1280, 720), seed=1, storage=None,
                 mobile=False, cpu_throttle=1, adapter=True, extra_init="", virtual_clock=True):
        self._virtual = virtual_clock
        self.browser = pw.chromium.launch(args=["--disable-gpu", "--force-color-profile=srgb"])
        opts = {"viewport": {"width": viewport[0], "height": viewport[1]}}
        if mobile:
            opts.update(is_mobile=True, has_touch=True, device_scale_factor=1)
        self.ctx = self.browser.new_context(**opts)
        # Bots think on the page's own thread unless a run asks otherwise: a worker answers in
        # real time, which the virtual clock cannot control, so traces would not repeat.
        storage = dict({"tetris_botworker": "0"}, **(storage or {}))
        pre = "".join("try{localStorage.setItem(%s,%s)}catch(e){};" % (json.dumps(k), json.dumps(v))
                      for k, v in storage.items())
        self.ctx.add_init_script(SEED_JS % (seed, boot_draws(target), pre))
        if adapter:
            self.ctx.add_init_script(ADAPTER)
        if extra_init:
            self.ctx.add_init_script(extra_init)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        # External requests (Google Fonts) answer instantly and empty, so their real-time
        # completion cannot interleave with the virtual clock.
        self.page.route("**/*", lambda r: r.continue_() if r.request.url.startswith(("file:", "data:", "blob:", "http://127.0.0.1:")) else r.fulfill(status=200, body="", content_type="text/css"))
        if virtual_clock:
            self.page.clock.install(time=T0)
        url = target if "://" in target else pathlib.Path(target).resolve().as_uri()
        self.page.goto(url, wait_until="load")
        if virtual_clock:
            self.page.clock.pause_at(T0 + timedelta(seconds=2))
        if cpu_throttle != 1:
            cdp = self.ctx.new_cdp_session(self.page)
            cdp.send("Emulation.setCPUThrottlingRate", {"rate": cpu_throttle})

    def run(self, ms):
        if hasattr(self.page, 'clock') and self._virtual:
            self.page.clock.run_for(ms)
        else:
            self.page.wait_for_timeout(ms)

    def ev(self, js, arg=None):
        return self.page.evaluate(js, arg)

    def reload(self):
        self.page.reload(wait_until="load")
        self.run(300)

    def close(self):
        self.browser.close()


# Real-time checks wait for things the pages do on their own. A slow machine (a CI runner) needs
# longer than a fast one, so every fixed wait is multiplied by HARNESS_SLOWDOWN (default 1), and the
# checks that matter poll for what they expect with `wait_until` instead of guessing a time.
SLOWDOWN = float(os.environ.get("HARNESS_SLOWDOWN", "1"))


def slow_down_waits():
    """Makes every `page.wait_for_timeout` wait SLOWDOWN times as long."""
    if SLOWDOWN == 1:
        return
    from playwright.sync_api import Page
    original = Page.wait_for_timeout
    Page.wait_for_timeout = lambda self, ms: original(self, ms * SLOWDOWN)


def wait_until(page, expression, timeout_ms=20000):
    """True as soon as the JavaScript `expression` (a function) is truthy in `page`, False after the timeout."""
    from playwright.sync_api import TimeoutError as PlaywrightTimeout
    try:
        page.wait_for_function(expression, timeout=timeout_ms * SLOWDOWN)
        return True
    except PlaywrightTimeout:
        return False
