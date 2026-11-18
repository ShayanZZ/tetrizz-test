// @ts-nocheck
import { log } from "../core/logger";
import { storage } from "../core/storage";
import { VS, deepCopy } from "../core/config";
import { renderBindLists } from "../ui/settings";

export const bindingsState = {
  bindings: {},
  reverse: {},
  mouseEnabled: false,
  mouseSteerOn: true,
  ghostMode: "gray",
  ghostOpacity: 50,
  bgEnabled: true,
  touchBtnsOn: true,
  swipeOn: true,
  listening: null,
  pending: null,
  confirmCb: null,
  cancelCb: null,
  lastBindAt: 0,
  noteT: null,
  editNoteT: null,
  menuView: undefined,
  ctrlDev: undefined,
  openOverlayEl: undefined,
  KEYNAME: undefined,
  PADBTN: undefined,
};

export const ACTIONS = [
  { id: "moveLeft", label: "MOVE LEFT", mode: "hold" },
  { id: "moveRight", label: "MOVE RIGHT", mode: "hold" },
  { id: "softDrop", label: "SOFT DROP", mode: "hold" },
  { id: "hardDrop", label: "HARD DROP", mode: "press" },
  { id: "rotateCW", label: "ROTATE CW", mode: "press" },
  { id: "rotateCCW", label: "ROTATE CCW", mode: "press" },
  { id: "rotate180", label: "ROTATE 180", mode: "press" },
  { id: "holdPiece", label: "HOLD", mode: "press" },
  { id: "pause", label: "PAUSE", mode: "press" },
  { id: "restart", label: "RESTART", mode: "press" },
  { id: "mute", label: "MUTE", mode: "press" },
  { id: "editBoard", label: "EDIT (PRACTICE)", mode: "press" },
];

export const ACTION_MAP = {};

export const PLAY_ONLY = new Set([
  "moveLeft",
  "moveRight",
  "softDrop",
  "hardDrop",
  "rotateCW",
  "rotateCCW",
  "rotate180",
  "holdPiece",
]);

const KEY_DEFAULTS = {
  moveLeft: [{ t: "key", code: "ArrowLeft" }],
  moveRight: [{ t: "key", code: "ArrowRight" }],
  softDrop: [{ t: "key", code: "ArrowDown" }],
  hardDrop: [{ t: "key", code: "Space" }],
  rotateCW: [
    { t: "key", code: "KeyX" },
    { t: "key", code: "ArrowUp" },
  ],
  rotateCCW: [{ t: "key", code: "KeyZ" }],
  rotate180: [{ t: "key", code: "KeyA" }],
  holdPiece: [
    { t: "key", code: "KeyC" },
    { t: "key", code: "ShiftLeft" },
    { t: "key", code: "ShiftRight" },
  ],
  pause: [
    { t: "key", code: "KeyP" },
    { t: "key", code: "Escape" },
  ],
  restart: [{ t: "key", code: "KeyR" }],
  mute: [{ t: "key", code: "KeyM" }],
  editBoard: [{ t: "key", code: "KeyE" }],
};

const MOUSE_DEFAULTS = {
  hardDrop: [{ t: "mouse", b: 0 }],
  rotateCW: [{ t: "mouse", b: 2 }],
  rotateCCW: [{ t: "mouse", b: 1 }],
  rotate180: [{ t: "mouse", b: 4 }],
  holdPiece: [{ t: "mouse", w: -1 }],
  softDrop: [{ t: "mouse", w: 1 }],
};

const PAD_DEFAULTS = {
  moveLeft: [
    { t: "pad", b: 14 },
    { t: "pad", axis: 0, dir: -1 },
  ],
  moveRight: [
    { t: "pad", b: 15 },
    { t: "pad", axis: 0, dir: 1 },
  ],
  softDrop: [
    { t: "pad", b: 13 },
    { t: "pad", axis: 1, dir: 1 },
    { t: "pad", b: 6 },
  ],
  hardDrop: [
    { t: "pad", b: 12 },
    { t: "pad", axis: 1, dir: -1 },
    { t: "pad", b: 7 },
  ],
  rotateCW: [
    { t: "pad", b: 1 },
    { t: "pad", b: 5 },
  ],
  rotateCCW: [{ t: "pad", b: 0 }],
  rotate180: [{ t: "pad", b: 3 }],
  holdPiece: [
    { t: "pad", b: 2 },
    { t: "pad", b: 4 },
  ],
  pause: [{ t: "pad", b: 9 }],
};

