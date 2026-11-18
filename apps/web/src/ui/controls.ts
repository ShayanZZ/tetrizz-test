// @ts-nocheck
import { clock } from "../core/clock";
import { log } from "../core/logger";
import { MOBILE, configState, noop, softMs } from "../core/config";
import { ACTION_MAP, PLAY_ONLY, bindingsState, heldSet } from "../input/bindings";
import { game, input, recomputeSoft } from "../game/state";
import { curCells, execGesture, execGestureSt, fx } from "../engine/engine";
import {
  $,
  beginRestartHold,
  cancelRestartHold,
  clampPractice,
  layoutState,
  savePractice,
} from "./layout";
import { movePiece, tryRotate } from "../render/render";
import {
  doHold,
  hardDrop,
  softInstant,
  softStep,
  startCountdown,
  toggleMute,
  togglePause,
} from "../game/game";
import { refreshOpts, showEditNote } from "./settings";
import { toggleEdit } from "../practice/practice";
import { activateStepButton, refreshPractice, startStepHold } from "../practice/snapshot";
import {
  MP,
  clampVs,
  mpSplitMob,
  refreshVs,
  saveVs,
  setBotStepValue,
  versusLobbyState,
} from "../versus/lobby";
import {
  stHardDrop,
  stHold,
  stMove,
  stPressDir,
  stReleaseDir,
  stRotate,
  stSoftInstant,
  stSoftStep,
} from "../versus/stations";
import { onlineSessionState } from "../net/online-session";

const controlsState = {
  swPtrs: new Map(),
};

export const stepPress = {
  btn: null,
  pid: null,
  sx: 0,
  sy: 0,
  confirmT: null,
  activated: false,
  cancelled: false,
};

export const STEP_CONFIRM_MS = 120,
  STEP_MOVE_TOL = 10;

export function stepPressReset() {
  if (stepPress.confirmT) {
    clearTimeout(stepPress.confirmT);
    stepPress.confirmT = null;
  }
  stepPress.btn = null;
  stepPress.pid = null;
  stepPress.activated = false;
  stepPress.cancelled = false;
}

export function stepPressActivate(btn) {
  btn.dataset.ph = "1";
  activateStepButton(btn);
  startStepHold(btn);
  stepPress.activated = true;
}

export function closeActiveValueEditor() {
  if (game.activeValueFinish) {
    const f = game.activeValueFinish;
    f();
  }
}

export function openValueEditor(val, step) {
  if (val.querySelector("input")) return;
  const isT = !!step.dataset.t;
  const isV = !!step.dataset.v;
  const isB = step.hasAttribute("data-bot-step");
  const botSlot = isB ? +step.dataset.slot : -1;
  const key = isT ? step.dataset.t : isV ? step.dataset.v : isB ? step.dataset.key : step.dataset.s;
  if (step.dataset.min === undefined) return;
  const min = +step.dataset.min,
    max = +step.dataset.max;
  const useFloat =
    (isV &&
      (step.hasAttribute("data-float") ||
        step.dataset.unit === "s" ||
        ["pps", "grav", "gravInc", "gMult", "gInc"].indexOf(key) >= 0)) ||
    (isB && key === "pps");
  const get = () => {
    if (isT) return configState.practice[key];
    if (isB) {
      const p = versusLobbyState.vs.players[botSlot];
      return p ? p[key] || versusLobbyState.vs[key] : 0;
    }
    if (isV) {
      let v = versusLobbyState.vs[key];
      if (step.dataset.unit === "s") v = v / 1000;
      return v;
    }
    if (key === "das") return configState.DAS;
    if (key === "arr") return configState.ARR;
    if (key === "fx") return configState.fxStrength;
    if (key === "clearFx") return configState.clearFx;
    if (key === "grid") return configState.gridVis;
    if (key === "ghostOpacity") return bindingsState.ghostOpacity;
    return 0;
  };
  const apply = (n) => {
    if (isT) {
      configState.practice[key] = n;
      clampPractice();
      savePractice();
    } else if (isB) {
      setBotStepValue(botSlot, key, n);
    } else if (isV) {
      let v = n;
      if (step.dataset.unit === "s") v = Math.round(n * 1000);
      versusLobbyState.vs[key] = v;
      clampVs();
      saveVs();
    } else {
      if (key === "das") configState.DAS = n;
      else if (key === "arr") configState.ARR = n;
      else if (key === "fx") configState.fxStrength = n;
      else if (key === "clearFx") configState.clearFx = n;
      else if (key === "grid") configState.gridVis = n;
      else if (key === "ghostOpacity") bindingsState.ghostOpacity = n;
    }
  };
  const refresh = isT ? refreshPractice : isV || isB ? refreshVs : refreshOpts;
  const orig = get();
  const inp = document.createElement("input");
  inp.type = "text";
  inp.inputMode = "decimal";
  inp.value = String(orig);
  val.textContent = "";
  val.appendChild(inp);
  let done = false;
  const finishWith = (v) => {
    if (done) return;
    done = true;
    game.activeValueFinish = null;
    if (inp.parentNode) inp.remove();
    val.textContent = String(v);
    refresh();
  };
  const parse = () => {
    const r = inp.value.trim();
    const n = useFloat ? parseFloat(r) : parseInt(r, 10);
    return r !== "" && !isNaN(n) ? n : null;
  };
  const commitOrStay = () => {
    if (done) return false;
    const n = parse();
    if (n === null || n < min || n > max) {
      inp.classList.remove("bad");
      void inp.offsetWidth;
      inp.classList.add("bad");
      showEditNote("Enter a number between " + min + " and " + max);
      return false;
    }
    apply(n);
    finishWith(n);
    return true;
  };
  const finalize = () => {
    if (done) return;
    const n = parse();
    if (n !== null && n >= min && n <= max) {
      apply(n);
      finishWith(n);
    } else finishWith(orig);
  };
  game.activeValueFinish = finalize;
  inp.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      commitOrStay();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finalize();
    }
  });
  inp.addEventListener("blur", () => {
    finalize();
  });
  setTimeout(() => {
    try {
      inp.focus();
      inp.select();
    } catch (_) {
      log.debug("ui/controls.openValueEditor", _);
    }
  }, 0);
}

