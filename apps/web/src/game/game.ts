// @ts-nocheck
import { clock } from "../core/clock";
import { calcAttack, calcLockScore, PIECES } from "@tetrizz/core";
import { storage } from "../core/storage";
import { log } from "../core/logger";
import {
  HID,
  MOBILE,
  PRACTICE_DEFAULTS,
  SPRINT_LINES,
  colsForMode,
  configState,
  setDVH,
  visForMode,
} from "../core/config";
import { emitEvent, emitBefore, isIntercepted } from "../core/events";
import { bindingsState, heldSet } from "../input/bindings";
import { game, input } from "./state";
import {
  CLEARV0,
  CLEARV_PER,
  DROPV,
  SFX,
  collide,
  collideOn,
  curCells,
  emptyRow,
  findFullRows,
  fx,
  fxKick,
  gravMsFor,
  levelForLines,
  pcAfterClear,
  spliceRows,
  detectSpinOn,
} from "../engine/engine";
import {
  $,
  applyGeometry,
  balanceVertical,
  cancelRestartHold,
  clampPractice,
  layout,
  layoutSoon,
  layoutState,
  trackHdr,
} from "../ui/layout";
import {
  banner,
  bannerBoth,
  burstAt,
  checkDanger,
  clearAllBanners,
  drawHold,
  drawNexts,
  drawThemePreview,
  ghostY,
  hideAction,
  showAction,
  spawnXFor,
  updateChips,
} from "../render/render";
import { bumpScore, fmtTime, fmtTimeP, isBattle, kbDefault, updateStats } from "../ui/menus";
import {
  askConfirm,
  bestFor,
  cancelListen,
  cancelPending,
  cfIsOpen,
  closeCf,
  optsDirty,
  refreshOpts,
  renderBindLists,
  renderScoreList,
  restoreOpts,
  saveAll,
  saveScoreEntry,
  settingsState,
  snapOpts,
  snapState,
  syncPracticeButtons,
  syncToggles,
  syncVsButtons,
  updateModeCards,
} from "../ui/settings";
import {
  applyBoardSeq,
  applyPracticeStartBoard,
  applyPracticeStartExtras,
  closePieceModal,
  exitEdit,
  pushHistory,
  restoreState,
  updatePracticeButtons,
} from "../practice/practice";
import { capStopStream } from "../practice/capture";
import { migrateBoards, selectedBoard } from "../practice/board-library";
import { refreshPractice } from "../practice/snapshot";
import { swipeCancelSoft } from "../ui/controls";
import { addGarbage, randPracticeInterval, scheduleVisibleFrame } from "../ui/screens";
import {
  MP,
  mpClearInputs,
  mpComputeU,
  onSpawn,
  refreshVs,
  versusLobbyState,
  vsGarbageMode,
} from "../versus/lobby";
import {
  calcLockLabel,
  consume,
  insertActiveIdx,
  refreshQueues,
  sendAttack,
  vsMult,
} from "../versus/garbage";
import { mpBannerAll } from "../versus/stations";
import { layoutMp, mpBattleWinner, vsBeginRound, vsRoundEnd } from "../versus/rounds";
import { renderTouchEditor, renderTouchPresets } from "../input/touch";
import { onlineSessionState } from "../net/online-session";
import { leaveOnlineRoom, showOnlineLobbyUI } from "../net/online-lobby";
import { RP, renderReplaysList, rpBeginRound } from "../replay/replay";

export const gameState = {
  goTextActive: false,
  goTextTimer: null,
  lastBackEvt: 0,
  kbFocusEl: null,
  kbNavActive: false,
  _kbSkipDefault: false,
  _ptrInput: true,
};

export function detectSpin() {
  return detectSpinOn(game.board, game.piece);
}

function enterPiece(t) {
  game.piece = {
    type: t,
    rot: 0,
    x: spawnXFor(t),
    y: 0,
    lockT: 0,
    lockResets: 0,
    lastRotate: null,
    softSounded: false,
  };
  game.gravT = 0;
  fx.tx = 0;
  if (collide(curCells(), game.piece.x, game.piece.y)) {
    game.piece = null;
    setTimeout(() => {
      if (game.state === "playing") gameOver();
    }, 400);
    return;
  }
}

export function pullNext(allowHold) {
  const t = consume("P");
  refreshQueues();
  enterPiece(t);
  game.holdUsed = !allowHold;
  drawHold();
  drawNexts();
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) onSpawn("P");
}

export function doHold() {
  if (!game.piece || game.state !== "playing") return;
  if (configState.mode === "practice" && configState.practice.disableHold) return;
  const inf = configState.mode === "practice" && configState.practice.infiniteHold;
  if (game.holdUsed && !inf) return;
  SFX.hold();
  if (!inf) game.holdUsed = true;
  const t = game.piece.type;
  if (game.hold === null) {
    game.hold = t;
    const nt = consume("P");
    refreshQueues();
    enterPiece(nt);
  } else {
    const h = game.hold;
    game.hold = t;
    enterPiece(h);
  }
  if (inf) game.holdUsed = false;
  drawHold();
  drawNexts();
}

