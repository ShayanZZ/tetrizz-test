// @ts-nocheck
import { clock } from "../core/clock";
import {
  createAdaptiveController,
  frameStats,
  perfState,
  recordFrame,
  resetFrameStats,
} from "../core/metrics";
import { randomHole } from "@tetrizz/core";
import { gameRandom } from "../core/random";
import { escapeHtml } from "../core/escape";
import { log } from "../core/logger";
import { storage } from "../core/storage";
import {
  DEFAULTS,
  LOCK_MS,
  MAX_RESETS,
  MOTION_MODES,
  PRACTICE_DEFAULTS,
  ULTRA_MS,
  clamp,
  configState,
  softMs,
} from "../core/config";
import { emitEvent, isIntercepted } from "../core/events";
import {
  bindingsState,
  fillMissing,
  rebuildReverse,
  resetBindingsForDev,
  saveBindings,
} from "../input/bindings";
import { game, input } from "../game/state";
import { SFX, collide, curCells, cycleGesture, emptyRow, fxStep } from "../engine/engine";
import { $, clampPractice, layoutSoon, layoutState, savePractice, shapeRR } from "./layout";
import { checkDanger, movePiece, updateParticlesArr } from "../render/render";
import {
  gameOver,
  gameState,
  goBack,
  lockPiece,
  menuOpen,
  quitToMenu,
  resumeSession,
  setKbFocus,
  showCtrlPage,
  showScreen,
  softInstant,
  startCountdown,
  syncPad,
  tickCountdown,
  toggleMute,
  togglePause,
} from "../game/game";
import { fmtTime, setText, updateStats } from "./menus";
import {
  askConfirm,
  cancelListen,
  cancelPending,
  clearScores,
  closeCf,
  confirmPending,
  cycleBlockShape,
  cycleBlockStyle,
  cycleColorTheme,
  maybeSpawnFloater,
  onVolChange,
  onVolInput,
  refreshOpts,
  removeBinding,
  renderBindLists,
  renderScoreList,
  resetAction,
  saveAll,
  saveOpts,
  selectMode,
  setTheme,
  settingsState,
  showEditNote,
  showNote,
  snapOpts,
  startListen,
  syncBg,
  syncToggles,
} from "./settings";
import { closePieceModal, mirrorBoard } from "../practice/practice";
import {
  capApply,
  capClose,
  capFreeze,
  capFromCamera,
  capFromScreen,
  capNote,
  capOpen,
  capRetake,
  capShowSources,
  capStopStream,
  captureState,
} from "../practice/capture";
import { bvClose, renderBoardList } from "../practice/board-library";
import { fumenExport, fumenImport } from "../practice/fumen";
import {
  activateStepButton,
  refreshPractice,
  replayToPractice,
  stopStepHold,
} from "../practice/snapshot";
import {
  STEP_CONFIRM_MS,
  STEP_MOVE_TOL,
  closeActiveValueEditor,
  openValueEditor,
  stepPress,
  stepPressActivate,
  stepPressReset,
} from "./controls";
import { VS_DEFAULTS } from "./brand";
import {
  TARGET_OPTS,
  clampVs,
  mpAssignDev,
  mpComputeU,
  mpSetType,
  refreshVs,
  saveVs,
  versusLobbyState,
} from "../versus/lobby";
import { mpRender } from "../versus/stations";
import { botControlState } from "../bot/bot-control";
import { vsFrame, vsStartMatch } from "../versus/rounds";
import { pollGamepad } from "../input/gamepad";
import {
  TOUCH_DEFAULT_ORDER,
  applyTouchPreset,
  deleteTouchPreset,
  drawFieldTo,
  handleTouchEditClick,
  renderTouchBars,
  renderTouchEditor,
  renderTouchPresets,
  resetTouchLayout,
  saveTouchOrder,
  saveTouchPreset,
  touchState,
} from "../input/touch";
import { onlineSessionState } from "../net/online-session";
import {
  lanBackToMain,
  lanReturnToLobby,
  lanState,
  leaveLanMode,
  showLanSetupScreen,
} from "../net/lan";
import { netSend } from "../net/transport";
import { initSupabase, leaveOnlineRoom } from "../net/online-lobby";
import { nextBackendChoice } from "../net/backend-choice";
import { netConfig } from "../net/net-config";
import { backToOnlineLobby, sendOnlineState } from "../net/online-sync";
import {
  downloadReplayFile,
  exitReplay,
  renderReplaysList,
  replayState,
  replayTitle,
  replayTogglePlay,
  rpEntryData,
  saveReplayToStorage,
  startReplay,
  updateReplayUI,
} from "../replay/replay";
import { runInstallFlow } from "./install";

export const screensState = {
  rafCount: 0,
  hiddenTimer: null,
  _hiddenNetLast: 0,
  _hiddenSkip: 0,
  ONLINE_LOBBY_INNER: undefined,
  tipT: null,
};

function handleDas(dt) {
  const d = input.dir;
  if (!d) return;
  if (!(d < 0 ? input.left : input.right)) {
    input.dir = 0;
    return;
  }
  input.dasT += dt;
  if (input.dasT < configState.DAS) return;
  if (configState.ARR === 0) {
    while (movePiece(d)) {}
  } else {
    input.arrT += dt;
    while (input.arrT >= configState.ARR) {
      input.arrT -= configState.ARR;
      if (!movePiece(d)) {
        input.arrT = 0;
        break;
      }
    }
  }
}

export function rndHole(exclude) {
  return randomHole(configState.COLS, exclude, gameRandom);
}

export function addGarbage(n, mess) {
  if (n <= 0) return;
  let prevHole = -1;
  for (let i = 0; i < n; i++) {
    const same = prevHole < 0 ? false : gameRandom() > mess / 100;
    const hole = same ? prevHole : rndHole(prevHole);
    prevHole = hole;
    const row = emptyRow();
    for (let x = 0; x < configState.COLS; x++) if (x !== hole) row[x] = 8;
    game.board.shift();
    game.board.push(row);
  }
  checkDanger();
}

function injectGarbage(n, mess) {
  if (n <= 0) return;
  addGarbage(n, mess);
  if (game.piece && collide(curCells(), game.piece.x, game.piece.y)) {
    let guard = 0;
    while (collide(curCells(), game.piece.x, game.piece.y) && guard++ < configState.ROWS + 10)
      game.piece.y--;
    if (collide(curCells(), game.piece.x, game.piece.y)) gameOver();
  }
}

export function randPracticeInterval() {
  const mn = configState.practice.autoIntervalMin,
    mx = configState.practice.autoIntervalMax;
  return (mn + gameRandom() * (mx - mn)) * 1000;
}

function update(dt) {
  game.playMs += dt;
  game.statAcc += dt;
  if (configState.mode === "ultra") {
    if (game.playMs >= ULTRA_MS) {
      game.playMs = ULTRA_MS;
      updateStats();
      gameOver();
      return;
    }
    setText(layoutState.elTime, fmtTime(Math.max(0, ULTRA_MS - game.playMs)));
  }
  if (game.statAcc > 250) {
    game.statAcc = 0;
    updateStats();
  }
  if (configState.mode === "practice" && configState.practice.autoGarbage && game.piece) {
    if (game.playMs >= configState.practiceNextGarbage) {
      const mn = Math.min(configState.practice.autoMin, configState.practice.autoMax),
        mx = Math.max(configState.practice.autoMin, configState.practice.autoMax);
      const n = mn + Math.floor(gameRandom() * (mx - mn + 1));
      if (n > 0) injectGarbage(n, configState.practice.mess);
      configState.practiceNextGarbage = game.playMs + randPracticeInterval();
    }
  }
  if (!game.piece) return;
  if (!collide(curCells(), game.piece.x, game.piece.y + 1)) game.piece.softSounded = false;
  handleDas(dt);
  const sdf = softMs();
  let guard = 0;
  if (input.down) {
    if (sdf === 0) {
      if (!collide(curCells(), game.piece.x, game.piece.y + 1)) softInstant();
    } else {
      game.gravT += dt;
      let moved = 0;
      while (game.gravT >= sdf && guard++ < 240) {
        game.gravT -= sdf;
        if (!collide(curCells(), game.piece.x, game.piece.y + 1)) {
          game.piece.y++;
          game.score++;
          moved++;
          game.piece.lastRotate = null;
        } else {
          game.gravT = 0;
          break;
        }
      }
      if (moved && collide(curCells(), game.piece.x, game.piece.y + 1) && !game.piece.softSounded) {
        game.piece.softSounded = true;
        SFX.soft();
      }
    }
  } else {
    if (!isFinite(game.gravMs)) game.gravT = 0;
    else {
      game.gravT += dt;
      while (game.gravT >= game.gravMs && guard++ < 80) {
        game.gravT -= game.gravMs;
        if (!collide(curCells(), game.piece.x, game.piece.y + 1)) {
          game.piece.y++;
          game.piece.lastRotate = null;
        } else {
          game.gravT = 0;
          break;
        }
      }
    }
  }
  if (collide(curCells(), game.piece.x, game.piece.y + 1)) {
    const unlimited = configState.mode === "practice" && configState.practice.disableLock;
    if (!unlimited && game.piece.lockResets >= MAX_RESETS) lockPiece(false);
    else {
      game.piece.lockT += dt;
      if (game.piece.lockT >= LOCK_MS) lockPiece(false);
    }
  } else game.piece.lockT = 0;
  updateParticlesArr(game.particles, dt / 1000);
}

