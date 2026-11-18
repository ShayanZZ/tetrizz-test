// @ts-nocheck
import { clock } from "../core/clock";
import { log } from "../core/logger";
import { configState } from "../core/config";
import { ACTION_MAP, bindingsState } from "../input/bindings";
import { game } from "../game/state";
import { $, beginRestartHold, cancelRestartHold, layout } from "../ui/layout";
import {
  confirmMenu,
  gameState,
  goBack,
  menuOpen,
  startCountdown,
  toggleMute,
  togglePause,
} from "../game/game";
import { kbNavDir } from "../ui/menus";
import {
  cancelListen,
  cancelPending,
  capture,
  cfButtons,
  cfIsOpen,
  cfNav,
  closeCf,
} from "../ui/settings";
import { changePracticeLevel, exitEdit, redo, toggleEdit, undo } from "../practice/practice";
import { activateStepButton, stopStepHold } from "../practice/snapshot";
import {
  fireDown,
  fireUp,
  gameRegion,
  inOverlay,
  mpFireDown,
  mpFireUp,
  mpKeyStation,
  mpMouseStation,
  mpSteer,
  mpWheelPulse,
  playRegion,
  steerWithMouse,
} from "../ui/controls";
import { versusLobbyState } from "../versus/lobby";
import { wheelPulse } from "../input/keyboard";
import { onlineSessionState } from "../net/online-session";

window.addEventListener("keydown", (e) => {
  const code = e.code;
  if (bindingsState.listening) {
    e.preventDefault();
    if (code === "Escape") cancelListen();
    else if (bindingsState.listening.dev === "key") capture({ t: "key", code });
    return;
  }
  const _tg = e.target && e.target.tagName;
  if (_tg === "INPUT" || _tg === "TEXTAREA") return;
  if (e.repeat) {
    if (menuOpen() && !cfIsOpen() && $("pieceModal").hidden) {
      if (code === "ArrowDown") {
        e.preventDefault();
        kbNavDir("down");
      } else if (code === "ArrowUp") {
        e.preventDefault();
        kbNavDir("up");
      } else if (code === "ArrowRight") {
        e.preventDefault();
        kbNavDir("right");
      } else if (code === "ArrowLeft") {
        e.preventDefault();
        kbNavDir("left");
      } else if (
        code === "Enter" &&
        gameState.kbFocusEl &&
        !gameState.kbFocusEl.disabled &&
        gameState.kbFocusEl.matches &&
        gameState.kbFocusEl.matches(".step button[data-d]")
      ) {
        e.preventDefault();
        activateStepButton(gameState.kbFocusEl);
      }
    } else if (game.state === "playing") {
      if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
        const act = bindingsState.reverse["k:" + code];
        if (act) e.preventDefault();
        return;
      }
      const act = bindingsState.reverse["k:" + code];
      if (act && ACTION_MAP[act].mode === "hold") {
        e.preventDefault();
        fireDown(act);
      }
    }
    return;
  }
  if (cfIsOpen()) {
    if (code === "Escape") {
      e.preventDefault();
      if (bindingsState.pending) cancelPending();
      else closeCf();
      return;
    }
    if (code === "ArrowRight" || code === "ArrowDown") {
      e.preventDefault();
      cfNav(1);
      return;
    }
    if (code === "ArrowLeft" || code === "ArrowUp") {
      e.preventDefault();
      cfNav(-1);
      return;
    }
    if (code === "Tab") {
      e.preventDefault();
      cfNav(e.shiftKey ? -1 : 1);
      return;
    }
    if (code === "Enter" || code === "Space") {
      e.preventDefault();
      const ae = document.activeElement;
      if (ae && cfButtons().indexOf(ae) >= 0) ae.click();
      else $("cfOk").click();
      return;
    }
    return;
  }
  if (
    configState.mode === "practice" &&
    !e.ctrlKey &&
    !e.metaKey &&
    bindingsState.reverse["k:" + code] === "editBoard" &&
    (game.state === "playing" || game.editMode)
  ) {
    e.preventDefault();
    toggleEdit();
    return;
  }
  if (configState.mode === "practice" && (e.ctrlKey || e.metaKey)) {
    if (code === "KeyZ" && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if (code === "KeyY" || (code === "KeyZ" && e.shiftKey)) {
      e.preventDefault();
      redo();
      return;
    }
  }
  if (game.editMode) {
    e.preventDefault();
    if (code === "Escape") exitEdit();
    else if (code === "Equal" || code === "NumpadAdd") changePracticeLevel(1);
    else if (code === "Minus" || code === "NumpadSubtract") changePracticeLevel(-1);
    return;
  }
  if (e.target && e.target.type === "range") return;
  const act = bindingsState.reverse["k:" + code];
  if (act === "restart" && (game.state === "playing" || game.state === "countdown")) {
    e.preventDefault();
    if (game.state === "countdown") startCountdown();
    else beginRestartHold();
    return;
  }
  if (game.state === "playing") {
    const _spec = onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator;
    if (_spec) {
      if (act === "pause" || act === "mute") {
        e.preventDefault();
        if (act === "pause") togglePause();
        else toggleMute();
      }
      return;
    }
    if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
      if (act) {
        e.preventDefault();
        if (act === "pause") togglePause();
        else if (act === "mute") toggleMute();
        else if (act === "restart") beginRestartHold();
        else mpFireDown(mpKeyStation(), act);
      }
      return;
    }
    if (act) {
      e.preventDefault();
      fireDown(act);
    }
    return;
  }
  if (menuOpen()) {
    if (code === "ArrowDown") {
      e.preventDefault();
      kbNavDir("down");
      return;
    }
    if (code === "ArrowUp") {
      e.preventDefault();
      kbNavDir("up");
      return;
    }
    if (code === "ArrowRight") {
      e.preventDefault();
      kbNavDir("right");
      return;
    }
    if (code === "ArrowLeft") {
      e.preventDefault();
      kbNavDir("left");
      return;
    }
    if (code === "Enter") {
      e.preventDefault();
      if (gameState.kbFocusEl && gameState.kbFocusEl.isConnected && !gameState.kbFocusEl.disabled)
        gameState.kbFocusEl.click();
      else confirmMenu();
      return;
    }
    if (bindingsState.menuView !== "main" && code === "Escape") {
      e.preventDefault();
      goBack(bindingsState.openOverlayEl);
      return;
    }
    if (act === "restart") {
      e.preventDefault();
      if (game.state === "over") beginRestartHold();
      return;
    }
    if (act) {
      e.preventDefault();
      fireDown(act);
    }
    return;
  }
  if (act) {
    e.preventDefault();
    fireDown(act);
  }
});