export function softStep() {
  if (!game.piece) return;
  if (!collide(curCells(), game.piece.x, game.piece.y + 1)) {
    game.piece.y++;
    game.score++;
    game.gravT = 0;
    game.piece.lastRotate = null;
    if (collide(curCells(), game.piece.x, game.piece.y + 1) && !game.piece.softSounded) {
      game.piece.softSounded = true;
      SFX.soft();
    }
    bumpScore();
    updateStats();
  }
}

export function softInstant() {
  if (!game.piece) return;
  const gy = ghostY();
  if (gy > game.piece.y) {
    const dist = gy - game.piece.y;
    game.score += dist;
    game.piece.y = gy;
    game.piece.lastRotate = null;
    game.gravT = 0;
    game.piece.softSounded = true;
    SFX.soft();
    bumpScore();
    updateStats();
  }
}

export function hardDrop() {
  if (!game.piece || game.state !== "playing") return;
  pushHistory();
  const gy = ghostY();
  const dist = gy - game.piece.y;
  game.score += dist * 2;
  game.piece.y = gy;
  if (dist > 0) game.piece.lastRotate = null;
  SFX.slam();
  fxKick(0, DROPV, 0);
  lockPiece(true);
}

export function lockPiece(fromHardDrop) {
  swipeCancelSoft(null);
  if (!fromHardDrop) {
    const sv = {
      x: game.piece.x,
      y: game.piece.y,
      rot: game.piece.rot,
      lastRotate: game.piece.lastRotate ? { ...game.piece.lastRotate } : null,
    };
    game.piece.x = spawnXFor(game.piece.type);
    game.piece.y = 0;
    game.piece.rot = 0;
    game.piece.lockT = 0;
    game.piece.lockResets = 0;
    game.piece.lastRotate = null;
    pushHistory();
    game.piece.x = sv.x;
    game.piece.y = sv.y;
    game.piece.rot = sv.rot;
    game.piece.lastRotate = sv.lastRotate;
  }
  const cells = curCells();
  const spin = game.piece.lastRotate ? detectSpin() : null;
  let allHidden = true;
  const placed = [];
  for (const [cx, cy] of cells) {
    const X = game.piece.x + cx,
      Y = game.piece.y + cy;
    if (Y >= 0) game.board[Y][X] = game.piece.type + 1;
    if (Y >= HID) allHidden = false;
    placed.push([X, Y]);
  }
  game.pieces++;
  if (allHidden) {
    game.piece = null;
    layoutState.wrap.classList.add("lost");
    setTimeout(() => {
      if (game.state === "playing") gameOver();
    }, 400);
    return;
  }
  const heavy = fromHardDrop || !!spin;
  for (const [X, Y] of placed) {
    if (Y >= HID) burstAt(X, Y, game.piece.type, heavy ? 4 : 2, true, heavy ? 1.35 : 0.9);
  }
  const rows = findFullRows(game.board);
  const willPC = pcAfterClear(game.board, rows);
  const lvl = game.level;
  const _ls = calcLockScore(rows.length, spin, lvl, game.combo, game.b2bChain, willPC);
  const _ll = calcLockLabel(rows.length, spin, game.piece.type);
  const label = _ll.label;
  const cls = _ll.cls;
  const labelCol = _ll.labelCol;
  if (spin) {
    if (rows.length) {
      if (!willPC) SFX.spinClear();
    } else {
      if (!fromHardDrop) SFX.lock();
    }
  } else if (rows.length === 4) {
    if (!willPC) SFX.tetris();
  } else if (rows.length) {
    if (!willPC) SFX.chime();
  } else {
    if (!fromHardDrop) SFX.lock();
  }
  game.combo = _ls.nc;
  game.maxCombo = Math.max(game.maxCombo, game.combo);
  if (rows.length) fxKick(0, CLEARV0 + CLEARV_PER * rows.length, 0);
  game.b2bChain = _ls.nb;
  const b2bUsed = _ls.b2bUsed;
  const pts = _ls.pts;
  const comboPts = _ls.comboPts;
  game.score += pts;
  game.lines += rows.length;
  const nl = levelForLines(configState.mode, game.lines);
  if (nl > game.level) {
    game.level = nl;
    game.gravMs = gravMsFor(configState.mode, game.level);
  }
  if (rows.length || spin) {
    let sub = "";
    if (!isBattle()) {
      const _p = ["+" + pts];
      if (b2bUsed) _p.push("B2B ×" + game.b2bChain);
      if (comboPts) _p.push("COMBO ×" + game.combo);
      sub = _p.join(" · ");
    }
    showAction(label, sub, cls, labelCol);
  }
  if (rows.length && game.combo >= 1) SFX.combo(game.combo);
  let atk = 0;
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive && vsGarbageMode()) {
    atk = Math.floor(calcAttack(rows.length, spin, willPC, game.b2bChain, game.combo) * vsMult());
  }
  updateChips();
  for (const r of rows) {
    for (let x = 0; x < configState.COLS; x++) burstAt(x, r, game.board[r][x] - 1, 4, true, 1.5);
  }
  bumpScore();
  updateStats();
  if (rows.length) {
    spliceRows(game.board, rows);
    if (game.board.every((row) => row.every((v) => !v))) {
      banner("PERFECT CLEAR", "#ffd23f", null);
      SFX.pc();
    }
    if (configState.mode === "sprint" && game.lines >= SPRINT_LINES) {
      updateStats();
      gameOver();
      return;
    }
    if (
      versusLobbyState.vsActive !== undefined &&
      versusLobbyState.vsActive &&
      vsGarbageMode() &&
      atk > 0
    )
      sendAttack(0, atk);
    pullNext(true);
  } else {
    if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive && vsGarbageMode()) {
      if (insertActiveIdx(0)) {
        updateStats();
        return;
      }
    }
    pullNext(true);
  }
  checkDanger();
}