export function drawGhostCellShape(c, px, py, s, gcol) {
  const gAlpha = bindingsState.ghostOpacity / 100;
  shapeRR(c, px, py, s, s, configState.blockShape);
  c.save();
  c.globalAlpha = gAlpha * 0.4;
  c.fillStyle = gcol;
  c.fill();
  c.restore();
  shapeRR(c, px, py, s, s, configState.blockShape);
  c.save();
  c.globalAlpha = Math.min(1, gAlpha * 1.2);
  c.strokeStyle = gcol;
  c.lineWidth = 2;
  c.stroke();
  c.restore();
}

export function render() {
  if (document.hidden) return;
  drawFieldTo(
    layoutState.g,
    game.board,
    game.piece,
    game.particles,
    game.CELL,
    layoutState.vw,
    layoutState.vh + 2 * game.CELL,
    layoutState.wrap.classList.contains("danger"),
    collide,
  );
}

function tick(ts) {
  if (isIntercepted("tick", ts)) return;
  tzTickBody(ts);
  emitEvent("tick", ts);
}

/** Longest simulation step. A longer frame is simulated as several equal steps of at most this. */
const MAX_STEP_MS = 50;
/** Most game time simulated for one drawn frame; slower frames run the game slower than real time. */
const MAX_FRAME_MS = 250;
/**
 * While the page is hidden nothing is drawn and the background timer ticks only every 300 ms, so
 * each tick has to cover its whole interval, in steps as short as a 60 Hz frame: bots do one thing
 * per step, and longer steps would cap how fast they can play.
 */
const HIDDEN_STEP_MS = 1000 / 60;
/** Most game time simulated per tick of the background timer (a late timer is still caught up). */
const MAX_HIDDEN_FRAME_MS = 1000;

/** How many equal steps a frame of `dt` milliseconds is simulated in. */
function stepsFor(dt) {
  const longest = document.hidden ? HIDDEN_STEP_MS : MAX_STEP_MS;
  return dt > longest ? Math.ceil(dt / longest) : 1;
}

function tzTickBody(ts) {
  let dt = ts - game.lastTs;
  if (
    !document.hidden &&
    (game.state === "menu" || (game.state === "over" && !gameState.goTextActive)) &&
    dt < 33
  )
    return;
  game.lastTs = ts;
  const longestFrame = document.hidden ? MAX_HIDDEN_FRAME_MS : MAX_FRAME_MS;
  if (dt > longestFrame) dt = longestFrame;
  if (dt < 0) dt = 0;
  if (layoutState.vw < 2 && (game.state === "playing" || game.state === "countdown"))
    layoutSoon(150);
  const steps = stepsFor(dt);
  const stepMs = dt / steps;
  const versusOn = versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive;
  if (versusOn) {
    for (let i = 0; i < steps; i++) {
      botControlState.thinkSlice = i === 0;
      vsFrame(stepMs, i === steps - 1);
    }
    botControlState.thinkSlice = true;
  }
  if (game.state === "playing") {
    if (!versusOn) {
      for (let i = 0; i < steps && game.state === "playing"; i++) update(stepMs);
      render();
    }
  } else if (game.state === "countdown") {
    for (let i = 0; i < steps && game.state === "countdown"; i++) tickCountdown(stepMs);
    updateParticlesArr(game.particles, dt / 1000);
    if (!versusOn) render();
  } else if (game.state === "editing") render();
  else if (game.state === "vsround") {
    if (!versusOn) render();
  }
  if (
    versusOn &&
    (game.state === "playing" ||
      game.state === "countdown" ||
      game.state === "vsround" ||
      game.state === "over")
  )
    mpRender();
  maybeSpawnFloater(dt);
  pollGamepad(dt);
  fxStep(dt / 1000);
}

const adaptive = createAdaptiveController();
let adaptiveNextCheck = 0;

/** About once a second during play: lowers effects while frames stay slow, restores them when fast. */
function adaptiveStep(now) {
  if (now < adaptiveNextCheck) return;
  adaptiveNextCheck = now + 1000;
  if (!perfState.adaptive) {
    if (perfState.tier !== 0) {
      perfState.tier = 0;
      adaptive.reset();
      resetFrameStats();
    }
    return;
  }
  if (document.hidden || game.state !== "playing") return;
  const stats = frameStats();
  if (stats.frames < 60) return;
  const tier = adaptive.check(stats.medianMs);
  if (tier !== perfState.tier) {
    perfState.tier = tier;
    resetFrameStats();
    log.debug("screens.adaptiveTier", tier, stats.medianMs);
  }
}

export function frame(ts) {
  if (screensState.rafCount > 0) screensState.rafCount--;
  const _fNow = clock.now();
  botControlState._frameGap = _fNow - botControlState._lastFrameTs;
  botControlState._lastFrameTs = _fNow;
  try {
    tick(ts);
  } catch (err) {
    const _n = clock.now();
    if (!frame._eT || _n - frame._eT > 2000) {
      frame._eT = _n;
      console.error("[TetriZZ] frame error:", err);
    }
  }
  botControlState._frameWork = clock.now() - _fNow;
  recordFrame(botControlState._frameGap, botControlState._frameWork);
  adaptiveStep(_fNow);
  if (!document.hidden) {
    screensState.rafCount++;
    requestAnimationFrame(frame);
  }
}

export function scheduleVisibleFrame() {
  if (document.hidden) return;
  if (screensState.rafCount === 0) {
    screensState.rafCount = 1;
    requestAnimationFrame(frame);
  }
}

export function startHiddenLoop() {
  if (screensState.hiddenTimer) return;
  try {
    const blob = new Blob(["setInterval(()=>postMessage(0),100);"], {
      type: "text/javascript",
    });
    const _blobUrl = URL.createObjectURL(blob);
    screensState.hiddenTimer = new Worker(_blobUrl);
    screensState.hiddenTimer._blobUrl = _blobUrl;
    screensState.hiddenTimer.onmessage = () => {
      if (document.hidden) {
        if (screensState._hiddenSkip < 2) {
          screensState._hiddenSkip++;
          return;
        }
        screensState._hiddenSkip = 0;
        tick(clock.now());
        const _n = clock.wall();
        if (_n - screensState._hiddenNetLast >= 1000) {
          screensState._hiddenNetLast = _n;
          sendOnlineState(true);
          if (onlineSessionState.onlineRoomId)
            netSend("hb", { sender: onlineSessionState.myPlayerId });
        }
      }
    };
  } catch (e) {
    screensState.hiddenTimer = setInterval(() => {
      if (document.hidden) {
        tick(clock.now());
        const _n = clock.wall();
        if (_n - screensState._hiddenNetLast >= 1000) {
          screensState._hiddenNetLast = _n;
          sendOnlineState(true);
          if (onlineSessionState.onlineRoomId)
            netSend("hb", { sender: onlineSessionState.myPlayerId });
        }
      }
    }, 100);
  }
}

export function stopHiddenLoop() {
  if (!screensState.hiddenTimer) return;
  if (typeof Worker !== "undefined" && screensState.hiddenTimer instanceof Worker) {
    if (screensState.hiddenTimer._blobUrl) {
      try {
        URL.revokeObjectURL(screensState.hiddenTimer._blobUrl);
      } catch (_) {
        log.debug("ui/screens.stopHiddenLoop", _);
      }
    }
    screensState.hiddenTimer.terminate();
  } else {
    clearInterval(screensState.hiddenTimer);
  }
  screensState.hiddenTimer = null;
}

