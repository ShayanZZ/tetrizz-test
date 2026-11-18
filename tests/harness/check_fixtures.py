"""Load the v1.2.0 profile fixture into a build and compare the visible result.
Usage: check_fixtures.py <target.html> [--write]   (--write refreshes the expected file from the target)"""
import json, pathlib, sys
from playwright.sync_api import sync_playwright
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import Game, ROOT

FIX = ROOT / "tests" / "fixtures" / "legacy"


def summary(pw, target):
    profile = json.loads((FIX / "profile-full.json").read_text())
    profile["tetris_ipop"] = "9999999999999"
    g = Game(pw, target, seed=9, storage=profile)
    g.run(800)
    out = g.ev("()=>__h.profileSummary()")
    out["errors"] = g.errors
    g.close()
    return out


if __name__ == "__main__":
    target = sys.argv[1]
    with sync_playwright() as pw:
        got = summary(pw, target)
    exp_path = FIX / "profile-full.expected.json"
    if "--write" in sys.argv:
        exp_path.write_text(json.dumps(got, indent=1, sort_keys=True))
        print("wrote expected:", {k: (v if not isinstance(v, str) else v[:60]) for k, v in got.items() if k != "opts"})
        sys.exit(0)
    exp = json.loads(exp_path.read_text())
    got = json.loads(json.dumps(got, sort_keys=True))
    bad = [k for k in exp if exp[k] != got.get(k)]
    print("fixture check:", "PASS" if not bad else f"FAIL {bad}")
    sys.exit(1 if bad else 0)