const PRESS = {
  rotateCW: () => {
    if (game.state === "playing") tryRotate(1);
  },
  rotateCCW: () => {
    if (game.state === "playing") tryRotate(-1);
  },
  rotate180: () => {
    if (game.state === "playing") tryRotate(2);
  },
  hardDrop: () => hardDrop(),
  holdPiece: () => doHold(),
  pause: () => togglePause(),
  restart: () => {
    if (game.state === "countdown") startCountdown();
    else if (game.state === "playing" || game.state === "over") beginRestartHold();
  },
  mute: () => toggleMute(),
  editBoard: () => {
    if (configState.mode === "practice") toggleEdit();
  },
};

const HOLD_DOWN = {
  moveLeft: () => pressDir(-1),
  moveRight: () => pressDir(1),
  softDrop: () => {
    game.softHeld = true;
    recomputeSoft();
    if (game.state === "playing") {
      if (softMs() === 0) softInstant();
      else softStep();
    }
  },
};

const HOLD_UP = {
  moveLeft: () => releaseDir(-1),
  moveRight: () => releaseDir(1),
  softDrop: () => {
    game.softHeld = false;
    recomputeSoft();
  },
};

export function fireDown(id) {
  const a = ACTION_MAP[id];
  if (!a) return;
  if (a.mode === "press") {
    if (!PLAY_ONLY.has(id) || game.state === "playing") (PRESS[id] || noop)();
  } else {
    if (game.state !== "playing") return;
    if (heldSet.has(id)) return;
    heldSet.add(id);
    (HOLD_DOWN[id] || noop)();
  }
}

export function fireUp(id) {
  const a = ACTION_MAP[id];
  if (!a) return;
  if (a.mode !== "press") {
    if (!heldSet.has(id)) return;
    heldSet.delete(id);
    (HOLD_UP[id] || noop)();
  }
}

export function pressDir(d) {
  if (d < 0) input.left = true;
  else input.right = true;
  input.dir = d;
  input.dasT = 0;
  input.arrT = 0;
  if (game.state === "playing") movePiece(d);
}

export function releaseDir(d) {
  if (d < 0) input.left = false;
  else input.right = false;
  if (input.dir === d) {
    if (d < 0 && input.right) {
      input.dir = 1;
      input.dasT = 0;
      input.arrT = 0;
      if (game.state === "playing") movePiece(1);
    } else if (d > 0 && input.left) {
      input.dir = -1;
      input.dasT = 0;
      input.arrT = 0;
      if (game.state === "playing") movePiece(-1);
    } else {
      input.dir = 0;
      fx.tx = 0;
    }
  }
}

export function playRegion(t) {
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) return false;
  return (
    t &&
    !t.closest(
      "header, .overlay, #touch, #touch2, .practice-panel, .practice-btn, .col, .panel, .cf-modal, #pieceModal, button, a, input, select, textarea",
    )
  );
}