export function cancelGoText() {
  clearTimeout(gameState.goTextTimer);
  gameState.goTextActive = false;
  const gt = $("goText");
  if (gt) gt.classList.remove("show");
}

export function syncPanels() {
  const vsOn = versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive;
  const hide = game.state === "menu" || (game.state === "over" && !vsOn);
  document.body.classList.toggle("panels-hidden", hide && !gameState.goTextActive);
}

export function syncVsPlay() {
  syncVsPlayBody();
  emitEvent("syncVsPlay");
}

function syncVsPlayBody() {
  const on =
    versusLobbyState.vsActive !== undefined &&
    versusLobbyState.vsActive &&
    (game.state === "playing" ||
      game.state === "countdown" ||
      game.state === "vsround" ||
      game.state === "paused" ||
      game.state === "replay" ||
      (game.state === "over" && versusLobbyState.vsMatchOver));
  document.body.classList.toggle("vsplay", on);
  document.body.classList.toggle(
    "vsWide",
    !!(
      versusLobbyState.vsActive !== undefined &&
      versusLobbyState.vsActive &&
      versusLobbyState.vs.submode === "wide"
    ),
  );
  document.body.classList.toggle(
    "vs3P",
    !!(versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive && true && MP.n === 3),
  );
}

export function syncPad() {
  const _wp = document.body.classList.contains("playing");
  const _np =
    game.state === "playing" ||
    game.state === "countdown" ||
    game.state === "editing" ||
    game.state === "replay";
  document.body.classList.toggle("playing", _np);
  if (_np && !_wp) {
    configState._balancePending = true;
    clearTimeout(syncPad._ht);
    syncPad._ht = setTimeout(() => {
      configState._balancePending = false;
      balanceVertical();
    }, 90);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        configState._balancePending = false;
        balanceVertical();
      }),
    );
  }
  document.body.classList.toggle("editing", game.editMode);
  document.body.classList.toggle("noTouchBar", !bindingsState.touchBtnsOn);
  syncPanels();
  syncVsPlay();
  layout();
  updatePracticeButtons();
  layoutSoon(80);
  layoutSoon(320);
  if (MOBILE.matches) {
    const _t = $("touch");
    if (_t) {
      const _show = !!(
        bindingsState.touchBtnsOn &&
        (_np || game.state === "replay") &&
        !game.editMode
      );
      if (_show) {
        _t.style.removeProperty("display");
      } else {
        _t.style.display = "none";
      }
    }
  }
}

export function clearInput() {
  heldSet.clear();
  input.left = input.right = input.down = false;
  input.dir = 0;
  game.softHeld = game.btnSoft = game.swipeSoft = false;
  fx.tx = 0;
  cancelRestartHold();
  mpClearInputs();
}

function cancelCountdown() {
  game.countdownRemaining = 0;
  game.countdownPhase = "";
}

export const CD_NUM = 1000,
  CD_GO = 650,
  CD_TOTAL = 3 * CD_NUM + CD_GO;

function phaseForRemaining(r) {
  if (r > 2 * CD_NUM + CD_GO) return "3";
  if (r > CD_NUM + CD_GO) return "2";
  if (r > CD_GO) return "1";
  if (r > 0) return "GO";
  return null;
}

function showCountdownPhase(ph) {
  if (game.state !== "countdown") return;
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive && MP.stations.length) {
    if (ph === "GO") {
      mpBannerAll("GO", "#4fe08a", "count");
      SFX.go();
    } else {
      mpBannerAll(ph, "#7c8cc7", "count");
      SFX.count();
    }
    return;
  }
  if (ph === "GO") {
    bannerBoth("GO", "#4fe08a", "count", "GO", "#4fe08a", "count");
    SFX.go();
  } else {
    bannerBoth(ph, "#7c8cc7", "count", ph, "#7c8cc7", "count");
    SFX.count();
  }
}