export const heldSet = new Set();

function prettyKey(code) {
  if (bindingsState.KEYNAME[code]) return bindingsState.KEYNAME[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "NUM" + code.slice(6);
  return code;
}

export function prettyDesc(d) {
  if (d.t === "key") return prettyKey(d.code);
  if (d.t === "mouse") {
    if (typeof d.w === "number") return (d.w > 0 ? "WHEEL ▼" : "WHEEL ▲") + VS;
    const names = { 0: "LEFT", 1: "MID", 2: "RIGHT", 3: "BACK", 4: "FWD" };
    return "MOUSE " + (names[d.b] || "B" + d.b);
  }
  if (typeof d.axis === "number") {
    const horiz = d.axis === 0;
    const arrow = horiz ? (d.dir < 0 ? "STICK ◀" : "STICK ▶") : d.dir < 0 ? "STICK ▲" : "STICK ▼";
    return arrow + VS;
  }
  return bindingsState.PADBTN[d.b] || "GP B" + d.b;
}

export function devOf(d) {
  if (d.t === "key") return "key";
  if (d.t === "pad") return "pad";
  return "mouse";
}

export function descKey(d) {
  if (d.t === "key") return "k:" + d.code;
  if (d.t === "mouse") return typeof d.w === "number" ? "m:w" + d.w : "m:b" + d.b;
  return typeof d.axis === "number" ? "p:a" + d.axis + ":" + d.dir : "p:b" + d.b;
}

function isValidDesc(d) {
  if (!d) return false;
  if (d.t === "key") return typeof d.code === "string";
  if (d.t === "mouse") return typeof d.b === "number" || typeof d.w === "number";
  if (d.t === "pad")
    return typeof d.b === "number" || (typeof d.axis === "number" && typeof d.dir === "number");
  return false;
}

export function rebuildReverse() {
  bindingsState.reverse = {};
  for (const a of ACTIONS) {
    for (const d of bindingsState.bindings[a.id]) {
      bindingsState.reverse[descKey(d)] = a.id;
    }
  }
}

export function saveBindings() {
  try {
    storage.set("tetris_bindings", JSON.stringify(bindingsState.bindings));
  } catch (_) {
    log.debug("input/bindings.saveBindings", _);
  }
}

export function fillMissing(b) {
  for (const a of ACTIONS) {
    const hasMouse = b[a.id].some((d) => d.t === "mouse");
    if (bindingsState.mouseEnabled && !hasMouse && MOUSE_DEFAULTS[a.id])
      b[a.id].push(...deepCopy(MOUSE_DEFAULTS[a.id]));
    const hasPad = b[a.id].some((d) => d.t === "pad");
    if (!hasPad && PAD_DEFAULTS[a.id]) b[a.id].push(...deepCopy(PAD_DEFAULTS[a.id]));
  }
}

export function freshBindings() {
  const b = {};
  for (const a of ACTIONS) b[a.id] = deepCopy(KEY_DEFAULTS[a.id] || []);
  fillMissing(b);
  return b;
}

export function loadBindings() {
  let stored = null,
    ver = 0;
  try {
    ver = parseInt(storage.get("tetris_bindings_ver")) || 0;
  } catch (_) {
    log.debug("input/bindings.loadBindings", _);
  }
  try {
    stored = JSON.parse(storage.get("tetris_bindings"));
  } catch (_) {
    log.debug("input/bindings.loadBindings#2", _);
  }
  if (stored && typeof stored === "object") {
    const b = {};
    for (const a of ACTIONS) {
      b[a.id] = Array.isArray(stored[a.id])
        ? stored[a.id].filter(isValidDesc)
        : deepCopy(KEY_DEFAULTS[a.id] || []);
    }
    if (ver < 2) {
      b.rotate180 = b.rotate180.filter((d) => d.t !== "mouse");
      b.holdPiece = b.holdPiece.filter((d) => d.t !== "mouse");
    }
    fillMissing(b);
    return b;
  }
  return freshBindings();
}

export function resetBindingsForDev(dev) {
  const src = dev === "key" ? KEY_DEFAULTS : dev === "mouse" ? MOUSE_DEFAULTS : PAD_DEFAULTS;
  for (const a of ACTIONS) {
    const others = bindingsState.bindings[a.id].filter((d) => devOf(d) !== dev);
    const def = src[a.id] ? deepCopy(src[a.id]) : [];
    bindingsState.bindings[a.id] = others.concat(def);
  }
  rebuildReverse();
  saveBindings();
  renderBindLists();
}
