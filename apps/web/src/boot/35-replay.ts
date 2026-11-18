// @ts-nocheck
import { clock } from "../core/clock";
import { log } from "../core/logger";
import { storage } from "../core/storage";
import { MODE_SET, configState, setDVH } from "../core/config";
import { intercept, onEvent, onBefore } from "../core/events";
import { applyColorTheme } from "../render/theme";
import { bindingsState, loadBindings, rebuildReverse } from "../input/bindings";
import { game } from "../game/state";
import { SFX, emptyRow, fxStep } from "../engine/engine";
import { $, layout, layoutSoon, loadPractice } from "../ui/layout";
import { clearAllBanners, updateParticlesArr } from "../render/render";
import {
  cancelGoText,
  openOverlay,
  setupBack,
  showCtrlPage,
  showScreen,
  syncContinueBtn,
  syncPanels,
} from "../game/game";
import {
  loadSettings,
  maybeSpawnFloater,
  refreshOpts,
  renderBindLists,
  selectMode,
  setTheme,
  spawnFloater,
  syncBg,
  syncToggles,
  syncVsButtons,
  updateModeCards,
} from "../ui/settings";
import {
  buildPieceModal,
  redo,
  toggleEdit,
  undo,
  updatePracticeButtons,
} from "../practice/practice";
import { wireUI } from "../ui/screens";
import { brandState, drawLogoCanvas, mountBrand } from "../ui/brand";
import { MP, botInitDom, loadVs, refreshVs, versusLobbyState } from "../versus/lobby";
import { ensureStream } from "../versus/garbage";
import { layoutMp } from "../versus/rounds";
import { clearLastRoom, onlineSessionState } from "../net/online-session";
import { beginReconnectUI, keepRejoiningServerRoom, onlineLobbyState } from "../net/online-lobby";
import { serverSocket } from "../net/transport";
import { onlineSyncState } from "../net/online-sync";
import {
  AUTO_REJOIN_MS,
  RP,
  attemptRejoin,
  loadReplayFromFile,
  replayActivity,
  replayShowControls,
  replayState,
  replayTogglePlay,
  rpBeginRound,
  rpCaptureFrame,
  rpEndMatch,
  rpEndRound,
  rpFinalCapture,
  rpIsMulti,
  rpMigrateReplays,
  rpMultiEnd,
  rpSetPPIcon,
  rpSingleEnd,
  rpTick,
  rpTime,
  updateReplayUI,
} from "../replay/replay";

if (onlineSyncState._urlRoom) replayState._autoRoom = onlineSyncState._urlRoom;
else if (onlineSyncState._lastRoom && onlineSyncState._lastRoom.room) {
  if (onlineSyncState._lastRoom.mode === "lan") {
    clearLastRoom();
  } else if (
    onlineSyncState._lastRoom.ts &&
    clock.wall() - onlineSyncState._lastRoom.ts <= AUTO_REJOIN_MS
  ) {
    replayState._autoRoom = onlineSyncState._lastRoom.room;
  } else {
    clearLastRoom();
  }
}

if (replayState._autoRoom) {
  if (onlineSyncState._lastRoom && onlineSyncState._lastRoom.name)
    onlineSessionState.onlineMyName = onlineSyncState._lastRoom.name;
  setTimeout(() => {
    if (onlineLobbyState._rejoinAbort) return;
    openOverlay($("ovStart"));
    showScreen($("ovStart"), "online-lobby");
    const ci = document.getElementById("onlineRoomCodeInput");
    if (ci) ci.value = replayState._autoRoom.toUpperCase();
    beginReconnectUI(replayState._autoRoom, "Restoring your match — please wait.");
    attemptRejoin(onlineSyncState._lastRoom);
  }, 800);
}

(function () {
  const SKIP = { count: 1, go: 1 };
  for (const n in SFX) {
    const orig = SFX[n];
    if (typeof orig !== "function") continue;
    SFX[n] = function () {
      if (RP.active && RP.round && !SKIP[n]) {
        const _a = Array.prototype.slice.call(arguments, 0, 2);
        const _e = { t: rpTime(), k: "s", n: n };
        if (_a.length) _e.a = _a;
        RP.round.events.push(_e);
      }
      return orig.apply(this, arguments);
    };
  }
})();

onEvent("fxKick", function (p) {
  if (RP.active && RP.round && game.state === "playing")
    RP.round.events.push({
      t: rpTime(),
      k: "fx",
      type: "kick",
      dx: p.dx,
      dy: p.dy,
      dr: p.dr,
    });
});