window.addEventListener("keyup", (e) => {
  if (bindingsState.listening || game.editMode) return;
  const act = bindingsState.reverse["k:" + e.code];
  if (act === "restart") {
    cancelRestartHold();
    return;
  }
  if (act) {
    if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
      mpFireUp(mpKeyStation(), act);
      return;
    }
    fireUp(act);
  }
});

window.addEventListener("blur", () => {
  cancelRestartHold();
  stopStepHold();
});

window.addEventListener(
  "mousedown",
  (e) => {
    if (bindingsState.listening) {
      const cb = e.target.closest && e.target.closest(".cancellisten");
      if (!cb) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (bindingsState.listening.dev === "mouse") capture({ t: "mouse", b: e.button });
      }
      return;
    }
    if (game.editMode) return;
    if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) return;
    const btn = e.target.closest && e.target.closest("button, a, input, select, textarea");
    if (btn) {
      if (e.button !== 0) e.preventDefault();
      return;
    }
    if (inOverlay(e.target)) return;
    if (game.state === "playing" || game.state === "countdown") e.preventDefault();
    if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
      if (!bindingsState.mouseEnabled) return;
      const st = mpMouseStation();
      const act = bindingsState.reverse["m:b" + e.button];
      if (act && st) mpFireDown(st, act);
      return;
    }
    if (!bindingsState.mouseEnabled) return;
    const act = bindingsState.reverse["m:b" + e.button];
    if (act) fireDown(act);
  },
  true,
);