export function syncCountdownPhase() {
  const ph = phaseForRemaining(game.countdownRemaining);
  if (ph && ph !== game.countdownPhase) {
    game.countdownPhase = ph;
    showCountdownPhase(ph);
  }
  return ph;
}

export function tickCountdown(dt) {
  if (
    versusLobbyState.vsActive !== undefined &&
    versusLobbyState.vsActive &&
    versusLobbyState.vsBannerUntil > clock.now()
  )
    return;
  if (
    versusLobbyState.vsActive !== undefined &&
    versusLobbyState.vsActive &&
    !versusLobbyState.vsCountdownStarted
  ) {
    versusLobbyState.vsCountdownStarted = true;
    game.countdownRemaining = CD_TOTAL;
    game.countdownPhase = "";
    syncCountdownPhase();
  }
  game.countdownRemaining -= dt;
  const ph = syncCountdownPhase();
  if (ph === null) {
    game.countdownPhase = "";
    game.state = "playing";
    game.pausedFrom = null;
    syncPad();
    game.lastTs = clock.now();
  }
}

function resetGame() {
  resetGameBody();
  emitEvent("resetGame");
}

function resetGameBody() {
  cancelCountdown();
  cancelGoText();
  configState.COLS = colsForMode(configState.mode);
  configState.VIS = visForMode(configState.mode);
  configState.ROWS = configState.VIS + HID;
  applyGeometry();
  game.board = Array.from({ length: configState.ROWS }, emptyRow);
  game.queue = [];
  versusLobbyState.sharedStream.length = 0;
  versusLobbyState.playerPtr = 0;
  game.hold = null;
  game.score = 0;
  game.lines = 0;
  game.level = levelForLines(configState.mode, 0);
  game.gravMs = gravMsFor(configState.mode, game.level);
  game.combo = -1;
  game.maxCombo = 0;
  game.b2bChain = 0;
  game.pieces = 0;
  game.playMs = 0;
  game.statAcc = 0;
  game.particles = [];
  game.hist.length = 0;
  game.redoStack.length = 0;
  game.editMode = false;
  game.editDrawing = false;
  game.editStroke = false;
  document.body.classList.remove("editing");
  clearInput();
  game.countdownRemaining = 0;
  game.countdownPhase = "";
  game.pausedFrom = null;
  fx.x = fx.y = fx.rot = fx.vx = fx.vy = fx.vr = 0;
  fx.lx = fx.lvx = 0;
  hideAction();
  layoutState.comboChip.classList.remove("show");
  layoutState.b2bChip.classList.remove("show");
  layoutState.elScore.style.fontSize = "";
  const _bs = $("botScore");
  if (_bs) _bs.style.fontSize = "";
  if (configState.mode === "practice") {
    migrateBoards();
    if (selectedBoard()) applyPracticeStartBoard();
    else if (configState.practice.garbage > 0)
      addGarbage(configState.practice.garbage, configState.practice.mess);
  }
  if (configState.mode === "practice" && configState.practice.autoGarbage)
    configState.practiceNextGarbage = game.playMs + randPracticeInterval();
  applyBoardSeq();
  refreshQueues();
  pullNext(true);
  if (configState.mode === "practice" && configState.practice.startExtras)
    applyPracticeStartExtras();
  updateStats();
  updateChips();
  updatePracticeButtons();
  layoutState.wrap.classList.remove("danger", "lost");
}

export function startCountdown() {
  emitBefore("startCountdown");
  startCountdownBody();
  emitEvent("startCountdown");
}

function startCountdownBody() {
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
    if (onlineSessionState.isOnlineGame === undefined || !onlineSessionState.isOnlineGame)
      vsBeginRound();
    return;
  }
  cancelCountdown();
  resetGame();
  hideAllOverlays();
  bindingsState.openOverlayEl = null;
  if (configState.mode === "practice") {
    game.state = "playing";
    game.pausedFrom = null;
    syncPad();
    game.lastTs = clock.now();
    trackHdr(450);
    layoutSoon(80);
    layoutSoon(320);
    return;
  }
  game.state = "countdown";
  syncPad();
  game.lastTs = clock.now();
  game.countdownRemaining = CD_TOTAL;
  game.countdownPhase = "";
  syncCountdownPhase();
  trackHdr(450);
  layoutSoon(80);
  layoutSoon(320);
}

export function gameOver() {
  emitBefore("gameOver");
  gameOverBody();
  emitEvent("gameOver");
}