export function gameRegion(t) {
  return t && !t.closest(".overlay, .cf-modal, #pieceModal, header");
}

export function inOverlay(t) {
  return !!(t && t.closest && t.closest(".overlay, .cf-modal, #pieceModal"));
}

export function steerWithMouse(clientX) {
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) return;
  if (game.state !== "playing" || !game.piece) return;
  const rect = layoutState.wrap.getBoundingClientRect();
  const cell = rect.width / Math.max(1, configState.COLS);
  if (cell <= 0) return;
  const cells = curCells();
  let minc = 99,
    maxc = -99;
  for (const [cx] of cells) {
    if (cx < minc) minc = cx;
    if (cx > maxc) maxc = cx;
  }
  const centerOffset = (minc + maxc + 1) / 2;
  const fcol = (clientX - rect.left) / cell;
  const target = Math.round(fcol - centerOffset);
  let guard = 0;
  while (game.piece.x < target && guard++ < configState.COLS) {
    if (!movePiece(1)) break;
  }
  guard = 0;
  while (game.piece.x > target && guard++ < configState.COLS) {
    if (!movePiece(-1)) break;
  }
}

export function mpKeyStation() {
  if (!versusLobbyState.vsActive) return null;
  for (const st of MP.stations) {
    const c = versusLobbyState.vs.players[st.slot];
    if (!st.isBot && c.type === "user" && c.dev === "key") return st;
  }
  return null;
}

export function mpMouseStation() {
  if (!bindingsState.mouseEnabled || !versusLobbyState.vsActive) return null;
  for (const st of MP.stations) {
    const c = versusLobbyState.vs.players[st.slot];
    if (!st.isBot && c.type === "user" && c.dev === "mouse") return st;
  }
  for (const st of MP.stations) {
    const c = versusLobbyState.vs.players[st.slot];
    if (!st.isBot && c.type === "user" && c.dev === "key") return st;
  }
  return null;
}

export function mpTouchOwner() {
  if (versusLobbyState.vsActive === undefined || !versusLobbyState.vsActive) return null;
  for (const st of MP.stations) {
    const c = versusLobbyState.vs.players[st.slot];
    if (c && c.type === "user" && c.touch) return st;
  }
  return null;
}

export function mpFireDown(st, id) {
  const a = ACTION_MAP[id];
  if (!a) return;
  if (id === "pause") {
    togglePause();
    return;
  }
  if (id === "mute") {
    toggleMute();
    return;
  }
  if (id === "restart") {
    if (game.state === "countdown") startCountdown();
    else beginRestartHold();
    return;
  }
  if (!st || st.isBot || game.state !== "playing") return;
  switch (id) {
    case "moveLeft":
      stPressDir(st, -1);
      break;
    case "moveRight":
      stPressDir(st, 1);
      break;
    case "softDrop":
      st.in.down = true;
      if (softMs() === 0) stSoftInstant(st);
      else stSoftStep(st);
      break;
    case "hardDrop":
      stHardDrop(st);
      break;
    case "rotateCW":
      stRotate(st, 1);
      break;
    case "rotateCCW":
      stRotate(st, -1);
      break;
    case "rotate180":
      stRotate(st, 2);
      break;
    case "holdPiece":
      stHold(st);
      break;
  }
}

export function mpFireUp(st, id) {
  if (id === "restart") {
    cancelRestartHold();
    return;
  }
  if (!st) return;
  if (id === "moveLeft") stReleaseDir(st, -1);
  else if (id === "moveRight") stReleaseDir(st, 1);
  else if (id === "softDrop") st.in.down = false;
}

function mpSteerToClientX(clientX) {
  const st = mpMouseStation();
  if (!st || st.isBot || game.state !== "playing" || !st.piece) return;
  const r = st.wrapEl.getBoundingClientRect();
  const cell = r.width / Math.max(1, configState.COLS);
  if (cell <= 0) return;
  const cells = st.piece.cells;
  let minc = 99,
    maxc = -99;
  for (const q of cells) {
    if (q[0] < minc) minc = q[0];
    if (q[0] > maxc) maxc = q[0];
  }
  const centerOffset = (minc + maxc + 1) / 2;
  const fcol = (clientX - r.left) / cell;
  const target = Math.round(fcol - centerOffset);
  let guard = 0;
  while (st.piece.x < target && guard++ < configState.COLS) {
    if (!stMove(st, 1)) break;
  }
  guard = 0;
  while (st.piece.x > target && guard++ < configState.COLS) {
    if (!stMove(st, -1)) break;
  }
}

export function mpSteer(e) {
  mpSteerToClientX(e.clientX);
}

