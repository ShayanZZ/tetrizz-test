"""Deterministic heuristic player used by the scripted sessions (works on board + piece shapes only)."""

def _collide(board, cells, x, y):
    rows, cols = len(board), len(board[0])
    for cx, cy in cells:
        X, Y = x + cx, y + cy
        if X < 0 or X >= cols or Y >= rows:
            return True
        if Y >= 0 and board[Y][X]:
            return True
    return False


def _score(board, cells, x, y):
    rows, cols = len(board), len(board[0])
    grid = [row[:] for row in board]
    for cx, cy in cells:
        if 0 <= y + cy < rows:
            grid[y + cy][x + cx] = 1
    full = [i for i, r in enumerate(grid) if all(r)]
    grid = [r for i, r in enumerate(grid) if i not in full]
    grid = [[0] * cols for _ in full] + grid
    heights, holes = [], 0
    for c in range(cols):
        col = [grid[r][c] for r in range(rows)]
        top = next((i for i, v in enumerate(col) if v), rows)
        heights.append(rows - top)
        holes += sum(1 for v in col[top:] if not v)
    bump = sum(abs(heights[i] - heights[i + 1]) for i in range(cols - 1))
    return 0.76 * len(full) - 0.51 * sum(heights) - 0.36 * holes - 0.18 * bump


def plan(board, shapes, ptype):
    """Return (rotations_cw, target_x) for the best landing of piece type ptype."""
    cols = len(board[0])
    best = None
    for rot in range(4):
        cells = shapes[ptype][rot]
        for x in range(-3, cols + 1):
            if _collide(board, cells, x, 0):
                continue
            y = 0
            while not _collide(board, cells, x, y + 1):
                y += 1
            sc = _score(board, cells, x, y)
            if best is None or sc > best[0]:
                best = (sc, rot, x)
    return (best[1], best[2]) if best else (0, 0)
