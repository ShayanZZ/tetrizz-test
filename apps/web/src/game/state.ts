// @ts-nocheck

export const game = {
  board: undefined,
  queue: [],
  hold: null,
  holdUsed: false,
  piece: null,
  score: 0,
  lines: 0,
  level: 1,
  combo: -1,
  maxCombo: 0,
  b2bChain: 0,
  pieces: 0,
  playMs: 0,
  gravMs: 1000,
  gravT: 0,
  partPoolUsed: 0,
  particles: [],
  state: "menu",
  muted: false,
  volume: 80,
  lastTs: 0,
  statAcc: 0,
  CELL: 20,
  MINI: 20,
  countdownRemaining: 0,
  countdownPhase: "",
  pausedFrom: null,
  restartHoldState: { active: false, start: 0, raf: null },
  softHeld: false,
  btnSoft: false,
  swipeSoft: false,
  hist: [],
  redoStack: [],
  editMode: false,
  editTool: "paint",
  editDrawing: false,
  editErase: false,
  editLast: null,
  editPointerId: null,
  editStroke: false,
  editStrokeCells: new Set(),
  pieceModalTarget: null,
  holdRepeat: { timeout: null, interval: null },
  activeValueFinish: null,
  gestures: {
    tap: "rotateCW",
    swipeUp: "rotate180",
    swipeDown: "soft",
    flickDown: "hard",
    flickUp: "hold",
  },
};

export const PART_POOL_SIZE = 512;

export const partPool = [];

export const RESTART_HOLD_MS = 1000;

export const input = { left: false, right: false, down: false, dir: 0, dasT: 0, arrT: 0 };

export function recomputeSoft() {
  input.down = game.softHeld || game.btnSoft || game.swipeSoft;
}

export const GESTURE_ACTS = {
  tap: ["rotateCW", "rotateCCW", "rotate180", "hold", "hard", "none"],
  swipeUp: ["rotate180", "hold", "hard", "rotateCW", "rotateCCW", "none"],
  swipeDown: ["soft", "hard", "none"],
  flickDown: ["hard", "soft", "none"],
  flickUp: ["hold", "hard", "rotateCW", "rotateCCW", "rotate180", "none"],
};

export const GESTURE_ACT_LABEL = {
  rotateCW: "ROT CW",
  rotateCCW: "ROT CCW",
  rotate180: "ROT 180",
  hold: "HOLD",
  hard: "HARD",
  soft: "SOFT",
  none: "NONE",
};