function gameOverBody() {
  if (
    versusLobbyState.vsActive !== undefined &&
    versusLobbyState.vsActive &&
    !versusLobbyState.vsMatchOver
  ) {
    const w = mpBattleWinner();
    vsRoundEnd(w ? w.slot : 0);
    return;
  }
  cancelCountdown();
  game.pausedFrom = null;
  game.state = "over";
  game.piece = null;
  game.editMode = false;
  clearSession();
  layoutState.wrap.classList.remove("danger");
  hideAction();
  clearInput();
  document.body.classList.remove("playing");
  document.body.classList.remove("editing");
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) mpComputeU();
  gameState.goTextActive = true;
  syncPanels();
  syncVsPlay();
  SFX.over();
  const vf = $("vsFinal");
  if (vf) vf.style.display = "none";
  const ot = $("overTitle");
  let bTxt, bCol;
  if (configState.mode === "sprint" && game.lines >= SPRINT_LINES) {
    ot.textContent = "CLEAR!";
    ot.style.color = "var(--green)";
    ot.style.webkitTextFillColor = "var(--green)";
    ot.style.textShadow = "0 0 30px rgba(79,224,138,.4)";
    bTxt = "CLEAR!";
    bCol = "var(--green)";
  } else if (configState.mode === "ultra") {
    ot.textContent = "TIME'S UP!";
    ot.style.color = "var(--gold)";
    ot.style.webkitTextFillColor = "var(--gold)";
    ot.style.textShadow = "0 0 30px rgba(255,210,63,.4)";
    bTxt = "TIME'S UP!";
    bCol = "var(--gold)";
  } else {
    ot.textContent = "GAME OVER";
    ot.style.color = "var(--red)";
    ot.style.webkitTextFillColor = "var(--red)";
    ot.style.textShadow = "0 0 30px rgba(245,84,107,.4)";
    bTxt = "GAME OVER";
    bCol = "var(--red)";
  }
  const gt = $("goText"),
    gts = gt.querySelector("span");
  gts.textContent = bTxt;
  gts.style.color = bCol;
  gt.classList.remove("show");
  void gt.offsetWidth;
  gt.classList.add("show");
  $("finalScore").textContent = game.score.toLocaleString("en-US");
  $("fLines").textContent =
    configState.mode === "sprint" ? game.lines + "/" + SPRINT_LINES : game.lines;
  $("fLevel").textContent = game.level;
  const _lkS = $("fLevelK");
  if (_lkS) _lkS.textContent = "LEVEL";
  const _lnKS = $("fLinesK");
  if (_lnKS) _lnKS.textContent = "LINES";
  const _cbKS = $("fComboK");
  if (_cbKS) _cbKS.textContent = "MAX COMBO";
  const _tmKS = $("fTimeK");
  if (_tmKS) _tmKS.textContent = "TIME";
  const _pcKS = $("fPiecesK");
  if (_pcKS) _pcKS.textContent = "PIECES";
  const _ppKS = $("fPpsK");
  if (_ppKS) _ppKS.textContent = "PPS";
  $("fCombo").textContent = Math.max(game.maxCombo, 0);
  $("fPieces").textContent = game.pieces;
  $("fTime").textContent =
    configState.mode === "sprint" ? fmtTimeP(game.playMs) : fmtTime(game.playMs);
  $("fPps").textContent = game.playMs > 0 ? (game.pieces / (game.playMs / 1000)).toFixed(2) : "0";
  ["gsX1", "gsX2", "gsX3"].forEach(function (_gx) {
    const _ge = $(_gx);
    if (_ge) _ge.style.display = "none";
  });
  if (configState.mode === "practice" || configState.mode === "vsbot") {
    $("bestLine").textContent =
      configState.mode === "practice" ? "PRACTICE · NO RECORDS" : "VERSUS · NO RECORDS";
  } else {
    const prevBest = bestFor(configState.mode);
    saveScoreEntry();
    let bestHtml, isRecord;
    if (configState.mode === "sprint") {
      const cleared = game.lines >= SPRINT_LINES;
      isRecord = cleared && (!prevBest || Math.round(game.playMs) < prevBest.t);
      bestHtml = isRecord
        ? "BEST " + fmtTimeP(Math.round(game.playMs))
        : prevBest
          ? "BEST " + fmtTimeP(prevBest.t)
          : "BEST —";
    } else {
      isRecord = game.score > 0 && (!prevBest || game.score > prevBest.s);
      const bs = isRecord ? game.score : prevBest ? prevBest.s : 0;
      bestHtml = "BEST " + (bs ? bs.toLocaleString("en-US") : "—");
    }
    $("bestLine").innerHTML = bestHtml + (isRecord ? '<span class="nb">NEW BEST</span>' : "");
  }
  updateModeCards();
  syncPracticeButtons();
  syncVsButtons();
  clearTimeout(gameState.goTextTimer);
  gameState.goTextTimer = setTimeout(() => {
    cancelGoText();
    if (game.state === "over") openOverlay($("ovOver"));
    window.dispatchEvent(new Event("resize"));
  }, 1500);
}

export function togglePause() {
  if (isIntercepted("togglePause")) return;
  togglePauseBody();
}

function togglePauseBody() {
  if (game.editMode) exitEdit();
  cancelRestartHold();
  if (game.state === "playing" || game.state === "countdown") {
    game.pausedFrom = game.state;
    clearInput();
    game.state = "paused";
    gameState._kbSkipDefault = true;
    openOverlay($("ovPause"));
    refreshOpts();
  } else if (game.state === "paused") {
    game.state = game.pausedFrom || "playing";
    game.pausedFrom = null;
    hideAllOverlays();
    bindingsState.openOverlayEl = null;
    if (game.state === "playing") clearAllBanners();
    else if (game.state === "countdown") game.countdownPhase = "";
    game.lastTs = clock.now();
    trackHdr(450);
  }
  syncPad();
}

