"""Run the behaviour/visual/data checks of a build against the v1.2.0 goldens.
Usage: python3 tests/harness/verify.py <target.html | dist-directory> [--part solo|vs|screens|fixtures ...]
Exit code 0 only when every selected part passes. Needs: python3, playwright (+ chromium), numpy, pillow."""
import functools, http.server, json, pathlib, subprocess, sys, tempfile, threading

H = pathlib.Path(__file__).resolve().parent
G = H.parents[0] / "golden"


def run(*cmd):
    return subprocess.run([sys.executable, *map(str, cmd)], capture_output=True, text=True)


def part_solo(target, tmp):
    r = run(H / "record_solo.py", target, tmp / "solo")
    bad = [m for m in ("endless", "ultra", "sprint", "wide")
           if json.loads((tmp / "solo" / f"solo-{m}.json").read_text())["trace"] != json.loads((G / "solo" / f"solo-{m}.json").read_text())["trace"]]
    return not bad and r.returncode == 0, f"traces differing: {bad or 'none'}"


def part_vs(target, tmp):
    r = run(H / "record_vs.py", target, tmp / "vs")
    a = json.loads((tmp / "vs" / "vs-4p-bots.json").read_text())["trace"]
    b = json.loads((G / "vs" / "vs-4p-bots.json").read_text())["trace"]
    return a == b and r.returncode == 0, "4-player bot match trace " + ("identical" if a == b else "DIFFERS")


def part_screens(target, tmp):
    for v in ("desktop-dark", "desktop-light", "phone-dark", "phone-light"):
        run(H / "screens.py", target, tmp / "screens", "--variant", v)
    r = run(H / "compare_screens.py", G / "screens", tmp / "screens")
    return r.returncode == 0, r.stdout.strip()


def part_fixtures(target, tmp):
    r = run(H / "check_fixtures.py", target)
    return r.returncode == 0, r.stdout.strip()


def serve(directory):
    """Serves a multi-file build (dist/) on a loopback port: ES modules do not load from file://."""
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(directory)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


PARTS = {"solo": part_solo, "vs": part_vs, "screens": part_screens, "fixtures": part_fixtures}

if __name__ == "__main__":
    target = sys.argv[1]
    if pathlib.Path(target).is_dir():
        srv = serve(pathlib.Path(target).resolve())
        target = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    chosen = [sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--part"] or list(PARTS)
    ok_all = True
    with tempfile.TemporaryDirectory() as t:
        for name in chosen:
            ok, msg = PARTS[name](target, pathlib.Path(t))
            ok_all &= ok
            print(f"[{'PASS' if ok else 'FAIL'}] {name}: {msg}")
    sys.exit(0 if ok_all else 1)