window.addEventListener("mouseup", (e) => {
  if (bindingsState.listening) {
    e.preventDefault();
    return;
  }
  if (game.editMode) return;
  if (e.target.closest && e.target.closest("button, a, input, select, textarea")) return;
  if (inOverlay(e.target)) return;
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
    if (!bindingsState.mouseEnabled) return;
    const st = mpMouseStation();
    const act = bindingsState.reverse["m:b" + e.button];
    if (act && st) mpFireUp(st, act);
    return;
  }
  if (!bindingsState.mouseEnabled) return;
  const act = bindingsState.reverse["m:b" + e.button];
  if (act) fireUp(act);
});

window.addEventListener(
  "auxclick",
  (e) => {
    if (bindingsState.listening) {
      e.preventDefault();
      return;
    }
    if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) return;
    if ((game.state === "playing" || game.state === "countdown") && !inOverlay(e.target))
      e.preventDefault();
  },
  true,
);

window.addEventListener("contextmenu", (e) => {
  if (bindingsState.listening) {
    e.preventDefault();
    return;
  }
  if (game.editMode) {
    e.preventDefault();
    return;
  }
  if (e.target.closest && e.target.closest(".step button[data-d]")) {
    e.preventDefault();
    return;
  }
  if (game.state === "playing" || game.state === "countdown") {
    if (
      (e.target.closest && e.target.closest("button, a, input, select, textarea")) ||
      gameRegion(e.target)
    )
      e.preventDefault();
  }
});

window.addEventListener("mousemove", (e) => {
  if (
    bindingsState.listening ||
    game.editMode ||
    !bindingsState.mouseEnabled ||
    !bindingsState.mouseSteerOn
  )
    return;
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) return;
  if (!playRegion(e.target)) return;
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
    mpSteer(e);
    return;
  }
  steerWithMouse(e.clientX);
});

window.addEventListener(
  "resize",
  function () {
    try {
      const coarse = window.matchMedia("(pointer:coarse)").matches;
      if (!coarse) {
        document.body.classList.remove("splitMob", "mobOnMulti", "revsplit");
      }
      const _t = document.getElementById("touch");
      if (_t) _t.style.display = "";
      const _t2 = document.getElementById("touch2");
      if (_t2) _t2.style.display = "";
      const _m = document.querySelector("main");
      if (_m) _m.style.paddingBottom = "";
      const _ba = document.getElementById("botArena");
      if (_ba) {
        _ba.style.paddingTop = "";
        _ba.style.paddingBottom = "";
        _ba.style.alignContent = "";
      }
      layout();
    } catch (_) {
      log.debug("boot/27-keyboard", _);
    }
  },
  { passive: true },
);

window.addEventListener(
  "wheel",
  (e) => {
    if (bindingsState.listening) {
      if (bindingsState.listening.dev === "mouse") {
        e.preventDefault();
        const w = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
        if (w) capture({ t: "mouse", w });
      }
      return;
    }
    if (game.editMode) return;
    if (inOverlay(e.target)) return;
    const inGame = game.state === "playing" || game.state === "countdown";
    if (inGame) e.preventDefault();
    if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
      if (bindingsState.mouseEnabled && gameRegion(e.target)) {
        const w = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
        if (w) {
          const act = bindingsState.reverse["m:w" + w];
          const st = mpMouseStation();
          if (act && st) mpWheelPulse(st, act);
        }
      }
      return;
    }
    if (bindingsState.mouseEnabled && gameRegion(e.target)) {
      const w = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
      if (w) {
        const act = bindingsState.reverse["m:w" + w];
        if (act) {
          if (ACTION_MAP[act] && ACTION_MAP[act].mode === "hold") wheelPulse(act);
          else fireDown(act);
        }
      }
    }
  },
  { passive: false },
);

document.addEventListener(
  "click",
  (e) => {
    if (bindingsState.listening) {
      if (e.target.closest && e.target.closest(".cancellisten")) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (clock.now() - bindingsState.lastBindAt < 400) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);