export function quitToMenu() {
  emitBefore("quitToMenu");
  cancelCountdown();
  cancelGoText();
  document.body.classList.remove("onlinePaused");
  if (versusLobbyState.vsActive !== undefined) {
    versusLobbyState.vsActive = false;
    versusLobbyState.vsMatchOver = false;
    MP.stations = [];
    MP.n = 0;
    document.body.classList.remove("splitMob");
    document.body.classList.remove("revsplit");
    document.body.classList.remove("matchover");
    document.body.style.removeProperty("--u");
    document.body.style.removeProperty("--hudU");
    document.body.style.removeProperty("--btnH");
    layoutState.mainEl.style.paddingBottom = "";
    layoutState.mainEl.style.height = "";
    if (versusLobbyState.botArenaEl) {
      versusLobbyState.botArenaEl.style.paddingTop = "";
      versusLobbyState.botArenaEl.style.paddingBottom = "";
      versusLobbyState.botArenaEl.style.height = "";
    }
    const tEl = $("touch");
    if (tEl) {
      tEl.classList.remove("touchTop");
      tEl.style.display = "";
    }
    const t2El = $("touch2");
    if (t2El) {
      t2El.style.display = "";
      t2El.style.top = "";
    }
    const _hud = $("vsHud"),
      _hud2 = $("vsHud2");
    if (_hud) _hud.removeAttribute("style");
    if (_hud2) _hud2.removeAttribute("style");
    if (versusLobbyState.vsRoundT !== undefined) clearTimeout(versusLobbyState.vsRoundT);
  }
  const vf = $("vsFinal");
  if (vf) vf.style.display = "none";
  game.pausedFrom = null;
  game.state = "menu";
  game.piece = null;
  game.editMode = false;
  clearSession();
  document.body.classList.remove("editing");
  layoutState.wrap.classList.remove("danger", "lost");
  hideAction();
  clearInput();
  syncPad();
  openOverlay($("ovStart"));
}

function canSaveSession() {
  if (game.editMode) return false;
  if (onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame)
    return false;
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) return false;
  if (!(game.state === "playing" || game.state === "paused" || game.state === "countdown"))
    return false;
  return true;
}

export function saveSession() {
  if (!canSaveSession()) return;
  try {
    storage.set(
      "tetris_session",
      JSON.stringify({
        mode: configState.mode,
        cols: configState.COLS,
        vis: configState.VIS,
        practice: configState.practice,
        snap: snapState(),
      }),
    );
  } catch (_) {
    log.debug("game/game.saveSession", _);
  }
  syncContinueBtn();
}

export function clearSession() {
  try {
    storage.remove("tetris_session");
  } catch (_) {
    log.debug("game/game.clearSession", _);
  }
  syncContinueBtn();
}

function hasSession() {
  try {
    return !!JSON.parse(storage.get("tetris_session"));
  } catch (e) {
    log.debug("hasSession", e);
    return false;
  }
}

export function syncContinueBtn() {
  const b = $("continueBtn");
  if (b) b.style.display = hasSession() ? "" : "none";
}

export function resumeSession() {
  let s;
  try {
    s = JSON.parse(storage.get("tetris_session"));
  } catch (e) {
    log.debug("resumeSession", e);
  }
  if (!s || !s.snap) return false;
  if (s.practice) {
    configState.practice = { ...PRACTICE_DEFAULTS, ...s.practice };
    clampPractice();
  }
  configState.mode = s.mode || "endless";
  configState.COLS = s.cols || 10;
  configState.VIS = s.vis || 20;
  configState.ROWS = configState.VIS + HID;
  applyGeometry();
  game.board = Array.from({ length: configState.ROWS }, emptyRow);
  restoreState(s.snap);
  if (game.state !== "playing") game.state = "playing";

  RP.data = null;
  rpBeginRound();
  clearSession();
  hideAllOverlays();
  bindingsState.openOverlayEl = null;
  syncPad();
  game.lastTs = clock.now();
  setDVH();
  layout();
  layoutSoon(120);
  layoutSoon(450);
  trackHdr(450);
  scheduleVisibleFrame();
  requestAnimationFrame(function () {
    game.lastTs = clock.now();
    setDVH();
    layout();
    scheduleVisibleFrame();
    if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) layoutMp();
  });
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      game.lastTs = clock.now();
      layout();
      if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) layoutMp();
    });
  });
  return true;
}