const OPTIONS_INNER = `<div class="sticky-bar"><button class="back-btn" data-back type="button">‹ BACK</button><span class="bar-title">Options</span><span class="bar-right"><button class="save-btn" type="button">SAVE</button></span></div><div class="screen-body"><div class="settings"><div class="grp-title">Handling</div><div class="step" data-s="das" data-min="50" data-max="300"><span class="lb" title="Delayed Auto Shift — delay before a held move key starts repeating.">DAS</span><span class="ctl"><button data-d="-10">−</button><b class="val editable"></b><button data-d="10">+</button><span class="u">ms</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-s="arr" data-min="0" data-max="100"><span class="lb" title="Auto Repeat Rate — interval between repeated moves. 0 = instant.">ARR</span><span class="ctl"><button data-d="-5">−</button><b class="val editable"></b><button data-d="5">+</button><span class="u">ms</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-s="sdf"><span class="lb" title="Soft Drop Factor — speed multiplier while holding soft drop.">SDF</span><span class="ctl"><button data-d="-1">−</button><b class="val"></b><button data-d="1">+</button><span class="u">×</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="grp-title">Audio</div><div class="step" data-s="vol"><span class="lb" title="Master volume for sound effects.">VOLUME</span><span class="ctl"><input type="range" class="slider vol-slider" min="0" max="100" step="1"><b class="val vol-val"></b><span class="u">%</span></span></div><div class="grp-title">Effects</div><div class="step" data-s="fx" data-min="0" data-max="100"><span class="lb" title="Board impact physics.">BOARD BOUNCINESS</span><span class="ctl"><button data-d="-10">−</button><b class="val editable"></b><button data-d="10">+</button><span class="u">%</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-s="clearFx" data-min="0" data-max="100"><span class="lb" title="Particle burst strength when lines clear.">CLEAR PARTICLES</span><span class="ctl"><button data-d="-10">−</button><b class="val editable"></b><button data-d="10">+</button><span class="u">%</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-s="bg"><span class="lb" title="Animated floating pieces in the background.">BACKGROUND EFFECT</span><span class="ctl"><button class="tgl" data-bg>ON</button></span></div><div class="grp-title">Display</div><div class="step" data-s="grid" data-min="0" data-max="100"><span class="lb" title="Visibility of grid lines in the playfield.">GRID LINES</span><span class="ctl"><button data-d="-10">−</button><b class="val editable"></b><button data-d="10">+</button><span class="u">%</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="theme-picker"><div class="theme-steps"><div class="step" data-s="blockshape"><span class="lb" title="Silhouette of each block.">BLOCK SHAPE</span><span class="ctl"><button class="tgl" data-blockshape>ROUNDED</button></span></div><div class="step" data-s="blockstyle"><span class="lb" title="Surface style painted onto each block.">BLOCK STYLE</span><span class="ctl"><button class="tgl" data-blockstyle>MATT</button></span></div><div class="step" data-s="colortheme"><span class="lb" title="Piece color palette.">COLOR THEME</span><span class="ctl"><button class="tgl" data-colortheme>CLASSIC</button></span></div></div><canvas class="theme-preview" width="1" height="1" aria-hidden="true"></canvas></div><div class="step" data-s="ghost"><span class="lb" title="Render the ghost (drop preview).">GHOST PIECE</span><span class="ctl"><button class="tgl" data-ghost>GRAY</button></span></div><div class="step" data-s="ghostOpacity" data-min="0" data-max="100"><span class="lb" title="Opacity of the ghost piece.">GHOST OPACITY</span><span class="ctl"><button data-d="-10">−</button><b class="val editable"></b><button data-d="10">+</button><span class="u">%</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="grp-title">Motion</div><div class="step" data-s="motion"><span class="lb" title="Turns off the floating background, board bounce, clear particles and logo animation. Auto follows your device setting.">REDUCE MOTION</span><span class="ctl"><button class="tgl" data-motion>AUTO</button></span></div><div class="step" data-s="adaptive"><span class="lb" title="Lowers effects automatically while the game runs slowly, and brings them back when it speeds up.">ADAPTIVE QUALITY</span><span class="ctl"><button class="tgl" data-adaptive>ON</button></span></div><div class="grp-title" data-netgrp style="display:none">Online</div><div class="step" data-s="netbackend" data-netgrp style="display:none"><span class="lb" title="Which server online rooms use first. Auto uses the best one available; if it is down the others are tried.">SERVER</span><span class="ctl"><button class="tgl" data-netbackend>AUTO</button></span></div><div class="dev-note warn" data-editnote></div></div></div>`;

const TOUCH_LEGEND = `<div class="step" data-s="touchbtns"><span class="lb" title="Show the on-screen touch buttons while playing (single player only).">TOUCH BUTTONS</span><span class="ctl"><button class="tgl" data-touchbtns>ON</button></span></div><div class="step" data-s="swipeges"><span class="lb" title="Swipe gestures on the play area (single player only).">SWIPE GESTURES</span><span class="ctl"><button class="tgl" data-swipeges>ON</button></span></div><div class="step" data-s="swipeSens"><span class="lb" title="Horizontal swipe steering — how far you drag to move one column. Higher = more responsive.">SWIPE SENSITIVITY</span><span class="ctl"><button data-d="-1">−</button><b class="val"></b><button data-d="1">+</button><button class="rst" data-rst title="Reset">↺</button></span></div><div class="dev-note">These apply to single player only. In Versus, each player chooses TOUCH / SWIPE separately in the Versus lobby.</div><div class="grp-title" style="margin-top:16px">Button Layout</div><div class="dev-note">Tap a button below, then tap another button to swap their positions.</div><div class="touch-edit-grid"></div><div class="krow" style="margin-top:10px;justify-content:flex-end;"><button class="resetbind touch-layout-reset" type="button">RESET TOUCH LAYOUT</button></div><div class="grp-title" style="margin-top:16px">Layout Presets</div><div class="tp-saverow"><input class="tp-name" type="text" maxlength="14" placeholder="PRESET NAME" enterkeyhint="done" autocomplete="off"><button class="tp-save" type="button">SAVE CURRENT</button></div><div class="touch-preset-list"></div><div class="grp-title" style="margin-top:16px">Gestures</div><div class="dev-note">Tap the value to cycle. Each action can only be assigned to one gesture.</div><div class="step" data-g="tap"><span class="lb" title="Action performed on a quick tap on the board.">TAP</span><span class="ctl"><button class="tgl wide" data-gesture="tap">ROT CW</button></span></div><div class="step" data-g="swipeUp"><span class="lb" title="Action performed when you swipe up on the board.">SWIPE UP</span><span class="ctl"><button class="tgl wide" data-gesture="swipeUp">ROT 180</button></span></div><div class="step" data-g="flickUp"><span class="lb" title="Action performed on a fast upward flick.">FLICK UP</span><span class="ctl"><button class="tgl wide" data-gesture="flickUp">HOLD</button></span></div><div class="step" data-g="swipeDown"><span class="lb" title="Action performed while dragging down on the board.">SWIPE DOWN (HOLD)</span><span class="ctl"><button class="tgl wide" data-gesture="swipeDown">SOFT</button></span></div><div class="step" data-g="flickDown"><span class="lb" title="Action performed on a fast downward flick.">FLICK DOWN</span><span class="ctl"><button class="tgl wide" data-gesture="flickDown">HARD</button></span></div><div class="krow" style="margin-top:10px;justify-content:flex-end;"><button class="resetbind gesture-reset" type="button">RESET GESTURES</button></div>`;

