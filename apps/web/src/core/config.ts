// @ts-nocheck
import { versusLobbyState } from "../versus/lobby";
import { perfState } from "./metrics";

export const configState = {
  gaugeWeak: new WeakMap(),
  COLS: 10,
  VIS: 20,
  ROWS: undefined,
  _balancePending: false,
  practice: undefined,
  practiceNextGarbage: 0,
  mode: "endless",
  DAS: undefined,
  ARR: undefined,
  sdfIdx: undefined,
  fxStrength: undefined,
  clearFx: undefined,
  gridVis: undefined,
  colorTheme: "classic",
  swipeSens: 5,
  blockShape: "rounded",
  blockStyle: "matt",
};

export const dims = {
  get cols() {
    return configState.COLS;
  },
  get rows() {
    return configState.ROWS;
  },
};

export const setDVH = () => {
  document.documentElement.style.setProperty("--dvh", window.innerHeight + "px");
};

export const HID = 3;

configState.ROWS = configState.VIS + HID;

export const LOCK_MS = 500,
  MAX_RESETS = 15,
  SPRINT_LINES = 40,
  ULTRA_MS = 120000;

export const MODE_SET = new Set(["endless", "ultra", "sprint", "wide", "practice", "vsbot"]);

export const PRACTICE_DEFAULTS = {
  level: 1,
  levelUp: true,
  garbage: 0,
  mess: 25,
  disableHold: false,
  infiniteHold: false,
  disableLock: false,
  width: 10,
  height: 20,
  autoGarbage: false,
  autoIntervalMin: 8,
  autoIntervalMax: 15,
  autoMin: 1,
  autoMax: 4,
  boards: [],
  boardSel: -1,
  startExtras: null,
};

configState.practice = { ...PRACTICE_DEFAULTS };

export function colsForMode(m) {
  if (m === "wide") return 4;
  if (m === "practice") return configState.practice.width;
  if (m === "vsbot")
    return versusLobbyState.vs !== undefined && versusLobbyState.vs.submode === "wide" ? 4 : 10;
  return 10;
}

export function visForMode(m) {
  if (m === "practice") return configState.practice.height;
  if (m === "wide") return 26;
  if (m === "vsbot")
    return versusLobbyState.vs !== undefined && versusLobbyState.vs.submode === "wide" ? 26 : 20;
  return 20;
}

export const DEFAULTS = { das: 150, arr: 30, sdf: 3, fx: 60, clearFx: 60, grid: 60 };

configState.DAS = DEFAULTS.das;

configState.ARR = DEFAULTS.arr;

configState.sdfIdx = DEFAULTS.sdf;

configState.fxStrength = DEFAULTS.fx;

configState.clearFx = DEFAULTS.clearFx;

configState.gridVis = DEFAULTS.grid;

configState.motion = "auto";

/** Which online backend is tried first: `auto` or one of the configured ones. */
configState.onlineBackend = "auto";

/** How much of the clear-particle strength each adaptive quality tier keeps. */
const CLEAR_SCALE_BY_TIER = [1, 0.5, 0];

export const clearScale = () => (configState.clearFx / 60) * CLEAR_SCALE_BY_TIER[perfState.tier];

export const gridScale = () => configState.gridVis / 36;

export const BLOCK_SHAPES = ["rounded", "square", "flat", "circle", "tile"];

export const SHAPE_LABEL = {
  rounded: "ROUNDED",
  square: "SQUARE",
  flat: "FLAT",
  circle: "CIRCLE",
  tile: "TILE",
};

export const BLOCK_FINISHES = ["matt", "bevel", "glossy", "glassy"];

export const FINISH_LABEL = { matt: "MATT", bevel: "BEVEL", glossy: "GLOSSY", glassy: "GLASSY" };

export const HAS_PATH2D = typeof Path2D !== "undefined";

export const SDF_OPTS = [1, 2, 3, 4, 5, 6, Infinity];

export const softMs = () => {
  const f = SDF_OPTS[configState.sdfIdx];
  return f === Infinity ? 0 : Math.round(140 / f);
};

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const lerp = (a, b, t) => a + (b - a) * t;

export const MOBILE = window.matchMedia("(pointer:coarse)");

const OS_REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Reduced-motion choice: "auto" follows the operating system, "on" and "off" override it. */
export const MOTION_MODES = ["auto", "on", "off"];

export const isReducedMotion = () =>
  configState.motion === "on" || (configState.motion === "auto" && OS_REDUCED_MOTION.matches);

export const deepCopy = (o) => JSON.parse(JSON.stringify(o));

export const VS = "\uFE0E";

export const noop = () => {};