const mpWheelT = {};

export function mpWheelPulse(st, act) {
  mpFireDown(st, act);
  clearTimeout(mpWheelT[act]);
  mpWheelT[act] = setTimeout(() => mpFireUp(st, act), 140);
}

const DZ = 12,
  UTHR = -34,
  VFAST = 1.4,
  TAP_T = 320,
  TAP_D = 10;

function swipeMidY() {
  if (document.body.classList.contains("splitMob")) {
    const r = layoutState.mainEl.getBoundingClientRect();
    return r.top;
  }
  const hb = layoutState.headerEl.getBoundingClientRect().bottom;
  return hb + (innerHeight - hb) / 2;
}

function swipeRevTop(st) {
  return !!(
    versusLobbyState.vsActive !== undefined &&
    versusLobbyState.vsActive &&
    versusLobbyState.vs.reverse &&
    mpSplitMob() &&
    st &&
    st.idx === 1
  );
}

function swipeStationAt(x, y) {
  if (versusLobbyState.vsActive === undefined || !versusLobbyState.vsActive || !MP.stations.length)
    return null;
  let st;
  if (document.body.classList.contains("splitMob") && MP.stations.length >= 2) {
    let mid = swipeMidY();
    if (!(versusLobbyState.vs !== undefined && versusLobbyState.vs.reverse)) {
      const t2 = $("touch2");
      if (t2 && t2.style.display !== "none") {
        const r = t2.getBoundingClientRect();
        if (r.height > 4) mid = r.top;
      }
    }
    st = y < mid ? MP.stations[1] : MP.stations[0];
  } else st = MP.stations[0];
  if (!st || !st.alive) return null;
  const cfg = versusLobbyState.vs.players[st.slot];
  if (!cfg || cfg.type !== "user") return null;
  if (!cfg.swipe) return null;
  return st;
}

export function swipeCancelSoft(st) {
  for (const r of controlsState.swPtrs.values()) {
    const match = st ? r.vsSt === st : r.vsSt === null;
    if (match && r.softOn) {
      r.softOn = false;
      r.softLocked = true;
      if (st) mpFireUp(st, "softDrop");
      else {
        game.swipeSoft = false;
        recomputeSoft();
      }
    }
  }
}

export function swipeDown(e) {
  if (!MOBILE.matches || game.editMode) return;
  try {
    if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) return;
  } catch (_) {
    log.debug("ui/controls.swipeDown", _);
  }
  if (
    e.target.closest &&
    e.target.closest(
      "button, input, textarea, select, #touch, #touch2, .overlay, .cf-modal, #pieceModal, kbd",
    )
  )
    return;
  if (e.target.closest && e.target.closest("#touch2")) {
    if (!(
      document.body.classList.contains("splitMob") &&
      !(versusLobbyState.vs !== undefined && versusLobbyState.vs.reverse)
    ))
      return;
  }
  const isVs = versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive;
  const vsSt = isVs ? swipeStationAt(e.clientX, e.clientY) : null;
  if (isVs && !vsSt) return;
  for (const r of controlsState.swPtrs.values()) {
    if (r.vsSt === vsSt) return;
  }
  const inv = swipeRevTop(vsSt);
  const sx = inv ? -e.clientX : e.clientX,
    sy = inv ? -e.clientY : e.clientY;
  controlsState.swPtrs.set(e.pointerId, {
    vsSt: vsSt,
    inv: inv,
    sx: sx,
    sy: sy,
    st: clock.now(),
    axis: null,
    baseX: sx,
    lastX: sx,
    lastY: sy,
    lastT: clock.now(),
    softOn: false,
    softLocked: false,
    hardDone: false,
    done: false,
    moved: false,
    hStepped: false,
  });
  try {
    e.preventDefault();
  } catch (_) {
    log.debug("ui/controls.swipeDown#2", _);
  }
}

