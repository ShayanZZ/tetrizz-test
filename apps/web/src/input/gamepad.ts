// @ts-nocheck
import { softMs } from "../core/config";
import { bindingsState } from "./bindings";
import { game, recomputeSoft } from "../game/state";
import { fx } from "../engine/engine";
import { $ } from "../ui/layout";
import { tryRotate } from "../render/render";
import {
  confirmMenu,
  doHold,
  gameState,
  handleBack,
  hardDrop,
  menuOpen,
  softInstant,
  softStep,
} from "../game/game";
import { kbNavDir } from "../ui/menus";
import { cancelPending, capture, cfButtons, cfIsOpen, cfNav, closeCf } from "../ui/settings";
import {
  fireDown,
  fireUp,
  mpFireDown,
  mpFireUp,
  mpTouchOwner,
  pressDir,
  releaseDir,
} from "../ui/controls";
import { MP, versusLobbyState } from "../versus/lobby";
import { stHardDrop, stHold, stPressDir, stReleaseDir, stRotate } from "../versus/stations";
import { onlineSessionState } from "../net/online-session";

const gamepadState = {
  gpPrev: null,
  gpNavHold: { dir: "", t: 0, acc: 0 },
  _gpAcc: 0,
};

const GP_DAS = 250,
  GP_ARR = 90;

function gpNav(dir) {
  if (cfIsOpen()) {
    cfNav(dir === "left" || dir === "up" ? -1 : 1);
  } else if (menuOpen()) {
    gameState.kbNavActive = true;
    kbNavDir(dir);
  }
}

function mpPollPads(pads) {
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) return;
  for (let k = 0; k < pads.length; k++) {
    const gp = pads[k];
    const owner = MP.stations.find((st) => {
      const c = versusLobbyState.vs.players[st.slot];
      return !st.isBot && c.type === "user" && c.dev === "pad" + k;
    });
    if (!owner) continue;
    const prev = MP.padPrev[k];
    if (!prev || prev.b.length !== gp.buttons.length) {
      MP.padPrev[k] = { b: gp.buttons.map((x) => x.pressed), a: [0, 0] };
      continue;
    }
    for (let i = 0; i < gp.buttons.length; i++) {
      const p = gp.buttons[i].pressed,
        w = prev.b[i];
      prev.b[i] = p;
      if (p && !w) {
        const act = bindingsState.reverse["p:b" + i];
        if (act) mpFireDown(owner, act);
      } else if (!p && w) {
        const act = bindingsState.reverse["p:b" + i];
        if (act) mpFireUp(owner, act);
      }
    }
    for (let ai = 0; ai < 2; ai++) {
      const v = gp.axes[ai] || 0;
      const dir = v > 0.5 ? 1 : v < -0.5 ? -1 : 0;
      const pd = prev.a[ai];
      if (dir !== pd) {
        if (pd !== 0) {
          const act = bindingsState.reverse["p:a" + ai + ":" + pd];
          if (act) mpFireUp(owner, act);
        }
        if (dir !== 0) {
          const act = bindingsState.reverse["p:a" + ai + ":" + dir];
          if (act) mpFireDown(owner, act);
        }
        prev.a[ai] = dir;
      }
    }
  }
}

