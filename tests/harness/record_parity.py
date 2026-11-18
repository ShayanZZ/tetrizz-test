"""Records what the original v1.2.0 rules code returns for thousands of random inputs.

The unit test tests/unit/core-parity.test.ts replays the same inputs on packages/core and
expects identical answers. Run this only when the legacy page or the case generator changes:

    python tests/harness/record_parity.py

It rewrites tests/golden/parity/core-parity.json.
"""
import json
import pathlib
import random

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "tests" / "golden" / "parity" / "core-parity.json"
LEGACY = ROOT / "legacy" / "TetriZZ.html"
SEED = 20261110

RUN_JS = """
(cases) => {
  const out = {};
  const savedBoard = board, savedPiece = piece, savedCols = COLS, savedRows = ROWS;
  afterAction = () => {};
  fxSpin = () => {};
  SFX.rotate = () => {};
  SFX.spinMove = () => {};
  const decode = (rows) => rows.map((r) => Array.from(r, (ch) => +ch));
  const setDims = (c) => { COLS = c.cols; ROWS = c.rows; };
  out.collide = cases.collide.map((c) => {
    setDims(c);
    const bd = decode(c.board);
    const full = findFullRows(bd);
    return {
      hits: c.probes.map(([t, rot, x, y]) => collideOn(bd, PIECES[t].cells[rot], x, y)),
      full,
      pc: pcAfterClear(bd, c.clear),
    };
  });
  out.spin = cases.spin.map((c) => {
    setDims(c);
    const bd = decode(c.board);
    const p = { type: c.type, rot: c.rot, x: c.x, y: c.y, lastRotate: c.lk ? { kick: c.lk[0], dir: c.lk[1] } : null };
    const r = detectSpinOn(bd, p);
    return r ? { mini: !!r.mini } : null;
  });
  out.rotate = cases.rotate.map((c) => {
    setDims(c);
    board = decode(c.board);
    piece = { type: c.type, rot: c.rot, x: c.x, y: c.y, lockT: 0, lockResets: 0, lastRotate: null, softSounded: false };
    const ok = tryRotate(c.kind);
    return ok ? { x: piece.x, y: piece.y, rot: piece.rot, kick: piece.lastRotate.kick, dir: piece.lastRotate.dir } : null;
  });
  out.lock = cases.lock.map((a) => calcLockScore(a[0], a[1], a[2], a[3], a[4], a[5]));
  out.attack = cases.attack.map((a) => calcAttack(a[0], a[1], a[2], a[3], a[4]));
  out.tables = {
    speed: Array.from({ length: 41 }, (_, i) => speedFor(i + 1)),
    blitzLevel: Array.from({ length: 321 }, (_, i) => blitzLevelForLines(i)),
    blitzGrav: Array.from({ length: 22 }, (_, i) => blitzGravMsForLevel(i)),
    comboAtk: COMBO_ATK.slice(),
  };
  out.rng = cases.seeds.map((s) => { const r = mulberry32(s); return Array.from({ length: 16 }, () => r()); });
  board = savedBoard; piece = savedPiece; COLS = savedCols; ROWS = savedRows;
  return out;
}
"""


def rand_board(rnd, cols, rows):
    """Boards that look like play: a mostly filled stack with holes, wells and occasional empty rows."""
    mode = rnd.random()
    dens = rnd.uniform(0.25, 0.8)
    top = rnd.randint(0, rows - 2)
    rows_out = []
    for y in range(rows):
        if y < top:
            rows_out.append("0" * cols)
            continue
        if mode < 0.15 and rnd.random() < 0.5:
            r = ["1"] * cols
        else:
            r = [str(rnd.randint(1, 8)) if rnd.random() < dens else "0" for _ in range(cols)]
        if mode > 0.6 and rnd.random() < 0.5:
            r[rnd.randrange(cols)] = "0"
        rows_out.append("".join(r))
    return rows_out


def hits(cells, board, cols, rows, x, y):
    for cx, cy in cells:
        X, Y = x + cx, y + cy
        if X < 0 or X >= cols or Y >= rows:
            return True
        if Y >= 0 and board[Y][X] != "0":
            return True
    return False