const CONTROLS_INNER = `<div class="sticky-bar"><button class="back-btn" data-back type="button">‹ BACK</button><span class="bar-title">Controls</span><span class="bar-right"><button class="resetbind" type="button">RESET ALL</button></span></div><div class="screen-body"><div class="ctrl-tabs"><button class="ctrl-tab" data-ctrltab="key" type="button">KEYBOARD</button><button class="ctrl-tab" data-ctrltab="mouse" type="button">MOUSE</button><button class="ctrl-tab" data-ctrltab="pad" type="button">GAMEPAD</button><button class="ctrl-tab touch-only" data-ctrltab="touch" type="button">TOUCH</button></div><div class="ctrl-page" data-dev="key"><div class="bindList" data-dev="key"></div></div><div class="ctrl-page" data-dev="mouse"><div class="step" data-s="mouse"><span class="lb" title="Enable mouse buttons + wheel as game controls.">MOUSE CONTROL</span><span class="ctl"><button class="tgl" data-mouse>OFF</button></span></div><div class="step" data-s="mousesteer"><span class="lb" title="Moving the mouse over the board steers the piece horizontally.">MOUSE STEERING</span><span class="ctl"><button class="tgl" data-mousesteer>ON</button></span></div><div class="bindList" data-dev="mouse"></div><div class="dev-note" data-mousenote></div></div><div class="ctrl-page" data-dev="pad"><div class="bindList" data-dev="pad"></div></div><div class="ctrl-page touch-only" data-dev="touch">${TOUCH_LEGEND}</div><div class="bind-note" data-bindnote></div></div>`;

const REPLAYS_INNER = `<div class="sticky-bar"><button class="back-btn" data-back type="button">‹ BACK</button><span class="bar-title">Replays</span><span class="bar-right"><button class="save-btn" id="loadReplayBtn" type="button">LOAD FILE</button><input type="file" id="replayFileInput" accept=".json,.tzzreplay" style="display:none"></span></div><div class="screen-body"><div class="replay-list"></div></div>`;

const SCORES_INNER = `<div class="sticky-bar"><button class="back-btn" data-back type="button">‹ BACK</button><span class="bar-title">Scoreboard</span><span class="bar-right"><button class="clearscores" type="button">CLEAR</button></span></div><div class="screen-body"><div class="ctrl-tabs"><button class="ctrl-tab" data-scoretab="endless" type="button">ENDLESS</button><button class="ctrl-tab" data-scoretab="sprint" type="button">SPRINT</button><button class="ctrl-tab" data-scoretab="ultra" type="button">ULTRA</button><button class="ctrl-tab" data-scoretab="wide" type="button">4 WIDE</button></div><div class="scoreList"></div></div>`;

const MODES_INNER = `<div class="sticky-bar"><button class="back-btn" data-back type="button">‹ BACK</button><span class="bar-title">Single Player</span><span class="bar-right"></span></div><div class="screen-body mode-body"><div class="mode-grid"><button class="mode-card mc-endless" data-mode="endless" type="button"><span class="mc-glyph">∞</span><span class="mc-name">ENDLESS</span><span class="mc-desc">MARATHON · LEVEL UP EVERY 10 LINES</span><span class="mc-best">BEST —</span></button><button class="mode-card mc-ultra" data-mode="ultra" type="button"><span class="mc-glyph">2:00</span><span class="mc-name">ULTRA</span><span class="mc-desc">TIME ATTACK · MAX SCORE IN 2:00</span><span class="mc-best">BEST —</span></button><button class="mode-card mc-sprint" data-mode="sprint" type="button"><span class="mc-glyph">40</span><span class="mc-name">SPRINT</span><span class="mc-desc">CLEAR 40 LINES AS FAST AS YOU CAN</span><span class="mc-best">BEST —</span></button><button class="mode-card mc-wide" data-mode="wide" type="button"><span class="mc-glyph">4W</span><span class="mc-name">4 WIDE</span><span class="mc-desc">NARROW BOARD · SURVIVE &amp; SCORE</span><span class="mc-best">BEST —</span></button><button class="mode-card mc-practice" data-mode="practice" type="button"><span class="mc-glyph">PR</span><span class="mc-name">PRACTICE</span><span class="mc-desc">CUSTOM BOARD · EDIT · UNDO/REDO</span><span class="mc-best">CUSTOM</span></button></div></div>`;

const MULTIPLAYER_INNER = `<div class="sticky-bar"><button class="back-btn" data-back type="button">‹ BACK</button><span class="bar-title">Multi Player</span><span class="bar-right"></span></div><div class="screen-body mode-body"><div class="mode-grid mp-grid"><button class="mode-card mc-local" data-mode="local" type="button"><span class="mc-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7.5" r="3.2"/><path d="M3.5 19c.4-3.2 2.7-5.2 5.5-5.2s5.1 2 5.5 5.2"/><circle cx="16.8" cy="9" r="2.6"/><path d="M16 14.1c2.6-.3 4.6 1.5 5 4.4"/></svg></span><span class="mc-name">SAME DEVICE</span><span class="mc-desc">FRIENDS &amp; BOTS · ONE DEVICE</span></button><button class="mode-card mc-lan" data-mode="lan" type="button"><span class="mc-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg></span><span class="mc-name">LAN</span><span class="mc-desc">SAME NETWORK · NO INTERNET</span></button><button class="mode-card mc-online" data-mode="online" type="button"><span class="mc-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.8 2.6 4.2 5.6 4.2 9S14.8 18.4 12 21c-2.8-2.6-4.2-5.6-4.2-9S9.2 5.6 12 3z"/></svg></span><span class="mc-name">ONLINE</span><span class="mc-desc">PLAY OVER THE INTERNET</span></button></div></div>`;

export const VSM_GRID_HTML = `<div class="vsm-grid"><button class="vsm-card" data-vsm="battle" type="button"><span class="vsm-name">BATTLE (NORMAL)</span><span class="vsm-desc">10-WIDE · TRADE GARBAGE</span></button><button class="vsm-card" data-vsm="wide" type="button"><span class="vsm-name">BATTLE (4 WIDE)</span><span class="vsm-desc">4-WIDE · TRADE GARBAGE</span></button><button class="vsm-card" data-vsm="endless" type="button"><span class="vsm-name">ENDLESS</span><span class="vsm-desc">SURVIVE LONGER THAN OTHERS</span></button><button class="vsm-card" data-vsm="ultra" type="button"><span class="vsm-name">ULTRA</span><span class="vsm-desc">HIGHEST SCORE IN 2:00</span></button><button class="vsm-card" data-vsm="sprint" type="button"><span class="vsm-name">SPRINT</span><span class="vsm-desc">FIRST TO 40 LINES</span></button></div>`;

export const MP_RULES_HTML = `<div class="grp-title">Rules</div><div class="step" data-v="rounds" data-min="1" data-max="9"><span class="lb" title="Rounds needed to win the match.">ROUNDS TO WIN</span><span class="ctl"><button data-d="-1">−</button><b class="val editable"></b><button data-d="1">+</button><span class="u"></span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-v="target"><span class="lb" title="How your attack chooses a target when there are multiple opponents.">TARGET STRATEGY</span><span class="ctl"><button class="tgl wide" data-vtgl="target">RANDOM</button></span></div><div class="mp-rules"><div class="mp-rules-in"><div class="step" data-v="grav" data-min="0.001" data-max="2" data-float><span class="lb" title="starting gravity. how fast blocks drop">GRAVITY</span><span class="ctl"><button data-d="-0.005">−</button><b class="val editable"></b><button data-d="0.005">+</button><span class="u">G</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-v="gravInc" data-min="0" data-max="0.05" data-float><span class="lb" title="the amount of gravity increase per second">GRAVITY INCREASE</span><span class="ctl"><button data-d="-0.0005">−</button><b class="val editable"></b><button data-d="0.0005">+</button><span class="u">G/S</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-v="gravMargin" data-min="0" data-max="600" data-unit="s"><span class="lb" title="amount of time until gravity start to increase">GRAVITY MARGIN</span><span class="ctl"><button data-d="-5">−</button><b class="val editable"></b><button data-d="5">+</button><span class="u">SEC</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-v="gMult" data-min="0" data-max="10" data-float><span class="lb" title="starting garbage multiplier. 1 means normal 2 means double">GARBAGE MULT</span><span class="ctl"><button data-d="-0.25">−</button><b class="val editable"></b><button data-d="0.25">+</button><span class="u">×</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-v="gMargin" data-min="0" data-max="600" data-unit="s"><span class="lb" title="amount of time until garbage multiplier starts to increase">GARBAGE MARGIN</span><span class="ctl"><button data-d="-1">−</button><b class="val editable"></b><button data-d="1">+</button><span class="u">SEC</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-v="gInc" data-min="0" data-max="0.1" data-float><span class="lb" title="the amount of garbage multiplier increases per second">GARBAGE INCREASE</span><span class="ctl"><button data-d="-0.001">−</button><b class="val editable"></b><button data-d="0.001">+</button><span class="u">/S</span><button class="rst" data-rst title="Reset">↺</button></span></div></div></div>`;