export function swipeMove(e) {
  const r = controlsState.swPtrs.get(e.pointerId);
  if (!r || r.done || game.editMode) return;
  const x = r.inv ? -e.clientX : e.clientX,
    y = r.inv ? -e.clientY : e.clientY,
    t = clock.now();
  const dx = x - r.sx,
    dy = y - r.sy;
  if (!r.axis) {
    if (Math.abs(dx) < DZ && Math.abs(dy) < DZ) {
      r.lastT = t;
      try {
        e.preventDefault();
      } catch (_) {
        log.debug("ui/controls.swipeMove", _);
      }
      return;
    }
    r.axis = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
    r.moved = true;
    if (r.axis === "h") r.baseX = x;
  }
  if (r.axis === "h") {
    const _swWrap = r.vsSt && r.vsSt.wrapEl ? r.vsSt.wrapEl : layoutState.wrap;
    const _swCell = _swWrap.clientWidth / Math.max(1, configState.COLS);
    const _swF = Math.max(
      0.2,
      (configState.swipeSens !== undefined ? configState.swipeSens : 5) / 5,
    );
    const HSTEP = Math.max(10, Math.min(60, (_swCell * 0.7) / _swF));
    const _second = HSTEP * 1.8;
    let delta = x - r.baseX;
    if (game.state === "playing") {
      for (;;) {
        const done = r.hR || 0;
        const thr = done === 1 ? _second : HSTEP;
        if (delta < thr) break;
        if (r.vsSt) stMove(r.vsSt, 1);
        else movePiece(1);
        delta -= thr;
        r.baseX += thr;
        r.hR = done + 1;
        r.hStepped = true;
      }
      for (;;) {
        const done = r.hL || 0;
        const thr = done === 1 ? _second : HSTEP;
        if (-delta < thr) break;
        if (r.vsSt) stMove(r.vsSt, -1);
        else movePiece(-1);
        delta += thr;
        r.baseX -= thr;
        r.hL = done + 1;
        r.hStepped = true;
      }
    }
  } else {
    if (game.state === "playing") {
      if (dy <= UTHR) {
        const dt = t - r.lastT,
          ddy = r.lastY - y;
        if (dt >= 8 && ddy >= 8 && ddy / dt > 1.1) {
          if (r.vsSt) execGestureSt(r.vsSt, "flickUp");
          else execGesture("flickUp");
        } else {
          if (r.vsSt) execGestureSt(r.vsSt, "swipeUp");
          else execGesture("swipeUp");
        }
        r.done = true;
        if (r.softOn) {
          r.softOn = false;
          if (r.vsSt) mpFireUp(r.vsSt, "softDrop");
          else {
            game.swipeSoft = false;
            recomputeSoft();
          }
        }
      } else if (dy > 0) {
        const ga = game.gestures.swipeDown;
        if (ga === "soft") {
          if (!r.softLocked) {
            if (!r.softOn) {
              r.softOn = true;
              if (r.vsSt) mpFireDown(r.vsSt, "softDrop");
              else {
                game.swipeSoft = true;
                recomputeSoft();
                if (softMs() === 0) softInstant();
                else softStep();
              }
            }
            const dt = t - r.lastT,
              ddy = y - r.lastY;
            if (dt >= 16 && ddy >= 14 && ddy / dt > VFAST) {
              const fa = game.gestures.flickDown;
              if (r.vsSt) {
                if (fa === "hard") stHardDrop(r.vsSt);
                else if (fa === "soft") stSoftInstant(r.vsSt);
              } else {
                if (fa === "hard") hardDrop();
                else if (fa === "soft") softInstant();
              }
              r.done = true;
            }
          }
        } else if (ga === "hard" && !r.hardDone) {
          if (r.vsSt) stHardDrop(r.vsSt);
          else hardDrop();
          r.hardDone = true;
          r.done = true;
        }
      }
    }
  }
  r.lastX = x;
  r.lastY = y;
  r.lastT = t;
  try {
    e.preventDefault();
  } catch (_) {
    log.debug("ui/controls.swipeMove#2", _);
  }
}

export function swipeUp(e) {
  const r = controlsState.swPtrs.get(e.pointerId);
  if (!r) return;
  controlsState.swPtrs.delete(e.pointerId);
  if (game.editMode) return;
  const x = r.inv ? -e.clientX : e.clientX,
    y = r.inv ? -e.clientY : e.clientY;
  if (!r.vsSt) fx.tx = 0;
  else if (r.vsSt) r.vsSt.fx.tx = 0;
  if (!r.done && !r.moved && clock.now() - r.st < TAP_T) {
    if (Math.hypot(x - r.sx, y - r.sy) < TAP_D && game.state === "playing") {
      if (r.vsSt) execGestureSt(r.vsSt, "tap");
      else execGesture("tap");
    }
  } else if (!r.done && r.axis === "h" && !r.hStepped && game.state === "playing") {
    const dx = x - r.sx;
    if (Math.abs(dx) >= DZ) {
      if (r.vsSt) stMove(r.vsSt, dx > 0 ? 1 : -1);
      else movePiece(dx > 0 ? 1 : -1);
    }
  }
  if (r.softOn) {
    if (r.vsSt) mpFireUp(r.vsSt, "softDrop");
    else {
      game.swipeSoft = false;
      recomputeSoft();
    }
  }
}