export function pollGamepad(dt) {
  if (game.editMode) return;
  gamepadState._gpAcc += dt;
  const _gpInGame =
    game.state === "playing" || game.state === "countdown" || game.state === "vsround";
  if (!_gpInGame && gamepadState._gpAcc < 100) return;
  gamepadState._gpAcc = 0;
  const pads = [];
  try {
    const gs = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const x of gs) {
      if (x) pads.push(x);
    }
  } catch (_) {
    return;
  }
  if (
    versusLobbyState.vsActive !== undefined &&
    versusLobbyState.vsActive &&
    (game.state === "playing" || game.state === "countdown")
  ) {
    mpPollPads(pads);
    return;
  }
  const gp = pads[0] || null;
  if (!gp) {
    gamepadState.gpPrev = null;
    return;
  }
  if (!gamepadState.gpPrev || gamepadState.gpPrev.b.length !== gp.buttons.length) {
    gamepadState.gpPrev = { b: gp.buttons.map((x) => x.pressed), a: [0, 0] };
    return;
  }
  if (bindingsState.listening) {
    for (let i = 0; i < gp.buttons.length; i++) {
      const p = gp.buttons[i].pressed,
        w = gamepadState.gpPrev.b[i];
      if (p && !w && bindingsState.listening.dev === "pad") capture({ t: "pad", b: i });
      gamepadState.gpPrev.b[i] = p;
    }
    for (let ai = 0; ai < 2; ai++) {
      const v = gp.axes[ai] || 0;
      const dir = v > 0.5 ? 1 : v < -0.5 ? -1 : 0;
      const prev = gamepadState.gpPrev.a[ai];
      if (dir !== prev) {
        if (dir !== 0 && bindingsState.listening.dev === "pad")
          capture({ t: "pad", axis: ai, dir });
        gamepadState.gpPrev.a[ai] = dir;
      }
    }
    return;
  }
  const inUi = menuOpen() || cfIsOpen();
  for (let i = 0; i < gp.buttons.length; i++) {
    const p = gp.buttons[i].pressed,
      w = gamepadState.gpPrev.b[i];
    gamepadState.gpPrev.b[i] = p;
    const isNav = i >= 12 && i <= 15;
    if (isNav && inUi) continue;
    if (p && !w) {
      if (cfIsOpen()) {
        if (i === 0 || i === 9) {
          const ae = document.activeElement;
          if (ae && cfButtons().indexOf(ae) >= 0) ae.click();
          else $("cfOk").click();
        } else if (i === 1) {
          if (bindingsState.pending) cancelPending();
          else closeCf();
        }
      } else if (menuOpen()) {
        gameState.kbNavActive = true;
        if (i === 0 || i === 9) confirmMenu();
        else if (i === 1) handleBack();
        else {
          const act = bindingsState.reverse["p:b" + i];
          if (act) fireDown(act);
        }
      } else if (game.state !== "playing" && (i === 0 || i === 9)) confirmMenu();
      else {
        const act = bindingsState.reverse["p:b" + i];
        if (act) fireDown(act);
      }
    } else if (!p && w) {
      const act = bindingsState.reverse["p:b" + i];
      if (act) fireUp(act);
    }
  }
  for (let ai = 0; ai < 2; ai++) {
    const v = gp.axes[ai] || 0;
    const dir = v > 0.5 ? 1 : v < -0.5 ? -1 : 0;
    const prev = gamepadState.gpPrev.a[ai];
    if (dir !== prev) {
      if (prev !== 0) {
        const act = bindingsState.reverse["p:a" + ai + ":" + prev];
        if (act) fireUp(act);
      }
      if (dir !== 0) {
        const act = bindingsState.reverse["p:a" + ai + ":" + dir];
        if (act) fireDown(act);
      }
      gamepadState.gpPrev.a[ai] = dir;
    }
  }
  if (inUi) {
    let dir = "";
    if (gp.buttons[12] && gp.buttons[12].pressed) dir = "up";
    else if (gp.buttons[13] && gp.buttons[13].pressed) dir = "down";
    else if (gp.buttons[14] && gp.buttons[14].pressed) dir = "left";
    else if (gp.buttons[15] && gp.buttons[15].pressed) dir = "right";
    if (!dir) {
      const ax = gp.axes[0] || 0,
        ay = gp.axes[1] || 0;
      if (ay < -0.5) dir = "up";
      else if (ay > 0.5) dir = "down";
      else if (ax < -0.5) dir = "left";
      else if (ax > 0.5) dir = "right";
    }
    if (dir) {
      if (gamepadState.gpNavHold.dir !== dir) {
        gamepadState.gpNavHold = { dir, t: 0, acc: 0 };
        gpNav(dir);
      } else {
        gamepadState.gpNavHold.t += dt;
        if (gamepadState.gpNavHold.t >= GP_DAS) {
          gamepadState.gpNavHold.acc += dt;
          while (gamepadState.gpNavHold.acc >= GP_ARR) {
            gamepadState.gpNavHold.acc -= GP_ARR;
            gpNav(dir);
          }
        }
      }
    } else gamepadState.gpNavHold = { dir: "", t: 0, acc: 0 };
  } else gamepadState.gpNavHold = { dir: "", t: 0, acc: 0 };
}

function ownerForBar(el) {
  if (versusLobbyState.vsActive === undefined || !versusLobbyState.vsActive || !MP.stations.length)
    return null;
  if (el && el.id === "touch2") {
    const st = MP.stations[1];
    if (st && !st.isBot) return st;
  }
  if (document.body.classList.contains("splitMob")) {
    const st = MP.stations[0];
    if (st && !st.isBot) return st;
  }
  return mpTouchOwner();
}

export function btnDown(a, barEl) {
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) return;
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
    const st = ownerForBar(barEl);
    if (st) {
      switch (a) {
        case "r180":
          stRotate(st, 2);
          break;
        case "ccw":
          stRotate(st, -1);
          break;
        case "cw":
          stRotate(st, 1);
          break;
        case "hold":
          stHold(st);
          break;
        case "hard":
          stHardDrop(st);
          break;
        case "soft":
          mpFireDown(st, "softDrop");
          break;
        case "left":
          stPressDir(st, -1);
          break;
        case "right":
          stPressDir(st, 1);
          break;
      }
    }
    return;
  }
  switch (a) {
    case "r180":
      if (game.state === "playing") tryRotate(2);
      break;
    case "ccw":
      if (game.state === "playing") tryRotate(-1);
      break;
    case "cw":
      if (game.state === "playing") tryRotate(1);
      break;
    case "hold":
      doHold();
      break;
    case "hard":
      hardDrop();
      break;
    case "soft":
      game.btnSoft = true;
      recomputeSoft();
      if (game.state === "playing") {
        if (softMs() === 0) softInstant();
        else softStep();
      }
      break;
    case "left":
      if (game.state === "playing") pressDir(-1);
      break;
    case "right":
      if (game.state === "playing") pressDir(1);
      break;
  }
}

export function btnUp(a, barEl) {
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
    const st = ownerForBar(barEl);
    if (st) {
      if (a === "soft") mpFireUp(st, "softDrop");
      else if (a === "left") stReleaseDir(st, -1);
      else if (a === "right") stReleaseDir(st, 1);
    }
    return;
  }
  if (a === "soft") {
    game.btnSoft = false;
    recomputeSoft();
  } else if (a === "left") {
    releaseDir(-1);
    fx.tx = 0;
  } else if (a === "right") {
    releaseDir(1);
    fx.tx = 0;
  }
}