onEvent("fxSpin", function (p) {
  if (RP.active && RP.round && game.state === "playing")
    RP.round.events.push({ t: rpTime(), k: "fx", type: "spin", dir: p.dir });
});

onEvent("stFxKick", function (p) {
  if (RP.active && RP.round && game.state === "playing")
    RP.round.events.push({
      t: rpTime(),
      k: "fx",
      type: "skick",
      i: p.i,
      dx: p.dx,
      dy: p.dy,
      dr: p.dr,
    });
});

onEvent("stFxSpin", function (p) {
  if (RP.active && RP.round && game.state === "playing")
    RP.round.events.push({ t: rpTime(), k: "fx", type: "sspin", i: p.i, dir: p.dir });
});

onEvent("showAction", function (p) {
  if (RP.active && RP.round && game.state === "playing")
    RP.round.events.push({
      t: rpTime(),
      k: "a",
      i: -1,
      title: p.title,
      sub: p.sub,
      cls: p.cls,
      color: p.color,
    });
});

onEvent("showStAction", function (p) {
  if (RP.active && RP.round && game.state === "playing")
    RP.round.events.push({
      t: rpTime(),
      k: "a",
      i: p.i,
      title: p.title,
      sub: p.sub,
      cls: p.cls,
      color: p.color,
    });
});

onEvent("banner", function (p) {
  if (RP.active && RP.round && game.state === "playing")
    RP.round.events.push({
      t: rpTime(),
      k: "b",
      i: -1,
      txt: p.txt,
      color: p.color,
      cls: p.cls,
    });
});

onEvent("stBanner", function (p) {
  if (RP.active && RP.round && game.state === "playing")
    RP.round.events.push({
      t: rpTime(),
      k: "b",
      i: p.i,
      txt: p.txt,
      color: p.color,
      cls: p.cls,
    });
});

onBefore("startCountdown", function () {
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) return;
  RP.data = null;
});

onEvent("startCountdown", function () {
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) return;
  rpBeginRound();
});

onBefore("vsStartMatch", function () {
  RP.data = null;
});

onBefore("vsBeginRound", function () {
  rpBeginRound();
});

onEvent("vsRoundEnd", function () {
  if (RP.active) {
    rpFinalCapture();
    rpEndRound(rpMultiEnd(false));
  }
});

onEvent("vsMatchEnd", function () {
  if (RP.active) {
    rpFinalCapture();
    if (RP.round) RP.round.end = rpMultiEnd(true);
    rpEndMatch();
  }
});

onBefore("gameOver", function () {
  replayState._goWasVs = !!(versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive);
});

onEvent("gameOver", function () {
  if (!replayState._goWasVs && RP.active) {
    rpFinalCapture();
    rpEndRound(rpSingleEnd());
    rpEndMatch();
  }
});

onEvent("resetGame", function () {
  clearAllBanners();
});

onEvent("syncVsPlay", function () {
  if (
    game.state === "replay" &&
    replayState.replayPlayback &&
    replayState.replayPlayback.meta &&
    replayState.replayPlayback.meta.multi
  ) {
    document.body.classList.add("vsplay");
    document.body.classList.toggle("vsWide", versusLobbyState.vs.submode === "wide");
    document.body.classList.toggle("vs3P", MP.n === 3);
  }
});

intercept("tick", function (ts) {
  if (game.state !== "replay") return false;
  let dt = ts - game.lastTs;
  game.lastTs = ts;
  if (dt > 50) dt = 50;
  if (dt < 0) dt = 0;
  rpTick(dt);
  if (rpIsMulti()) {
    for (const st of MP.stations) updateParticlesArr(st.particles, dt / 1000);
  } else updateParticlesArr(game.particles, dt / 1000);
  maybeSpawnFloater(dt);
  fxStep(dt / 1000);
  return true;
});

onEvent("tick", function () {
  if (RP.active && game.state === "playing") rpCaptureFrame(false);
});

["pointerdown", "pointermove", "keydown", "touchstart", "wheel"].forEach((ev) =>
  window.addEventListener(ev, replayActivity, { passive: true }),
);