const PRACTICE_INNER = `<div class="sticky-bar"><button class="back-btn" data-back type="button">‹ BACK</button><span class="bar-title">Practice</span><span class="bar-right"><button class="resetbind practicereset" type="button">RESET ALL</button></span></div><div class="screen-body"><div class="settings"><div class="start-wrap"><button class="menu-btn primary" data-nav="play" type="button">START</button></div><div class="start-wrap"><button class="menu-btn" id="capOpenBtn" type="button">BOARD LIBRARY</button></div><div class="grp-title">Gravity</div><div class="step" data-t="level" data-min="0" data-max="20"><span class="lb" title="Start level / gravity speed.">START LEVEL</span><span class="ctl"><button data-d="-1">−</button><b class="val editable"></b><button data-d="1">+</button><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-t="levelUp"><span class="lb" title="When enabled, level increases every 10 lines.">LEVEL UP</span><span class="ctl"><button class="tgl" data-tgl="levelUp">OFF</button></span></div><div class="grp-title">Board Size</div><div class="step" data-t="width" data-min="4" data-max="20"><span class="lb" title="Board width.">WIDTH</span><span class="ctl"><button data-d="-1">−</button><b class="val editable"></b><button data-d="1">+</button><span class="u">COLS</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-t="height" data-min="4" data-max="40"><span class="lb" title="Visible board height.">HEIGHT</span><span class="ctl"><button data-d="-1">−</button><b class="val editable"></b><button data-d="1">+</button><span class="u">ROWS</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="grp-title">Garbage</div><div class="step" data-t="garbage" data-min="0" data-max="40"><span class="lb" title="Starting garbage lines.">GARBAGE LINES</span><span class="ctl"><button data-d="-1">−</button><b class="val editable"></b><button data-d="1">+</button><span class="u">LINES</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-t="mess" data-min="0" data-max="100"><span class="lb" title="0 = holes aligned, 100 = random.">MESSINESS</span><span class="ctl"><button data-d="-5">−</button><b class="val editable"></b><button data-d="5">+</button><span class="u">%</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="grp-title">Auto Garbage</div><div class="step" data-t="autoGarbage"><span class="lb" title="Automatically add garbage over time.">AUTO GARBAGE</span><span class="ctl"><button class="tgl" data-tgl="autoGarbage">OFF</button></span></div><div class="step" data-t="autoIntervalMin" data-min="1" data-max="120"><span class="lb" title="Minimum seconds between garbage spawns.">MIN INTERVAL</span><span class="ctl"><button data-d="-1">−</button><b class="val editable"></b><button data-d="1">+</button><span class="u">SEC</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-t="autoIntervalMax" data-min="1" data-max="120"><span class="lb" title="Maximum seconds between garbage spawns.">MAX INTERVAL</span><span class="ctl"><button data-d="-1">−</button><b class="val editable"></b><button data-d="1">+</button><span class="u">SEC</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-t="autoMin" data-min="0" data-max="20"><span class="lb" title="Minimum garbage lines per spawn.">MIN LINES</span><span class="ctl"><button data-d="-1">−</button><b class="val editable"></b><button data-d="1">+</button><span class="u">LINES</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="step" data-t="autoMax" data-min="0" data-max="20"><span class="lb" title="Maximum garbage lines per spawn.">MAX LINES</span><span class="ctl"><button data-d="-1">−</button><b class="val editable"></b><button data-d="1">+</button><span class="u">LINES</span><button class="rst" data-rst title="Reset">↺</button></span></div><div class="grp-title">Rules</div><div class="step" data-t="disableHold"><span class="lb" title="Disable HOLD completely.">DISABLE HOLD</span><span class="ctl"><button class="tgl" data-tgl="disableHold">OFF</button></span></div><div class="step" data-t="infiniteHold"><span class="lb" title="Allow HOLD as often as you want.">INFINITE HOLD</span><span class="ctl"><button class="tgl" data-tgl="infiniteHold">OFF</button></span></div><div class="step" data-t="disableLock"><span class="lb" title="Unlimited lock resets.">UNLIMITED LOCK RESETS</span><span class="ctl"><button class="tgl" data-tgl="disableLock">OFF</button></span></div><div class="dev-note warn" data-editnote></div></div></div>`;

const VS_INNER = `<div class="sticky-bar"><button class="back-btn" data-back type="button">‹ BACK</button><span class="bar-title">Local</span><span class="bar-right"><button class="resetbind vsreset" type="button">RESET ALL</button></span></div><div class="screen-body"><div class="settings"><div class="start-wrap"><button class="menu-btn primary" data-vnav="start" type="button">START MATCH</button></div><div class="grp-title">Players</div><div class="mp-lobby"></div><div class="grp-title">Game Mode</div>${VSM_GRID_HTML}<div class="grp-title mob-only">Layout</div><div class="step mob-only" data-v="reverse"><span class="lb" title="Flip the top board upside-down so two players can sit face-to-face with the phone on the table.">FACE-TO-FACE (REVERSE TOP)</span><span class="ctl"><button class="tgl" data-vtgl="reverse">OFF</button></span></div><div id="botSettingsBlock" style="display:none"><div class="grp-title">Bot Settings</div><div id="botSettingsSteps"></div></div>${MP_RULES_HTML}<div class="dev-note warn" data-editnote></div></div></div>`;

export function showTip(el) {
  const txt = el.getAttribute("title") || "";
  if (!txt) return;
  const tip = $("tip");
  tip.textContent = txt;
  const r = el.getBoundingClientRect();
  const above = r.top > 96;
  tip.style.left = clamp(r.left + r.width / 2, 150, innerWidth - 150) + "px";
  tip.style.top = (above ? r.top - 8 : r.bottom + 8) + "px";
  tip.style.transform = above ? "translate(-50%,-100%)" : "translate(-50%,0)";
  tip.classList.add("on");
  clearTimeout(screensState.tipT);
  screensState.tipT = setTimeout(() => tip.classList.remove("on"), 2600);
}

export function hideTip() {
  const tip = $("tip");
  if (tip) tip.classList.remove("on");
}

function blur(t) {
  try {
    t.blur();
  } catch (_) {
    log.debug("ui/screens.blur", _);
  }
}