export function handleBack() {
  const now = clock.now();
  if (now - gameState.lastBackEvt < 250) return;
  gameState.lastBackEvt = now;
  if (now - bindingsState.lastBindAt < 500) return;
  if (!$("pieceModal").hidden) {
    closePieceModal();
    return;
  }
  if (cfIsOpen()) {
    if (bindingsState.pending) cancelPending();
    else closeCf();
    return;
  }
  if (bindingsState.listening) {
    cancelListen();
    return;
  }
  if (game.state === "playing" || game.state === "countdown") return;
  if (game.editMode) {
    exitEdit();
    return;
  }
  const ov = bindingsState.openOverlayEl;
  if (ov && !ov.classList.contains("hidden")) {
    if (bindingsState.menuView !== "main") {
      goBack(ov);
      return;
    }
    if (ov.id === "ovPause") {
      togglePause();
      return;
    }
    if (ov.id === "ovOver") {
      quitToMenu();
      return;
    }
  }
  if (game.state === "paused") {
    togglePause();
    return;
  }
  if (game.state === "over") {
    quitToMenu();
    return;
  }
}

export function setupBack() {
  const lockHistory = () => {
    try {
      history.pushState(null, document.title, location.href);
    } catch (_) {
      log.debug("game/game.lockHistory", _);
    }
  };
  lockHistory();
  let _popGuard = false;
  window.addEventListener("popstate", () => {
    if (_popGuard) return;
    _popGuard = true;
    try {
      history.go(1);
    } catch (_) {
      log.debug("game/game.setupBack", _);
    }
    _popGuard = false;
    handleBack();
  });
  window.addEventListener("touchstart", lockHistory, { passive: true });
  window.addEventListener("beforeunload", (e) => {
    if (
      onlineSessionState.isOnlineGame !== undefined &&
      (onlineSessionState.isOnlineGame ||
        (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator))
    )
      return;
    if (game.state === "playing" || game.state === "countdown" || game.state === "paused") {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

export function toggleMute() {
  game.muted = !game.muted;
  const b = $("sndBtn");
  b.classList.toggle("muted", game.muted);
  b.title = game.muted ? "Unmute" : "Mute";
  try {
    storage.set("tetris_muted", game.muted ? "1" : "0");
  } catch (_) {
    log.debug("game/game.toggleMute", _);
  }
}

export function confirmMenu() {
  if (gameState.kbFocusEl && gameState.kbFocusEl.isConnected && !gameState.kbFocusEl.disabled) {
    gameState.kbNavActive = true;
    gameState.kbFocusEl.click();
    return;
  }
  gameState.kbNavActive = true;
  kbDefault(bindingsState.openOverlayEl);
  if (gameState.kbFocusEl && gameState.kbFocusEl.isConnected && !gameState.kbFocusEl.disabled) {
    gameState.kbFocusEl.click();
    return;
  }
  if (game.state === "paused") togglePause();
  else if (game.state === "menu")
    showScreen(bindingsState.openOverlayEl || $("ovStart"), "singleplayer");
  else if (game.state === "over") startCountdown();
}

export function hideAllOverlays() {
  [
    $("ovStart"),
    $("ovPause"),
    $("ovOver"),
    $("ovOnlinePause"),
    $("ovCapture"),
    $("ovBoardView"),
  ].forEach((o) => {
    if (!o) return;
    o.classList.add("hidden");
    o.setAttribute("inert", "");
  });
  capStopStream();
}

function moveMainMenuRight(ov) {
  if (!ov) return;
  if (ov.id !== "ovPause" && ov.id !== "ovOver") return;
  const menus = ov.querySelectorAll(
    '[data-nav="menu"],[data-nav="main-menu"],.mm-home,#pauseMenuBtn,#overMenuBtn',
  );
  menus.forEach(function (menu) {
    const par = menu.parentElement;
    if (!par) return;
    const items = [].slice.call(par.children).filter(function (el) {
      return el && el.nodeType === 1 && el.offsetParent !== null;
    });
    if (items.length < 2) return;
    const rowTop = menu.offsetTop;
    const row = items.filter(function (el) {
      return Math.abs(el.offsetTop - rowTop) <= 4;
    });
    if (row.length < 2) return;
    const right = row[row.length - 1];
    if (!right || right === menu) return;
    const marker = document.createComment("mm-swap");
    par.insertBefore(marker, menu);
    par.insertBefore(menu, right);
    par.insertBefore(right, marker);
    par.removeChild(marker);
  });
}

export function openOverlay(ov) {
  hideAllOverlays();
  ov.classList.remove("hidden");
  ov.removeAttribute("inert");
  bindingsState.openOverlayEl = ov;
  bindingsState.listening = null;
  bindingsState.pending = null;
  showScreen(ov, "main");
  renderBindLists();
  syncPracticeButtons();
  syncVsButtons();
  moveMainMenuRight(ov);
  syncPad();
}

export function showScreen(ov, name) {
  if (document.activeElement && document.activeElement.tagName === "INPUT") {
    try {
      document.activeElement.blur();
    } catch (_) {
      log.debug("game/game.showScreen", _);
    }
  }
  bindingsState.menuView = name;
  cancelListen();
  bindingsState.pending = null;
  ov.querySelectorAll(".menu-screen").forEach((s) =>
    s.classList.toggle("active", s.dataset.screen === name),
  );
  const sc = ov.querySelector(".menu-scroll");
  if (sc) sc.scrollTop = 0;
  if (name === "controls") {
    showCtrlPage(bindingsState.ctrlDev);
    syncToggles();
    renderBindLists();
    refreshOpts();
  } else if (name === "options") {
    refreshOpts();
    drawThemePreview();
    settingsState.optsSnapshot = snapOpts();
  } else if (name === "scores") {
    renderScoreList(configState.mode === "practice" ? "endless" : configState.mode);
  } else if (name === "replays") {
    renderReplaysList();
  } else if (name === "modes") {
    updateModeCards();
  } else if (name === "practice") {
    refreshPractice();
  } else if (name === "vsbot") {
    refreshVs();
  } else if (name === "online-lobby") {
    showOnlineLobbyUI();
  }
  renderBindLists();
  gameState.kbNavActive = true;
  requestAnimationFrame(() => {
    if (gameState._kbSkipDefault) {
      gameState._kbSkipDefault = false;
      setKbFocus(null);
      return;
    }
    kbDefault(ov);
  });
}

function doGoBack(ov) {
  cancelListen();
  bindingsState.pending = null;
  renderBindLists();
  ov = ov || bindingsState.openOverlayEl;
  const parent = {
    singleplayer: "main",
    multiplayer: "main",
    modes: "main",
    "online-lobby": "multiplayer",
    vsbot: "multiplayer",
    practice: "singleplayer",
    options: "main",
    controls: "main",
    scores: "main",
    replays: "main",
  };
  let to = parent[bindingsState.menuView] || "main";
  if (to !== "main" && ov && !ov.querySelector('[data-screen="' + to + '"]')) to = "main";
  showScreen(ov, to);
}

export function goBack(ov) {
  if (
    bindingsState.menuView === "online-lobby" &&
    onlineSessionState.onlineRoomId !== undefined &&
    onlineSessionState.onlineRoomId
  ) {
    askConfirm("Leave this room and return to menu?", "LEAVE", () => leaveOnlineRoom(true));
    return;
  }
  if (bindingsState.menuView === "options" && optsDirty()) {
    confirmLeaveOptions(ov);
    return;
  }
  doGoBack(ov);
}

function confirmLeaveOptions(ov) {
  askConfirm(
    "You have <b>unsaved changes</b> in Options.<br>Save them before leaving?",
    "SAVE & EXIT",
    () => {
      saveAll();
      settingsState.optsSnapshot = snapOpts();
      doGoBack(ov);
    },
    {
      cancelLabel: "DISCARD",
      onCancel: () => {
        restoreOpts();
        doGoBack(ov);
      },
      stayLabel: "KEEP EDITING",
    },
  );
}

export function showCtrlPage(dev) {
  bindingsState.ctrlDev = dev;
  document
    .querySelectorAll(".ctrl-tab")
    .forEach((b) => b.classList.toggle("active", b.dataset.ctrltab === dev));
  document
    .querySelectorAll(".ctrl-page")
    .forEach((p) => p.classList.toggle("active", p.dataset.dev === dev));
  if (dev === "touch") {
    renderTouchEditor();
    renderTouchPresets();
  }
}

export function menuOpen() {
  return !!bindingsState.openOverlayEl && !bindingsState.openOverlayEl.classList.contains("hidden");
}

export function visibleButtons(ov) {
  const scr = ov && ov.querySelector(".menu-screen.active");
  if (!scr) return [];
  return [...scr.querySelectorAll("button")].filter((b) => !b.disabled && b.offsetParent !== null);
}

export function setKbFocus(el) {
  if (gameState.kbFocusEl) gameState.kbFocusEl.classList.remove("kb-focus");
  gameState.kbFocusEl = el || null;
  if (gameState.kbFocusEl && gameState.kbNavActive && !gameState._ptrInput) {
    gameState.kbFocusEl.classList.add("kb-focus");
    try {
      gameState.kbFocusEl.focus({ preventScroll: true });
    } catch (_) {
      log.debug("game/game.setKbFocus", _);
    }
  }
}

export function kbNav(dir) {
  gameState._ptrInput = false;
  const ov = bindingsState.openOverlayEl;
  if (!ov) return;
  const btns = visibleButtons(ov);
  if (!btns.length) return;
  gameState.kbNavActive = true;
  let i = btns.indexOf(gameState.kbFocusEl);
  i = i < 0 ? (dir > 0 ? 0 : btns.length - 1) : (i + dir + btns.length) % btns.length;
  setKbFocus(btns[i]);
}

export function modeCardsIn(ov) {
  const scr = ov && ov.querySelector(".menu-screen.active");
  if (!scr) return [];
  return [...scr.querySelectorAll(".mode-card,.mm-card")].filter(
    (b) => !b.disabled && b.offsetParent !== null,
  );
}