def make_cases(pieces):
    rnd = random.Random(SEED)
    sizes = [(10, 23)] * 4 + [(4, 23), (6, 14), (8, 12), (12, 25), (10, 40), (5, 9)]

    def free_piece(board, cols, rows):
        for _ in range(80):
            t = rnd.randrange(7)
            rot = rnd.randrange(4)
            x = rnd.randint(-2, cols)
            y = rnd.randint(-2, rows - 1)
            if not hits(pieces[t][rot], board, cols, rows, x, y):
                return t, rot, x, y
        return None

    cases = {"collide": [], "spin": [], "rotate": [], "lock": [], "attack": [], "seeds": []}
    for _ in range(200):
        cols, rows = rnd.choice(sizes)
        board = rand_board(rnd, cols, rows)
        probes = [[rnd.randrange(7), rnd.randrange(4), rnd.randint(-3, cols + 2), rnd.randint(-3, rows + 2)] for _ in range(12)]
        full = [y for y in range(rows) if all(ch != "0" for ch in board[y])]
        clear = full if rnd.random() < 0.6 else [rnd.randrange(rows)]
        cases["collide"].append({"cols": cols, "rows": rows, "board": board, "probes": probes, "clear": clear})
    # perfect-clear shaped boards: nothing but complete rows
    for _ in range(40):
        cols, rows = rnd.choice(sizes)
        n = rnd.randint(1, min(4, rows))
        board = ["0" * cols] * (rows - n) + ["1" * cols] * n
        if rnd.random() < 0.4:
            y = rnd.randrange(rows)
            board[y] = board[y][:-1] + "2" if board[y][-1] == "0" else board[y][:-1] + "0"
        full = [y for y in range(rows) if all(ch != "0" for ch in board[y])]
        cases["collide"].append({"cols": cols, "rows": rows, "board": board, "probes": [], "clear": full})
    for kind in ("spin", "rotate"):
        target = 700
        while len(cases[kind]) < target:
            cols, rows = rnd.choice(sizes)
            board = rand_board(rnd, cols, rows)
            fp = free_piece(board, cols, rows)
            if not fp:
                continue
            t, rot, x, y = fp
            c = {"cols": cols, "rows": rows, "board": board, "type": t, "rot": rot, "x": x, "y": y}
            if kind == "spin":
                c["lk"] = None if rnd.random() < 0.4 else [rnd.randrange(5), rnd.choice([1, -1, 0])]
            else:
                c["kind"] = rnd.choice([1, -1, 2])
            cases[kind].append(c)
    spins = [None, {"mini": True}, {"mini": False}]
    for _ in range(600):
        cases["lock"].append([rnd.randint(0, 4), rnd.choice(spins), rnd.randint(1, 25), rnd.randint(-1, 14), rnd.randint(0, 9), rnd.random() < 0.15])
    for _ in range(500):
        lines = rnd.randint(0, 4)
        # After a clear the combo counter is never below 0; with no clear it is -1.
        combo_after = rnd.randint(0, 40) if lines else -1
        cases["attack"].append([lines, rnd.choice(spins), rnd.random() < 0.15, rnd.randint(0, 9), combo_after])
    cases["seeds"] = [0, 1, 2, 7, 42, 1337, 123456789, 4294967295, 20261110]
    return cases


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--disable-gpu"])
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route("**/*", lambda r: r.continue_() if r.request.url.startswith(("file:", "data:", "blob:")) else r.fulfill(status=200, body="", content_type="text/css"))
        page.goto(LEGACY.resolve().as_uri(), wait_until="load")
        pieces = page.evaluate("() => PIECES.map(p => p.cells)")
        cases = make_cases(pieces)
        expected = page.evaluate(RUN_JS, cases)
        browser.close()
    if errors:
        raise SystemExit("legacy page errors: %s" % errors)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"seed": SEED, "cases": cases, "expected": expected}, separators=(",", ":")))
    n = sum(len(v) for k, v in cases.items())
    print("wrote %s (%d bytes, %d cases)" % (OUT.relative_to(ROOT), OUT.stat().st_size, n))


if __name__ == "__main__":
    main()