export function wireUI() {
  document.querySelectorAll('[data-screen="options"]').forEach((el) => {
    el.innerHTML = OPTIONS_INNER;
  });
  document.querySelectorAll('[data-screen="controls"]').forEach((el) => {
    el.innerHTML = CONTROLS_INNER;
  });
  document.querySelectorAll('[data-screen="scores"]').forEach((el) => {
    el.innerHTML = SCORES_INNER;
  });
  document.querySelectorAll('[data-screen="replays"]').forEach((el) => {
    el.innerHTML = REPLAYS_INNER;
  });
  document.querySelectorAll('[data-screen="singleplayer"]').forEach((el) => {
    el.innerHTML = MODES_INNER;
  });
  document.querySelectorAll('[data-screen="multiplayer"]').forEach((el) => {
    el.innerHTML = MULTIPLAYER_INNER;
  });
  document.querySelectorAll('[data-screen="online-lobby"]').forEach((el) => {
    el.innerHTML = screensState.ONLINE_LOBBY_INNER;
  });
  document.querySelectorAll('[data-screen="practice"]').forEach((el) => {
    el.innerHTML = PRACTICE_INNER;
  });
  document.querySelectorAll('[data-screen="vsbot"]').forEach((el) => {
    el.innerHTML = VS_INNER;
  });
  document.querySelectorAll(".vol-slider").forEach((s) => {
    s.addEventListener("input", onVolInput);
    s.addEventListener("change", onVolChange);
  });
  document.addEventListener(
    "pointerdown",
    (e) => {
      const btn = e.target.closest && e.target.closest(".step button[data-d]");
      if (!btn || btn.disabled) return;
      closeActiveValueEditor();
      stepPressReset();
      stepPress.btn = btn;
      stepPress.pid = e.pointerId;
      stepPress.sx = e.clientX;
      stepPress.sy = e.clientY;
      if (e.pointerType === "mouse") stepPressActivate(btn);
      else
        stepPress.confirmT = setTimeout(() => {
          stepPress.confirmT = null;
          if (stepPress.btn === btn && !stepPress.cancelled) stepPressActivate(btn);
        }, STEP_CONFIRM_MS);
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (e) => {
      if (!stepPress.btn || e.pointerId !== stepPress.pid || stepPress.activated) return;
      const dx = e.clientX - stepPress.sx,
        dy = e.clientY - stepPress.sy;
      if (dx * dx + dy * dy > STEP_MOVE_TOL * STEP_MOVE_TOL) {
        stepPress.cancelled = true;
        if (stepPress.confirmT) {
          clearTimeout(stepPress.confirmT);
          stepPress.confirmT = null;
        }
        stepPress.btn = null;
        stepPress.pid = null;
      }
    },
    true,
  );
  document.addEventListener(
    "pointerup",
    (e) => {
      if (!stepPress.btn || e.pointerId !== stepPress.pid) return;
      if (stepPress.confirmT) {
        clearTimeout(stepPress.confirmT);
        stepPress.confirmT = null;
        if (!stepPress.cancelled) {
          stepPress.btn.dataset.ph = "1";
          activateStepButton(stepPress.btn);
        }
      }
      stopStepHold();
      stepPressReset();
    },
    true,
  );
  document.addEventListener(
    "pointercancel",
    (e) => {
      if (stepPress.pid !== null && e.pointerId !== stepPress.pid) return;
      if (stepPress.confirmT) {
        clearTimeout(stepPress.confirmT);
        stepPress.confirmT = null;
      }
      stopStepHold();
      stepPressReset();
    },
    true,
  );
  ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => {
    document.addEventListener(ev, () => stopStepHold(), true);
  });
  document.addEventListener("keydown", (e) => {
    const tg = e.target;
    if (tg && tg.classList && tg.classList.contains("tp-name") && e.key === "Enter") {
      e.preventDefault();
      const row = tg.closest(".tp-saverow");
      const b = row && row.querySelector(".tp-save");
      if (b) b.click();
    }
  });
  document.addEventListener("click", (e) => {
    const _ai = document.querySelector(".val input");
    if (_ai && _ai !== e.target) {
      const _av = _ai.closest(".val.editable");
      const _cv = e.target.closest && e.target.closest(".val.editable");
      if (_cv !== _av) closeActiveValueEditor();
    }
    const val = e.target.closest && e.target.closest(".val.editable");
    if (val && e.target.tagName !== "INPUT") {
      const step = val.closest(".step");
      if (
        step &&
        step.dataset.min !== undefined &&
        !step.classList.contains("disabled") &&
        !step.style.opacity
      ) {
        openValueEditor(val, step);
        return;
      }
    }
    const t = e.target.closest && e.target.closest("button");
    if (!t) {
      if (
        menuOpen() &&
        bindingsState.openOverlayEl &&
        bindingsState.openOverlayEl.contains(e.target)
      ) {
        gameState.kbNavActive = false;
        setKbFocus(null);
      }
      return;
    }
    if (t.id === "onlineLeaveBtn") return;
    if (t.closest("#touch") || t.closest("#touch2")) {
      blur(t);
      return;
    }
    if (menuOpen() && t.closest(".menu-full") && e.detail > 0) {
      gameState.kbNavActive = false;
      setKbFocus(t);
    }
    if (t.classList.contains("piece-cancel")) {
      closePieceModal();
      return blur(t);
    }
    if (t.id === "loadReplayBtn") {
      $("replayFileInput").click();
      return blur(t);
    }
    if (t.classList.contains("save-btn")) {
      saveAll();
      settingsState.optsSnapshot = snapOpts();
      showEditNote("Settings saved ✓");
      return blur(t);
    }
    if (t.classList.contains("touch-edit-btn")) {
      handleTouchEditClick(+t.dataset.idx);
      return blur(t);
    }
    if (t.classList.contains("touch-layout-reset")) {
      resetTouchLayout();
      return blur(t);
    }
    if (t.classList.contains("gesture-reset")) {
      game.gestures = {
        tap: "rotateCW",
        swipeUp: "rotate180",
        swipeDown: "soft",
        flickDown: "hard",
        flickUp: "hold",
      };
      syncToggles();
      saveOpts();
      return blur(t);
    }
    if (t.classList.contains("tp-apply")) {
      applyTouchPreset(t.dataset.name);
      return blur(t);
    }
    if (t.classList.contains("tp-del")) {
      const nm = t.dataset.name;
      askConfirm("Delete preset <b>" + nm + "</b>?<br>This cannot be undone.", "DELETE", () =>
        deleteTouchPreset(nm),
      );
      return blur(t);
    }
    if (t.classList.contains("tp-save")) {
      saveTouchPreset(t);
      return blur(t);
    }
    if (t.classList.contains("cancellisten")) {
      cancelListen();
      return blur(t);
    }
    const mtb = t.closest(".mp-type-btn");
    if (mtb) {
      mpSetType(+mtb.dataset.slot, mtb.dataset.type);
      return blur(mtb);
    }
    const mtgl = t.closest("[data-toggle]");
    if (mtgl) {
      const slot = +mtgl.dataset.slot;
      const p = versusLobbyState.vs.players[slot];
      if (p && p.type === "user") {
        const k = mtgl.dataset.toggle;
        if (k === "touch" || k === "swipe") {
          const other = k === "touch" ? "swipe" : "touch";
          if (p[k] && !p[other]) {
            showEditNote("At least one of TOUCH / SWIPE must stay on");
          } else {
            p[k] = !p[k];
            saveVs();
            refreshVs();
          }
        }
      }
      return blur(mtgl);
    }
    const mdb = t.closest(".mp-dev-btn");
    if (mdb) {
      mpAssignDev(+mdb.dataset.slot, mdb.dataset.dev);
      return blur(mdb);
    }
    const gestBtn = t.closest("[data-gesture]");
    if (gestBtn) {
      cycleGesture(gestBtn.dataset.gesture);
      return blur(gestBtn);
    }
    const vtgl = t.closest("[data-vtgl]");
    if (vtgl) {
      const k = vtgl.dataset.vtgl;
      if (k === "target") {
        const ci = TARGET_OPTS.indexOf(versusLobbyState.vs.target);
        versusLobbyState.vs.target = TARGET_OPTS[(ci + 1) % TARGET_OPTS.length];
      } else {
        versusLobbyState.vs[k] = !versusLobbyState.vs[k];
      }
      clampVs();
      saveVs();
      refreshVs();
      if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) mpComputeU();
      return blur(vtgl);
    }
    const tgb = t.closest("[data-touchbtns]");
    if (tgb) {
      if (bindingsState.touchBtnsOn && !bindingsState.swipeOn) {
        showNote("Keep at least one input method enabled");
      } else {
        bindingsState.touchBtnsOn = !bindingsState.touchBtnsOn;
        saveOpts();
        syncToggles();
        syncPad();
      }
      return blur(tgb);
    }
    const swb = t.closest("[data-swipeges]");
    if (swb) {
      if (bindingsState.swipeOn && !bindingsState.touchBtnsOn) {
        showNote("Keep at least one input method enabled");
      } else {
        bindingsState.swipeOn = !bindingsState.swipeOn;
        saveOpts();
        syncToggles();
        syncPad();
      }
      return blur(swb);
    }
    const stepD = t.closest(".step button[data-d]");
    if (stepD) {
      if (stepD.dataset.ph) {
        delete stepD.dataset.ph;
        return blur(stepD);
      }
      if (stepD.closest(".step.disabled")) return blur(stepD);
      activateStepButton(stepD);
      return blur(stepD);
    }
    if (t.classList.contains("cf-btn")) {
      if (t.dataset.cf === "ok") {
        if (bindingsState.pending) confirmPending();
        else if (bindingsState.confirmCb) {
          const cb = bindingsState.confirmCb;
          closeCf();
          cb();
        }
      } else if (t.dataset.cf === "stay") closeCf();
      else {
        if (bindingsState.pending) cancelPending();
        else {
          const cb = bindingsState.cancelCb;
          closeCf();
          if (cb) cb();
        }
      }
      return blur(t);
    }
    if (t.classList.contains("addbind")) {
      const page = t.closest(".ctrl-page");
      startListen(t.dataset.act, page ? page.dataset.dev : "key");
      return blur(t);
    }
    if (t.classList.contains("rm")) {
      removeBinding(t.dataset.act, t.dataset.k);
      return blur(t);
    }
    if (t.classList.contains("rstrow")) {
      cancelListen();
      resetAction(t.dataset.act);
      return blur(t);
    }
    if (t.classList.contains("clearscores")) {
      askConfirm(
        "Delete <b>all scoreboard records</b>?<br>This cannot be undone.",
        "DELETE ALL",
        clearScores,
      );
      return blur(t);
    }
    if (t.id === "saveReplayBtn") {
      if (replayState.replayData) {
        saveReplayToStorage(replayState.replayData);
        const _rl = t.querySelector(".mm-label");
        if (_rl) _rl.textContent = "SAVED ✓";
        else t.textContent = "REPLAY SAVED ✓";
        t.style.opacity = ".65";
        t.style.pointerEvents = "none";
      }
      return blur(t);
    }
    if (t.dataset.replayId) {
      const id = t.dataset.replayId;
      (async () => {
        let replays = [];
        try {
          replays = JSON.parse(storage.get("tetris_replays") || "[]");
        } catch (_) {
          log.debug("ui/screens.wireUI", _);
        }
        const r = replays.find((x) => x.id === id);
        if (r) {
          const d = await rpEntryData(r);
          if (d) startReplay(d);
        }
      })();
      return blur(t);
    }
    if (t.dataset.replayDel) {
      const id = t.dataset.replayDel;
      askConfirm("Delete this <b>replay</b>?", "DELETE", () => {
        let replays = [];
        try {
          replays = JSON.parse(storage.get("tetris_replays") || "[]");
        } catch (_) {
          log.debug("ui/screens.wireUI#2", _);
        }
        replays = replays.filter((x) => x.id !== id);
        storage.set("tetris_replays", JSON.stringify(replays));
        renderReplaysList();
      });
      return blur(t);
    }
    if (t.dataset.replayEdit) {
      const id = t.dataset.replayEdit;
      let replays = [];
      try {
        replays = JSON.parse(storage.get("tetris_replays") || "[]");
      } catch (_) {
        log.debug("ui/screens.wireUI#3", _);
      }
      const r = replays.find((x) => x.id === id);
      if (r) {
        const cur = r.name && r.name.trim() ? r.name : replayTitle(r.meta);
        askConfirm(
          'Rename this replay:<br><input id="replayNameInput" type="text" maxlength="40" class="tp-name" style="margin-top:10px;width:100%" value="' +
            escapeHtml(cur) +
            '">',
          "SAVE",
          () => {
            const inp = $("replayNameInput");
            const nm = inp ? inp.value.trim() : "";
            r.name = nm || replayTitle(r.meta);
            try {
              storage.set("tetris_replays", JSON.stringify(replays));
            } catch (_) {
              log.debug("ui/screens.wireUI#4", _);
            }
            renderReplaysList();
          },
        );
      }
      return blur(t);
    }
    if (t.id === "replayPlayPause") {
      replayTogglePlay();
      return blur(t);
    }
    if (t.dataset.replayDl) {
      const id = t.dataset.replayDl;
      (async () => {
        let replays = [];
        try {
          replays = JSON.parse(storage.get("tetris_replays") || "[]");
        } catch (_) {
          log.debug("ui/screens.wireUI#5", _);
        }
        const r = replays.find((x) => x.id === id);
        if (r) {
          const d = await rpEntryData(r);
          if (d) downloadReplayFile(d);
        }
      })();
      return blur(t);
    }
    if (t.id === "replayExit" || t.id === "replayExitBtn") {
      exitReplay();
      return blur(t);
    }
    if (t.classList.contains("replay-speed")) {
      replayState.replaySpeed = parseFloat(t.dataset.speed);
      document
        .querySelectorAll(".replay-speed")
        .forEach((b) => b.classList.toggle("active", b === t));
      return blur(t);
    }
    if (t.classList.contains("replay-round-btn")) {
      replayState.replayCurrentRound = parseInt(t.dataset.round);
      replayState.replayTime = 0;
      updateReplayUI();
      return blur(t);
    }
    if (t.classList.contains("practicereset")) {
      askConfirm(
        "Reset <b>Practice settings</b> to defaults?<br>Your saved boards are kept.",
        "RESET",
        () => {
          const keep = Array.isArray(configState.practice.boards)
            ? configState.practice.boards
            : [];
          configState.practice = { ...PRACTICE_DEFAULTS };
          configState.practice.boards = keep;
          configState.practice.boardSel = -1;
          configState.practice.startExtras = null;
          clampPractice();
          savePractice();
          refreshPractice();
          try {
            renderBoardList();
          } catch (_) {
            log.debug("ui/screens.wireUI#6", _);
          }
        },
      );
      return blur(t);
    }
    if (t.classList.contains("vsreset")) {
      askConfirm("Reset <b>Versus settings</b> to defaults?", "RESET", () => {
        versusLobbyState.vs = JSON.parse(JSON.stringify(VS_DEFAULTS));
        clampVs();
        saveVs();
        refreshVs();
      });
      return blur(t);
    }
    const vsmc = t.closest(".vsm-card");
    if (vsmc) {
      versusLobbyState.vs.submode = vsmc.dataset.vsm;
      clampVs();
      saveVs();
      refreshVs();
      return blur(vsmc);
    }
    if (t.dataset.vnav === "start") {
      vsStartMatch();
      return blur(t);
    }
    if (t.classList.contains("resetbind")) {
      const dev = bindingsState.ctrlDev;
      if (dev === "touch") {
        askConfirm("Reset <b>touch layout</b> and <b>gestures</b> to defaults?", "RESET", () => {
          touchState.touchOrder = TOUCH_DEFAULT_ORDER.slice();
          touchState.touchSel = null;
          saveTouchOrder();
          renderTouchBars();
          renderTouchEditor();
          renderTouchPresets();
          game.gestures = {
            tap: "rotateCW",
            swipeUp: "rotate180",
            swipeDown: "soft",
            flickDown: "hard",
            flickUp: "hold",
          };
          syncToggles();
          saveOpts();
        });
      } else {
        askConfirm("Reset <b>" + dev + "</b> bindings to defaults?", "RESET", () =>
          resetBindingsForDev(dev),
        );
      }
      return blur(t);
    }
    if (t.classList.contains("back-btn")) {
      if (t.id === "capBackBtn") {
        if (captureState.capMode !== undefined && captureState.capMode === "live") {
          capStopStream();
          capShowSources();
          capNote("");
        } else capClose();
        return blur(t);
      }
      if (t.id === "bvBackBtn") {
        bvClose();
        return blur(t);
      }
      if (
        onlineSessionState.isLanMode !== undefined &&
        onlineSessionState.isLanMode &&
        document.getElementById("lanSetupScreen") &&
        document.getElementById("lanSetupScreen").style.display !== "none"
      ) {
        if (lanState.lanFromLobby !== undefined && lanState.lanFromLobby) {
          lanReturnToLobby();
          return blur(t);
        }
        const _lanAct = document.getElementById("lanActive");
        if (_lanAct && _lanAct.style.display !== "none") {
          lanBackToMain();
          return blur(t);
        }
        leaveLanMode();
        goBack(t.closest(".overlay"));
        return blur(t);
      }
      goBack(t.closest(".overlay"));
      return blur(t);
    }
    if (t.classList.contains("ctrl-tab")) {
      if (t.dataset.ctrltab) showCtrlPage(t.dataset.ctrltab);
      else if (t.dataset.scoretab) renderScoreList(t.dataset.scoretab);
      return blur(t);
    }
    if (t.classList.contains("mode-card")) {
      const m = t.dataset.mode;
      if (m === "local") {
        selectMode("vsbot");
        showScreen(t.closest(".overlay"), "vsbot");
        return blur(t);
      }
      if (m === "online") {
        leaveLanMode();
        onlineSessionState.isLanMode = false;
        onlineSessionState.netMode = "supabase";
        initSupabase();
        showScreen(t.closest(".overlay"), "online-lobby");
        return blur(t);
      }
      if (m === "lan") {
        showLanSetupScreen();
        showScreen(t.closest(".overlay"), "online-lobby");
        return blur(t);
      }
      selectMode(m);
      if (m === "practice") showScreen(t.closest(".overlay"), "practice");
      else if (m === "vsbot") showScreen(t.closest(".overlay"), "vsbot");
      else startCountdown();
      return blur(t);
    }
    const botStep = t.closest("[data-bot-step]");
    if (botStep) {
      const slot = +botStep.dataset.slot;
      const key = botStep.dataset.key;
      const p = versusLobbyState.vs.players[slot];
      if (p && p.type === "bot") {
        if (t.dataset.rst !== undefined) {
          p[key] = key === "autoPps" ? VS_DEFAULTS.autoPps : VS_DEFAULTS[key];
        } else if (t.classList.contains("tgl")) {
          p[key] = !p[key];
        }
        saveVs();
        refreshVs();
      }
      return blur(t);
    }
    const vStep = t.closest(".step[data-v]");
    if (vStep) {
      if (t.closest("[data-vtgt]")) {
      } else {
        if (t.dataset.rst !== undefined) {
          const k = vStep.dataset.v;
          versusLobbyState.vs[k] = VS_DEFAULTS[k];
          clampVs();
          saveVs();
          refreshVs();
        }
        return blur(t);
      }
    }
    const prStep = t.closest(".step[data-t]");
    if (prStep) {
      if (t.classList.contains("tgl")) {
        const key = t.dataset.tgl || prStep.dataset.t;
        configState.practice[key] = !configState.practice[key];
        if (key === "disableHold" && configState.practice.disableHold)
          configState.practice.infiniteHold = false;
        if (key === "infiniteHold" && configState.practice.infiniteHold)
          configState.practice.disableHold = false;
        clampPractice();
        savePractice();
        refreshPractice();
        return blur(t);
      }
      if (t.dataset.rst !== undefined) {
        const k = prStep.dataset.t;
        configState.practice[k] = PRACTICE_DEFAULTS[k];
        clampPractice();
        savePractice();
        refreshPractice();
        return blur(t);
      }
      return blur(t);
    }
    if (t.dataset.nav) {
      const v = t.dataset.nav;
      const ov = t.closest(".overlay");
      if (v === "options") showScreen(ov, "options");
      else if (v === "controls") showScreen(ov, "controls");
      else if (v === "scores") showScreen(ov, "scores");
      else if (v === "replays") showScreen(ov, "replays");
      else if (v === "singleplayer") showScreen(ov, "singleplayer");
      else if (v === "multiplayer") showScreen(ov, "multiplayer");
      else if (v === "practice") showScreen(ov, "practice");
      else if (v === "vsbot") {
        if (
          (onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame) ||
          onlineSessionState.onlineRoomId ||
          onlineSessionState.isSpectator
        ) {
          backToOnlineLobby();
        } else showScreen(ov, "vsbot");
      } else if (v === "menu") {
        if (
          (onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame) ||
          onlineSessionState.onlineRoomId ||
          onlineSessionState.isSpectator
        ) {
          if (onlineSessionState.isOnlineGame) {
            askConfirm("Leave the room and return to <b>MAIN MENU</b>?", "LEAVE", () =>
              leaveOnlineRoom(true),
            );
          } else {
            backToOnlineLobby();
          }
        } else if (game.state === "paused" && game.pausedFrom !== "countdown")
          askConfirm(
            "Quit to <b>MAIN MENU</b>?<br>Your current game will be lost.",
            "QUIT",
            quitToMenu,
          );
        else quitToMenu();
      } else if (v === "local") {
        selectMode("vsbot");
        showScreen(ov, "vsbot");
      } else if (v === "online") {
        leaveLanMode();
        onlineSessionState.isLanMode = false;
        onlineSessionState.netMode = "supabase";
        initSupabase();
        showScreen(ov, "online-lobby");
      } else if (v === "lan") {
        showLanSetupScreen();
        showScreen(ov, "online-lobby");
      } else if (v === "play" || v === "again") {
        if (
          versusLobbyState.vsActive !== undefined &&
          versusLobbyState.vsActive &&
          versusLobbyState.vsMatchOver
        )
          vsStartMatch();
        else startCountdown();
      } else if (v === "restart") {
        if (game.state === "paused" && game.pausedFrom !== "countdown")
          askConfirm(
            "Restart this game?<br>Your current progress will be lost.",
            "RESTART",
            startCountdown,
          );
        else startCountdown();
      } else if (v === "resume") togglePause();
      return blur(t);
    }
    if (t.closest(".step")) {
      const st = t.closest(".step");
      const s = st.dataset.s;
      if (t.classList.contains("tgl")) {
        if (s === "blockshape") {
          cycleBlockShape();
          return blur(t);
        }
        if (s === "blockstyle") {
          cycleBlockStyle();
          return blur(t);
        }
        if (s === "colortheme") {
          cycleColorTheme();
          return blur(t);
        }
        if (s === "mouse") {
          bindingsState.mouseEnabled = !bindingsState.mouseEnabled;
          if (bindingsState.mouseEnabled) {
            fillMissing(bindingsState.bindings);
            rebuildReverse();
          }
          saveBindings();
          syncToggles();
          renderBindLists();
        } else if (s === "mousesteer") {
          bindingsState.mouseSteerOn = !bindingsState.mouseSteerOn;
          try {
            storage.set("tetris_mousesteer", bindingsState.mouseSteerOn ? "1" : "0");
          } catch (_) {
            log.debug("ui/screens.wireUI#7", _);
          }
          syncToggles();
        } else if (s === "ghost") {
          bindingsState.ghostMode =
            bindingsState.ghostMode === "off"
              ? "gray"
              : bindingsState.ghostMode === "gray"
                ? "color"
                : "off";
          saveOpts();
          syncToggles();
          render();
        } else if (s === "bg") {
          bindingsState.bgEnabled = !bindingsState.bgEnabled;
          syncToggles();
          syncBg();
        } else if (s === "motion") {
          configState.motion =
            MOTION_MODES[(MOTION_MODES.indexOf(configState.motion) + 1) % MOTION_MODES.length];
          syncToggles();
          syncBg();
        } else if (s === "netbackend") {
          configState.onlineBackend = nextBackendChoice(
            netConfig.current,
            configState.onlineBackend,
          );
          syncToggles();
        } else if (s === "adaptive") {
          perfState.adaptive = !perfState.adaptive;
          syncToggles();
        }
        return blur(t);
      }
      if (t.dataset.rst !== undefined) {
        if (s === "das") configState.DAS = DEFAULTS.das;
        else if (s === "arr") configState.ARR = DEFAULTS.arr;
        else if (s === "sdf") configState.sdfIdx = DEFAULTS.sdf;
        else if (s === "fx") configState.fxStrength = DEFAULTS.fx;
        else if (s === "clearFx") configState.clearFx = DEFAULTS.clearFx;
        else if (s === "grid") configState.gridVis = DEFAULTS.grid;
        else if (s === "swipeSens") configState.swipeSens = 5;
        else if (s === "ghostOpacity") bindingsState.ghostOpacity = 50;
        refreshOpts();
        return blur(t);
      }
      return blur(t);
    }
    if (t.id === "capOpenBtn" || t.id === "capOpenBtn2") {
      capOpen();
      return blur(t);
    }
    if (t.id === "capFileBtn") {
      $("capFileInput").click();
      return blur(t);
    }
    if (t.id === "capScreenBtn") {
      capFromScreen();
      return blur(t);
    }
    if (t.id === "capCamBtn") {
      capFromCamera();
      return blur(t);
    }
    if (t.id === "capSnapBtn") {
      capFreeze();
      return blur(t);
    }
    if (t.id === "capCancelLiveBtn") {
      capStopStream();
      capShowSources();
      capNote("");
      return blur(t);
    }
    if (t.id === "capRetakeBtn") {
      capRetake();
      return blur(t);
    }
    if (t.id === "capApplyBtn") {
      capApply();
      return blur(t);
    }
    if (t.id === "mirrorBtn") {
      mirrorBoard();
      return blur(t);
    }
    if (t.id === "fumenImportBtn") {
      fumenImport();
      return blur(t);
    }
    if (t.id === "fumenExportBtn") {
      fumenExport();
      return blur(t);
    }
    if (t.id === "rpToPracticeBtn") {
      replayToPractice();
      return blur(t);
    }
    if (t.id === "continueBtn") {
      resumeSession();
      return blur(t);
    }
    if (t.id === "installBtn") {
      runInstallFlow();
      return blur(t);
    }
    if (t.id === "themeBtn") {
      setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
      return blur(t);
    }
    if (t.id === "sndBtn") {
      toggleMute();
      return blur(t);
    }
    if (t.id === "pauseBtn") {
      togglePause();
      return blur(t);
    }
    blur(t);
  });
}
