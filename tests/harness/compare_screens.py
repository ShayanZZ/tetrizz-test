"""Compare two screenshot trees. Usage: compare_screens.py <golden_dir> <new_dir>
A pixel counts as different when any channel differs by more than CHANNEL_TOL.
A shot fails when more than MAX_PIXEL_FRACTION of its pixels differ (after masks).
Tolerances come from two identical runs of the v1.2.0 reference (worst noise 0.0004% at tolerance 4); the only masked area is a badge on the phone practice screen."""
import json, pathlib, sys
import numpy as np
from PIL import Image

CHANNEL_TOL = 4
MAX_PIXEL_FRACTION = 0.0001
MASKS = json.loads((pathlib.Path(__file__).parent / "noise_masks.json").read_text())


def compare(golden, new):
    bad, worst = [], 0.0
    files = sorted(p.relative_to(golden) for p in golden.rglob("*.png"))
    for rel in files:
        key = str(rel.with_suffix(""))
        other = new / rel
        if not other.exists():
            bad.append((key, "missing")); continue
        a = np.asarray(Image.open(golden / rel).convert("RGB"), dtype=np.int16)
        b = np.asarray(Image.open(other).convert("RGB"), dtype=np.int16)
        if a.shape != b.shape:
            bad.append((key, f"size {a.shape} vs {b.shape}")); continue
        diff = (np.abs(a - b).max(axis=2) > CHANNEL_TOL)
        for x0, y0, x1, y1 in MASKS.get(key, []):
            diff[y0:y1, x0:x1] = False
        frac = float(diff.mean())
        worst = max(worst, frac)
        if frac > MAX_PIXEL_FRACTION:
            bad.append((key, f"{frac:.4%} pixels differ"))
    return files, bad, worst


if __name__ == "__main__":
    files, bad, worst = compare(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
    print(f"{len(files)} shots, {len(bad)} failing, worst {worst:.4%}")
    for k, why in bad:
        print("  FAIL", k, why)
    sys.exit(1 if bad else 0)