window.addEventListener(
  "keydown",
  (e) => {
    if (game.state !== "replay") return;
    const tg = e.target && e.target.tagName;
    if (tg === "INPUT" || tg === "SELECT" || tg === "TEXTAREA") {
      if (e.code === "Space") {
        e.preventDefault();
        if (e.target.blur) e.target.blur();
        if (!e.repeat) replayTogglePlay();
      }
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      if (!e.repeat) replayTogglePlay();
      return;
    }

    const round =
      replayState.replayPlayback &&
      replayState.replayPlayback.rounds[replayState.replayCurrentRound];
    if (!round || !round.frames || !round.frames.length) return;
    const maxT = round.frames[round.frames.length - 1].t;
    let delta = 0;
    if (e.code === "ArrowLeft") delta = e.shiftKey ? -30000 : -5000;
    else if (e.code === "ArrowRight") delta = e.shiftKey ? 30000 : 5000;
    else if (e.code === "Home") {
      replayState.replayTime = 0;
      replayState.replayAppliedFrame = null;
      replayState.replayEvtIdx = 0;
      replayState.replayEndApplied = false;
      clearAllBanners();
      cancelGoText();
      replayShowControls();
      updateReplayUI();
      e.preventDefault();
      return;
    } else if (e.code === "End") {
      replayState.replayTime = maxT;
      replayShowControls();
      updateReplayUI();
      e.preventDefault();
      return;
    }
    if (delta) {
      replayState.replayTime = Math.max(0, Math.min(maxT, replayState.replayTime + delta));
      if (replayState.replayTime < maxT - 1) {
        replayState.replayEndApplied = false;
        clearAllBanners();
        cancelGoText();
      }
      replayShowControls();
      updateReplayUI();
      e.preventDefault();
    }
  },
  true,
);

document.addEventListener(
  "click",
  (e) => {
    if (game.state !== "replay") return;
    if (
      e.target.closest &&
      e.target.closest("#replayControls,header,.overlay,.cf-modal,button,input,select")
    )
      return;
    document.body.classList.toggle("replayClean");
    const c = $("replayControls");
    if (document.body.classList.contains("replayClean")) {
      if (c) c.classList.add("hidden");
      clearTimeout(replayState.replayHideT);
    } else {
      replayShowControls();
    }
  },
  true,
);

(function () {
  const TZ_NUCLEAR = false;
  const st = document.createElement("style");
  st.textContent =
    "html.tz-promote header,html.tz-promote main,html.tz-promote #botArena," +
    "html.tz-promote .arenaExtra,html.tz-promote .overlay," +
    "html.tz-promote .menu-full,html.tz-promote .menu-scroll" +
    "{transform:translateZ(0);backface-visibility:hidden}";
  document.head.appendChild(st);
  let t = null,
    flip = false,
    huT = null;
  const freezeHu = () => {
    document.body.classList.add("noHuAnim");
    clearTimeout(huT);
    huT = setTimeout(() => document.body.classList.remove("noHuAnim"), 500);
  };
  const nuclear = () => {
    const els = [...document.querySelectorAll(".overlay:not(.hidden) .menu-full")];
    els.forEach((el) => {
      el.style.display = "none";
    });
    void document.body.offsetHeight;
    requestAnimationFrame(() => {
      els.forEach((el) => {
        el.style.display = "";
      });
      void document.body.offsetHeight;
      layout();
      layoutMp();
      layoutSoon(80);
      layoutSoon(300);
    });
  };
  const forceRepaint = () => {
    flip = !flip;
    document.documentElement.classList.toggle("tz-promote", flip);
    document.body.style.backgroundPosition = flip ? "1px 0" : "0 0";
    setDVH();
    layout();
    layoutMp();
    layoutSoon(120);
    if (TZ_NUCLEAR) nuclear();
  };
  window.tzRepaint = () => {
    freezeHu();
    requestAnimationFrame(() => requestAnimationFrame(forceRepaint));
  };
  addEventListener(
    "resize",
    () => {
      freezeHu();
      clearTimeout(t);
      t = setTimeout(() => {
        requestAnimationFrame(() => requestAnimationFrame(forceRepaint));
      }, 160);
    },
    { passive: true },
  );
})();

rpMigrateReplays();

game.board = Array.from({ length: configState.ROWS }, emptyRow);

loadSettings();

loadPractice();

loadVs();

applyColorTheme(configState.colorTheme);

bindingsState.bindings = loadBindings();

rebuildReverse();

$("sndBtn").classList.toggle("muted", game.muted);

$("sndBtn").title = game.muted ? "Unmute" : "Mute";

botInitDom();

document
  .querySelectorAll(".col-left>.panel h3")
  .forEach((h) => h.style.setProperty("--acchi", "#4257b8"));

wireUI();

refreshOpts();

syncToggles();

showCtrlPage(bindingsState.ctrlDev);

renderBindLists();

refreshVs();

syncVsButtons();

mountBrand();

if (document.fonts && document.fonts.ready)
  document.fonts.ready.then(function () {
    const cv = document.querySelector(".m-logo-cv");
    if (cv) drawLogoCanvas(cv);
  });

addEventListener("online", function () {
  brandState._bfState = 0;
  brandState._bfWait = false;
  const cv = document.querySelector(".m-logo-cv");
  if (cv) drawLogoCanvas(cv);
});

try {
  replayState._savedTheme = storage.get("tetris_theme") === "light" ? "light" : "dark";
} catch (_) {
  log.debug("boot/35-replay", _);
}

setTheme(replayState._savedTheme);

try {
  const m = storage.get("tetris_mode");
  if (m && MODE_SET.has(m)) replayState._savedMode = m;
} catch (_) {
  log.debug("boot/35-replay#2", _);
}

selectMode(replayState._savedMode);

ensureStream(6);

game.queue = versusLobbyState.sharedStream.slice(0, 5);

updateModeCards();

syncBg();

layout();

buildPieceModal();

document.querySelectorAll("button").forEach((b) => b.setAttribute("tabindex", "-1"));

["undoBtn", "redoBtn", "editBtn", "paintBtn", "eraseBtn"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("click", () => {
    if (id === "undoBtn") undo();
    if (id === "redoBtn") redo();
    if (id === "editBtn") toggleEdit();
    if (id === "paintBtn") {
      game.editTool = "paint";
      updatePracticeButtons();
    }
    if (id === "eraseBtn") {
      game.editTool = "erase";
      updatePracticeButtons();
    }
    try {
      el.blur();
    } catch (_) {
      log.debug("boot/35-replay#3", _);
    }
  });
});

addEventListener("gamepadconnected", () => {
  if (bindingsState.openOverlayEl && bindingsState.menuView === "vsbot") refreshVs();
});

addEventListener("gamepaddisconnected", () => {
  if (bindingsState.openOverlayEl && bindingsState.menuView === "vsbot") refreshVs();
});

syncPanels();

syncContinueBtn();

setupBack();

for (let i = 0; i < 3; i++) setTimeout(spawnFloater, i * 400);

replayState._rfi = $("replayFileInput");

if (replayState._rfi)
  replayState._rfi.addEventListener("change", (e) => {
    if (e.target.files.length > 0) loadReplayFromFile(e.target.files[0]);
    e.target.value = "";
  });

replayState._rs = $("replaySeek");

if (replayState._rs)
  replayState._rs.addEventListener("input", (e) => {
    replayState.replayTime = parseFloat(e.target.value);
    replayShowControls();
  });

replayState._rsel = $("replayRoundSel");

if (replayState._rsel)
  replayState._rsel.addEventListener("change", () => {
    replayState.replayCurrentRound = parseInt(replayState._rsel.value) || 0;
    replayState.replayTime = 0;
    replayState.replayAppliedFrame = null;
    replayState.replayEvtIdx = 0;
    replayState.replayEndApplied = false;
    replayState.replayPaused = false;
    replayState.replayPausedAtEnd = false;
    rpSetPPIcon();
    clearAllBanners();
    cancelGoText();
    updateReplayUI();
    replayShowControls();
  });

window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  replayState.dragCounter++;
  $("dropZone").classList.add("active");
});

window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  replayState.dragCounter--;
  if (replayState.dragCounter <= 0) {
    replayState.dragCounter = 0;
    $("dropZone").classList.remove("active");
  }
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
});

window.addEventListener("drop", (e) => {
  e.preventDefault();
  replayState.dragCounter = 0;
  $("dropZone").classList.remove("active");
  if (e.dataTransfer.files.length > 0) {
    loadReplayFromFile(e.dataTransfer.files[0]);
  }
});

/** The own server's connection ended while the player was in a room: show the reconnect panel and join again. */
serverSocket().onClose(() => {
  if (
    onlineSessionState.netMode !== "server" ||
    !onlineSessionState.onlineRoomId ||
    onlineSessionState.leavingRoom ||
    onlineLobbyState._autoReconnecting
  )
    return;
  const room = onlineSessionState.onlineRoomId;
  beginReconnectUI(room, "Connection lost — trying to get back in…");
  keepRejoiningServerRoom(room);
});
