// @ts-nocheck
import { clock } from "../core/clock";
import { fxRandom } from "../core/random";
import { PIECES } from "@tetrizz/core";
import { storage } from "../core/storage";
import { perfState } from "../core/metrics";
import { log } from "../core/logger";
import { netConfig } from "../net/net-config";
import { backendChoices, effectiveBackendChoice, parseBackendChoice } from "../net/backend-choice";
import {
  BLOCK_FINISHES,
  BLOCK_SHAPES,
  FINISH_LABEL,
  HAS_PATH2D,
  HID,
  MOBILE,
  MODE_SET,
  isReducedMotion,
  SDF_OPTS,
  SHAPE_LABEL,
  SPRINT_LINES,
  clamp,
  colsForMode,
  configState,
  visForMode,
} from "../core/config";
import { CANVAS_THEMES, COLOR_THEMES, applyColorTheme, themeState } from "../render/theme";
import {
  ACTIONS,
  ACTION_MAP,
  bindingsState,
  descKey,
  devOf,
  fillMissing,
  freshBindings,
  prettyDesc,
  rebuildReverse,
  saveBindings,
} from "../input/bindings";
import { GESTURE_ACTS, GESTURE_ACT_LABEL, game } from "../game/state";
import { voice } from "../engine/engine";
import { $, applyGeometry, layout, layoutState, savePractice } from "./layout";
import { drawHold, drawNexts, drawThemePreview, invalidateCellCache } from "../render/render";
import { fmtTimeP } from "./menus";
import { render } from "./screens";
import { MP, mpLobbySummary, versusLobbyState } from "../versus/lobby";
import { onlineSessionState } from "../net/online-session";

export const settingsState = {
  optsSnapshot: null,
  floaterAcc: 0,
};

export function saveOpts() {
  try {
    storage.set("tetris_das", configState.DAS);
    storage.set("tetris_arr", configState.ARR);
    storage.set("tetris_sdf", configState.sdfIdx);
    storage.set("tetris_fx", configState.fxStrength);
    storage.set("tetris_clearfx", configState.clearFx);
    storage.set("tetris_grid", configState.gridVis);
    storage.set("tetris_blockshape", configState.blockShape);
    storage.set("tetris_blockstyle", configState.blockStyle);
    storage.set("tetris_colortheme", configState.colorTheme);
    storage.set("tetris_vol", game.volume);
    storage.set("tetris_mouse", bindingsState.mouseEnabled ? "1" : "0");
    storage.set("tetris_mousesteer", bindingsState.mouseSteerOn ? "1" : "0");
    storage.set("tetris_ghost", bindingsState.ghostMode);
    storage.set("tetris_ghostOpacity", bindingsState.ghostOpacity);
    storage.set("tetris_bg", bindingsState.bgEnabled ? "1" : "0");
    storage.set("tetris_motion", configState.motion);
    storage.set("tetris_online_backend", configState.onlineBackend);
    storage.set("tetris_adaptive", perfState.adaptive ? "1" : "0");
    storage.set("tetris_touchbtns", bindingsState.touchBtnsOn ? "1" : "0");
    storage.set("tetris_swipe", bindingsState.swipeOn ? "1" : "0");
    storage.set("tetris_swipesens", configState.swipeSens);
    storage.set("tetris_gestures", JSON.stringify(game.gestures));
  } catch (_) {
    log.debug("ui/settings.saveOpts", _);
  }
}

export function saveAll() {
  saveOpts();
  saveBindings();
  savePractice();
}

export function snapOpts() {
  return JSON.stringify({
    DAS: configState.DAS,
    ARR: configState.ARR,
    sdfIdx: configState.sdfIdx,
    fxStrength: configState.fxStrength,
    clearFx: configState.clearFx,
    gridVis: configState.gridVis,
    blockShape: configState.blockShape,
    blockStyle: configState.blockStyle,
    colorTheme: configState.colorTheme,
    volume: game.volume,
    mouseEnabled: bindingsState.mouseEnabled,
    mouseSteerOn: bindingsState.mouseSteerOn,
    ghostMode: bindingsState.ghostMode,
    bgEnabled: bindingsState.bgEnabled,
    gestures: game.gestures,
    motion: configState.motion,
    onlineBackend: configState.onlineBackend,
    adaptive: perfState.adaptive,
  });
}

export function optsDirty() {
  return !!settingsState.optsSnapshot && snapOpts() !== settingsState.optsSnapshot;
}

export function restoreOpts() {
  if (!settingsState.optsSnapshot) return;
  try {
    const s = JSON.parse(settingsState.optsSnapshot);
    configState.DAS = s.DAS;
    configState.ARR = s.ARR;
    configState.sdfIdx = s.sdfIdx;
    configState.fxStrength = s.fxStrength;
    configState.clearFx = s.clearFx;
    configState.gridVis = s.gridVis;
    configState.blockShape = s.blockShape;
    configState.blockStyle = s.blockStyle;
    game.volume = s.volume;
    bindingsState.mouseEnabled = s.mouseEnabled;
    bindingsState.mouseSteerOn = s.mouseSteerOn;
    bindingsState.ghostMode =
      s.ghostMode === "off" || s.ghostMode === "gray" || s.ghostMode === "color"
        ? s.ghostMode
        : s.ghostGray === false
          ? "color"
          : s.ghostGray === true
            ? "gray"
            : bindingsState.ghostMode;
    bindingsState.bgEnabled = s.bgEnabled;
    game.gestures = s.gestures;
    configState.motion = s.motion ?? "auto";
    configState.onlineBackend = parseBackendChoice(s.onlineBackend);
    perfState.adaptive = s.adaptive ?? true;
    applyColorTheme(configState.colorTheme);
    invalidateCellCache();
    if (bindingsState.mouseEnabled) {
      fillMissing(bindingsState.bindings);
      rebuildReverse();
    }
    syncToggles();
    refreshOpts();
    updateVolUI();
    drawHold();
    drawNexts();
    drawThemePreview();
    render();
  } catch (_) {
    log.debug("ui/settings.restoreOpts", _);
  }
}

export function loadSettings() {
  try {
    const d = parseInt(storage.get("tetris_das"));
    if (!isNaN(d)) configState.DAS = clamp(d, 50, 300);
    const a = parseInt(storage.get("tetris_arr"));
    if (!isNaN(a)) configState.ARR = clamp(a, 0, 100);
    const s = parseInt(storage.get("tetris_sdf"));
    if (!isNaN(s)) configState.sdfIdx = clamp(s, 0, SDF_OPTS.length - 1);
    const fv = parseInt(storage.get("tetris_fx"));
    if (!isNaN(fv)) configState.fxStrength = clamp(fv, 0, 100);
    const cf = parseInt(storage.get("tetris_clearfx"));
    if (!isNaN(cf)) configState.clearFx = clamp(cf, 0, 100);
    const gv = parseInt(storage.get("tetris_grid"));
    if (!isNaN(gv)) configState.gridVis = clamp(gv, 0, 100);
    const _sws = parseInt(storage.get("tetris_swipesens"));
    if (!isNaN(_sws)) configState.swipeSens = clamp(_sws, 1, 10);
    const bshStored = storage.get("tetris_blockshape");
    if (bshStored && BLOCK_SHAPES.includes(bshStored)) configState.blockShape = bshStored;
    const bsOld = storage.get("tetris_blockstyle");
    if (bsOld) {
      if (BLOCK_FINISHES.includes(bsOld)) configState.blockStyle = bsOld;
      else if (["rounded", "square", "flat"].includes(bsOld)) {
        configState.blockShape = bsOld;
        configState.blockStyle = "matt";
      } else if (["bevel", "glossy", "glassy"].includes(bsOld)) {
        configState.blockShape = "rounded";
        configState.blockStyle = bsOld;
      }
    }
    if (configState.blockShape === "flat" && !HAS_PATH2D) configState.blockShape = "rounded";
    const vv = parseInt(storage.get("tetris_vol"));
    game.volume = isNaN(vv) ? 80 : clamp(vv, 0, 100);
    const mm = storage.get("tetris_mouse");
    bindingsState.mouseEnabled = mm === null ? !MOBILE.matches : mm === "1";
    bindingsState.mouseSteerOn = storage.get("tetris_mousesteer") !== "0";
    {
      const _g = storage.get("tetris_ghost");
      bindingsState.ghostMode =
        _g === "off" || _g === "gray" || _g === "color" ? _g : _g === "0" ? "color" : "gray";
    }
    const _gov = parseInt(storage.get("tetris_ghostOpacity"));
    if (!isNaN(_gov)) bindingsState.ghostOpacity = clamp(_gov, 0, 100);
    bindingsState.bgEnabled = storage.get("tetris_bg") !== "0";
    {
      const motion = storage.get("tetris_motion");
      configState.motion = motion === "on" || motion === "off" ? motion : "auto";
    }
    configState.onlineBackend = parseBackendChoice(storage.get("tetris_online_backend"));
    perfState.adaptive = storage.get("tetris_adaptive") !== "0";
    bindingsState.touchBtnsOn = storage.get("tetris_touchbtns") !== "0";
    bindingsState.swipeOn = storage.get("tetris_swipe") !== "0";
    game.muted = storage.get("tetris_muted") === "1";
    try {
      const gg = JSON.parse(storage.get("tetris_gestures"));
      if (gg && typeof gg === "object") {
        for (const k in GESTURE_ACTS) {
          if (GESTURE_ACTS[k].includes(gg[k])) game.gestures[k] = gg[k];
        }
      }
    } catch (_) {
      log.debug("ui/settings.loadSettings", _);
    }
  } catch (_) {
    log.debug("ui/settings.loadSettings#2", _);
  }
}

export function refreshOpts() {
  document.querySelectorAll(".step[data-s]").forEach((st) => {
    const s = st.dataset.s;
    const val = st.querySelector(".val");
    if (!val || val.querySelector("input")) return;
    if (s === "das") val.textContent = configState.DAS;
    else if (s === "arr") val.textContent = configState.ARR;
    else if (s === "sdf") {
      const f = SDF_OPTS[configState.sdfIdx];
      val.textContent = f === Infinity ? "∞" : f;
    } else if (s === "fx")
      val.textContent = configState.fxStrength > 0 ? configState.fxStrength : "OFF";
    else if (s === "clearFx")
      val.textContent = configState.clearFx > 0 ? configState.clearFx : "OFF";
    else if (s === "grid") val.textContent = configState.gridVis;
    else if (s === "swipeSens") val.textContent = configState.swipeSens;
    else if (s === "ghostOpacity") val.textContent = bindingsState.ghostOpacity;
  });
  updateVolUI();
  syncToggles();
}

/** Shows the online backend pick only when the build has more than one backend to pick from. */
export function syncOnlineBackendToggle() {
  const cfg = netConfig.current;
  const offered = backendChoices(cfg).length > 0;
  document.querySelectorAll<HTMLElement>("[data-netgrp]").forEach((el) => {
    el.style.display = offered ? "" : "none";
  });
  const shown = effectiveBackendChoice(cfg, configState.onlineBackend);
  document.querySelectorAll("[data-netbackend]").forEach((b) => {
    b.textContent = shown.toUpperCase();
  });
}

export function syncToggles() {
  document.querySelectorAll("[data-ghost]").forEach((b) => {
    b.textContent = bindingsState.ghostMode.toUpperCase();
    b.classList.toggle("off", bindingsState.ghostMode === "off");
  });
  document.querySelectorAll("[data-bg]").forEach((b) => {
    b.textContent = bindingsState.bgEnabled ? "ON" : "OFF";
    b.classList.toggle("off", !bindingsState.bgEnabled);
  });
  document.querySelectorAll("[data-motion]").forEach((b) => {
    b.textContent = configState.motion.toUpperCase();
    b.classList.toggle("off", configState.motion === "off");
  });
  syncOnlineBackendToggle();
  document.querySelectorAll("[data-adaptive]").forEach((b) => {
    b.textContent = perfState.adaptive ? "ON" : "OFF";
    b.classList.toggle("off", !perfState.adaptive);
  });
  document.querySelectorAll("[data-mouse]").forEach((b) => {
    b.textContent = bindingsState.mouseEnabled ? "ON" : "OFF";
    b.classList.toggle("off", !bindingsState.mouseEnabled);
  });
  document.querySelectorAll("[data-mousesteer]").forEach((b) => {
    b.textContent = bindingsState.mouseSteerOn ? "ON" : "OFF";
    b.classList.toggle("off", !bindingsState.mouseSteerOn);
  });
  document.querySelectorAll("[data-blockshape]").forEach((b) => {
    b.textContent = SHAPE_LABEL[configState.blockShape];
  });
  document.querySelectorAll("[data-blockstyle]").forEach((b) => {
    b.textContent = FINISH_LABEL[configState.blockStyle];
  });
  document.querySelectorAll("[data-colortheme]").forEach((b) => {
    b.textContent = configState.colorTheme.toUpperCase();
  });
  document.querySelectorAll("[data-gesture]").forEach((b) => {
    b.textContent = GESTURE_ACT_LABEL[game.gestures[b.dataset.gesture]] || "—";
  });
  document.querySelectorAll("[data-touchbtns]").forEach((b) => {
    b.textContent = bindingsState.touchBtnsOn ? "ON" : "OFF";
    b.classList.toggle("off", !bindingsState.touchBtnsOn);
  });
  document.querySelectorAll("[data-swipeges]").forEach((b) => {
    b.textContent = bindingsState.swipeOn ? "ON" : "OFF";
    b.classList.toggle("off", !bindingsState.swipeOn);
  });
}

export function cycleBlockShape() {
  let i = BLOCK_SHAPES.indexOf(configState.blockShape);
  do {
    i = (i + 1) % BLOCK_SHAPES.length;
  } while (!HAS_PATH2D && BLOCK_SHAPES[i] === "flat");
  configState.blockShape = BLOCK_SHAPES[i];
  invalidateCellCache();
  refreshOpts();
  drawHold();
  drawNexts();
  drawThemePreview();
  render();
}

export function cycleBlockStyle() {
  const i = BLOCK_FINISHES.indexOf(configState.blockStyle);
  configState.blockStyle = BLOCK_FINISHES[(i + 1) % BLOCK_FINISHES.length];
  invalidateCellCache();
  refreshOpts();
  drawHold();
  drawNexts();
  drawThemePreview();
  render();
}

export function cycleColorTheme() {
  const i = COLOR_THEMES.indexOf(configState.colorTheme);
  applyColorTheme(COLOR_THEMES[(i + 1) % COLOR_THEMES.length]);
  refreshOpts();
  drawHold();
  drawNexts();
  drawThemePreview();
  render();
}

function updateVolUI() {
  document.querySelectorAll(".vol-slider").forEach((s) => {
    s.value = game.volume;
    s.style.setProperty("--fill", game.volume + "%");
  });
  document.querySelectorAll(".vol-val").forEach((b) => {
    b.textContent = game.volume;
  });
}

export function onVolInput(e) {
  game.volume = clamp(+e.target.value, 0, 100);
  updateVolUI();
}

export function onVolChange() {
  voice(660, 0.08, "sine", 0.05, { filter: 3000 });
}

function loadScores() {
  try {
    const a = JSON.parse(storage.get("tetris_scores"));
    return Array.isArray(a) ? a : [];
  } catch (e) {
    log.debug("loadScores", e);
    return [];
  }
}

export function saveScoreEntry() {
  if (configState.mode === "practice" || configState.mode === "vsbot") return;
  const a = loadScores();
  a.push({
    d: new Date().toISOString(),
    m: configState.mode,
    s: game.score,
    l: game.lines,
    lv: game.level,
    t: Math.round(game.playMs),
  });
  while (a.length > 300) a.shift();
  try {
    storage.set("tetris_scores", JSON.stringify(a));
  } catch (_) {
    log.debug("ui/settings.saveScoreEntry", _);
  }
}

export function bestFor(m) {
  if (m === "practice" || m === "vsbot") return null;
  const a = loadScores().filter((e) => e.m === m);
  if (!a.length) return null;
  if (m === "sprint") {
    const done = a.filter((e) => e.l >= SPRINT_LINES);
    if (!done.length) return null;
    done.sort((x, y) => x.t - y.t);
    return done[0];
  }
  a.sort((x, y) => y.s - x.s);
  return a[0];
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    p(d.getMonth() + 1) +
    "-" +
    p(d.getDate()) +
    "  " +
    p(d.getHours()) +
    ":" +
    p(d.getMinutes())
  );
}

export function renderScoreList(m) {
  if (m === "practice") m = "endless";
  document
    .querySelectorAll("[data-scoretab]")
    .forEach((b) => b.classList.toggle("active", b.dataset.scoretab === m));
  const lists = document.querySelectorAll(".scoreList");
  if (!lists.length) return;
  let a = loadScores().filter((e) => e.m === m);
  if (m === "sprint") a.sort((x, y) => y.l - x.l || x.t - y.t);
  else a.sort((x, y) => y.s - x.s);
  a = a.slice(0, 10);
  const html = a.length
    ? a
        .map((e, i) => {
          let main, extra;
          if (m === "sprint") {
            main = e.l >= SPRINT_LINES ? fmtTimeP(e.t) : e.l + " LINES";
            extra = e.l >= SPRINT_LINES ? "CLEAR" : "DNF";
          } else if (m === "ultra") {
            main = e.s.toLocaleString("en-US");
            extra = e.l + " LINES";
          } else {
            main = e.s.toLocaleString("en-US");
            extra = "LV " + e.lv + " · " + e.l + " LINES";
          }
          return `<div class="srow${i === 0 ? " gold" : ""}"><span class="rk">${i + 1}</span><span class="sm"><span class="sv">${main}</span><span class="sd">${fmtDate(e.d)}</span></span><span class="sx">${extra}</span></div>`;
        })
        .join("")
    : '<div class="dev-note">No records yet — go set one!</div>';
  lists.forEach((el) => {
    el.innerHTML = html;
  });
}

export function clearScores() {
  try {
    storage.remove("tetris_scores");
  } catch (_) {
    log.debug("ui/settings.clearScores", _);
  }
  const tab = document.querySelector("[data-scoretab].active");
  renderScoreList(tab ? tab.dataset.scoretab : configState.mode);
  updateModeCards();
}

export function cfIsOpen() {
  return !$("cfModal").hidden;
}

export function askConfirm(html, okLabel, cb, extra) {
  extra = extra || {};
  bindingsState.pending = null;
  bindingsState.confirmCb = cb;
  bindingsState.cancelCb = extra.onCancel || null;
  $("cfText").innerHTML = html;
  $("cfOk").textContent = okLabel;
  $("cfOk").hidden = !!extra.hideOk;
  $("cfCancel").textContent = extra.cancelLabel || "CANCEL";
  $("cfCancel").hidden = !!extra.hideCancel;
  const stay = $("cfStay");
  if (extra.stayLabel) {
    stay.hidden = false;
    stay.textContent = extra.stayLabel;
  } else stay.hidden = true;
  $("cfModal").hidden = false;
  setTimeout(() => {
    try {
      $("cfOk").focus();
    } catch (_) {
      log.debug("ui/settings.askConfirm", _);
    }
  }, 0);
}

export function showGameAlert(html) {
  askConfirm(html, "OK", () => {}, { hideCancel: true });
}

export function closeCf() {
  bindingsState.confirmCb = null;
  bindingsState.cancelCb = null;
  bindingsState.pending = null;
  $("cfModal").hidden = true;
}

export function cfButtons() {
  return [$("cfOk"), $("cfStay"), $("cfCancel")].filter((b) => b && !b.hidden);
}

export function cfNav(dir) {
  const bs = cfButtons();
  if (!bs.length) return;
  let i = bs.indexOf(document.activeElement);
  i = i < 0 ? (dir > 0 ? 0 : bs.length - 1) : (i + dir + bs.length) % bs.length;
  try {
    bs[i].focus();
  } catch (_) {
    log.debug("ui/settings.cfNav", _);
  }
}

export function setTheme(t) {
  try {
    storage.set("tetris_theme", t);
  } catch (_) {
    log.debug("ui/settings.setTheme", _);
  }
  document.documentElement.dataset.theme = t;
  themeState.cvTheme = CANVAS_THEMES[t] || CANVAS_THEMES.dark;
  document.documentElement.style.colorScheme = "dark light";
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.content = t === "light" ? "#c2cfdc" : "#151c42";
  const csMeta = document.querySelector('meta[name="color-scheme"]');
  if (csMeta) csMeta.content = "dark light";
}

export function syncPracticeButtons() {
  const show = configState.mode === "practice";
  const p = $("pausePracticeBtn");
  if (p) p.style.display = show ? "" : "none";
  const o = $("overPracticeBtn");
  if (o) o.style.display = show ? "" : "none";
}

export function syncVsButtons() {
  const online = onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame;
  const show = configState.mode === "vsbot" || online;
  const lbl = "BACK TO LOBBY";
  const p = $("pauseVsBtn");
  if (p) {
    p.style.display = show ? "" : "none";
    const _ptx = p.querySelector(".mm-bar-tx");
    if (_ptx) _ptx.textContent = lbl;
    else p.textContent = lbl;
  }
  const o = $("overVsBtn");
  if (o) {
    o.style.display = show ? "" : "none";
    const _otx = o.querySelector(".mm-label");
    if (_otx) _otx.textContent = lbl;
    else o.textContent = lbl;
  }
  const ov = $("ovOver");
  if (ov) {
    const again = ov.querySelector('[data-nav="again"]');
    if (again) again.style.display = online ? "none" : "";
    ov.querySelectorAll('[data-nav="menu"]').forEach((b) => {
      const _ml = b.querySelector(".mm-label");
      if (_ml) _ml.textContent = "MAIN MENU";
      else b.textContent = "MAIN MENU";
    });
  }

  const _og = ov.querySelector(".over-grid");
  const _sr = $("saveReplayBtn");
  if (_og && _sr) {
    if (show) {
      const _vb = $("overVsBtn");
      _og.insertBefore(_sr, _vb ? _vb.nextSibling : null);
    } else {
      const _mc = _og.querySelector('[data-nav="menu"]');
      _og.insertBefore(_sr, _mc ? _mc.nextSibling : _og.firstChild);
    }
  }
}

export function selectMode(m) {
  if (!MODE_SET.has(m)) return;
  configState.mode = m;
  configState.COLS = colsForMode(m);
  configState.VIS = visForMode(m);
  configState.ROWS = configState.VIS + HID;
  applyGeometry();
  try {
    storage.set("tetris_mode", m);
  } catch (_) {
    log.debug("ui/settings.selectMode", _);
  }
  updateModeCards();
  syncPracticeButtons();
  syncVsButtons();
  requestAnimationFrame(layout);
  window.dispatchEvent(new Event("resize"));
}

export function updateModeCards() {
  document.querySelectorAll(".mode-card").forEach((c) => {
    const m = c.dataset.mode;
    const el = c.querySelector(".mc-best");
    if (!el) return;
    if (m === "practice") {
      el.textContent = "CUSTOM";
      return;
    }
    if (m === "vsbot") {
      el.textContent = mpLobbySummary();
      return;
    }
    const b = bestFor(m);
    el.textContent = b
      ? "BEST " + (m === "sprint" ? fmtTimeP(b.t) : b.s.toLocaleString("en-US"))
      : "BEST —";
  });
}

const PROMPT = {
  key: "PRESS A KEY…",
  mouse: "CLICK ANYWHERE / SCROLL…  (ESC cancel)",
  pad: "PRESS GP BUTTON / STICK…",
};

export function startListen(id, dev) {
  bindingsState.listening = { id, dev };
  bindingsState.pending = null;
  renderBindLists();
}

export function cancelListen() {
  bindingsState.listening = null;
  renderBindLists();
}

function afterBind(desc) {
  if (desc.t === "mouse" && !bindingsState.mouseEnabled) bindingsState.mouseEnabled = true;
  rebuildReverse();
  saveBindings();
  syncToggles();
}

export function capture(desc) {
  if (!bindingsState.listening) return;
  const dev = devOf(desc);
  if (dev !== bindingsState.listening.dev) return;
  const id = bindingsState.listening.id;
  const k = descKey(desc);
  bindingsState.lastBindAt = clock.now();
  if (bindingsState.bindings[id].some((d) => descKey(d) === k)) {
    cancelListen();
    return;
  }
  const from = [];
  for (const a of ACTIONS) {
    if (a.id === id) continue;
    if (bindingsState.bindings[a.id].some((d) => descKey(d) === k)) from.push(a);
  }
  if (from.length) {
    bindingsState.pending = { id, desc, from, pretty: prettyDesc(desc) };
    bindingsState.listening = null;
    renderBindLists();
    return;
  }
  bindingsState.bindings[id].push(desc);
  afterBind(desc);
  bindingsState.listening = null;
  renderBindLists();
}

export function confirmPending() {
  if (!bindingsState.pending) return;
  const { id, desc, from } = bindingsState.pending;
  for (const a of from)
    bindingsState.bindings[a.id] = bindingsState.bindings[a.id].filter(
      (d) => descKey(d) !== descKey(desc),
    );
  bindingsState.bindings[id].push(desc);
  afterBind(desc);
  bindingsState.pending = null;
  renderBindLists();
}

export function cancelPending() {
  bindingsState.pending = null;
  renderBindLists();
}

export function removeBinding(id, k) {
  bindingsState.bindings[id] = bindingsState.bindings[id].filter((d) => descKey(d) !== k);
  rebuildReverse();
  saveBindings();
  renderBindLists();
}

export function resetAction(id) {
  const fb = freshBindings();
  bindingsState.bindings[id] = fb[id];
  rebuildReverse();
  saveBindings();
  renderBindLists();
}

export function showNote(m) {
  document.querySelectorAll("[data-bindnote]").forEach((e) => {
    e.textContent = m;
  });
  clearTimeout(bindingsState.noteT);
  bindingsState.noteT = setTimeout(() => {
    if (!bindingsState.pending)
      document.querySelectorAll("[data-bindnote]").forEach((e) => {
        e.textContent = "";
      });
  }, 3500);
}

export function showEditNote(m, where) {
  document
    .querySelectorAll(
      where ? '[data-editnote="' + where + '"]' : '[data-editnote]:not([data-editnote="list"])',
    )
    .forEach((e) => {
      e.textContent = m;
    });
  clearTimeout(bindingsState.editNoteT);
  bindingsState.editNoteT = setTimeout(() => {
    document.querySelectorAll("[data-editnote]").forEach((e) => {
      e.textContent = "";
    });
  }, 2600);
}

export function renderBindLists() {
  if (bindingsState.menuView !== "controls" && !bindingsState.listening && !bindingsState.pending)
    return;
  ["key", "mouse", "pad"].forEach((dev) => {
    const html = ACTIONS.map((a) => {
      const list = bindingsState.bindings[a.id].filter((d) => devOf(d) === dev);
      const chips = list
        .map(
          (d) =>
            `<span class="bchip">${prettyDesc(d)}<button class="rm" type="button" data-act="${a.id}" data-k="${descKey(d)}" title="Remove">×</button></span>`,
        )
        .join("");
      const listeningHere =
        bindingsState.listening &&
        bindingsState.listening.id === a.id &&
        bindingsState.listening.dev === dev;
      const add = listeningHere
        ? `<span class="listening">${PROMPT[dev]}<button class="cancellisten" type="button" title="Cancel">×</button></span>`
        : `<button class="addbind" type="button" data-act="${a.id}" title="Add binding">+</button>`;
      const rst = `<button class="rstrow" type="button" data-act="${a.id}" title="Reset">↺</button>`;
      return `<div class="bindrow" data-act="${a.id}"><span class="bl">${a.label}</span><span class="bchips">${chips}${add}${rst}</span></div>`;
    }).join("");
    document.querySelectorAll('.bindList[data-dev="' + dev + '"]').forEach((el) => {
      el.innerHTML = html;
    });
  });
  const m = $("cfModal");
  if (m) {
    if (bindingsState.pending) {
      $("cfOk").textContent = "MOVE IT HERE";
      $("cfCancel").textContent = "CANCEL";
      $("cfStay").hidden = true;
      m.hidden = false;
      $("cfText").innerHTML =
        "⚠ <b>" +
        bindingsState.pending.pretty +
        "</b> is already used by <b>" +
        bindingsState.pending.from.map((a) => a.label).join(", ") +
        "</b>. Move it to <b>" +
        ACTION_MAP[bindingsState.pending.id].label +
        "</b>?";
    } else if (!bindingsState.confirmCb) m.hidden = true;
  }
}

const FLOATER_INTERVAL = 3000;

const activeTypes = new Set();

const floaterRects = [];

const floaterMax = () => (MOBILE.matches ? 3 : 7);

const floaterSize = () => (MOBILE.matches ? (7 + fxRandom() * 6) | 0 : (15 + fxRandom() * 14) | 0);

function pieceBounds(t) {
  const cs = PIECES[t].cells[0];
  let x0 = 9,
    x1 = -9,
    y0 = 9,
    y1 = -9;
  cs.forEach(([x, y]) => {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  });
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function freeZones() {
  const vww = innerWidth,
    vhh = innerHeight;
  const hb = layoutState.headerEl.getBoundingClientRect().bottom;
  if (game.state !== "playing" && game.state !== "countdown" && game.state !== "vsround")
    return [{ x: 0, y: hb, w: vww, h: vhh - hb }];
  const tb = $("touch");
  const barBottom = getComputedStyle(tb).display !== "none" ? tb.getBoundingClientRect().top : vhh;
  if (barBottom - hb < 24) return [];
  const cell = layoutState.wrap.clientWidth / Math.max(1, configState.COLS);
  const obs = [];
  const addObs = (el, withTop) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const top = withTop ? Math.min(r.top, r.top - 3 * cell) : r.top;
    obs.push({ x: r.left, y: top, w: r.width, h: r.bottom - top });
  };
  document.querySelectorAll(".col").forEach((el) => addObs(el, false));
  addObs(layoutState.wrap, true);
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) {
    document.querySelectorAll("#botWrap,.mpWrap").forEach((el) => {
      if (el !== layoutState.wrap) addObs(el, true);
    });
  }
  const xs = [0, vww],
    ys = [hb, barBottom];
  for (const o of obs) {
    xs.push(clamp(o.x, 0, vww), clamp(o.x + o.w, 0, vww));
    ys.push(clamp(o.y, hb, barBottom), clamp(o.y + o.h, hb, barBottom));
  }
  const ux = [...new Set(xs)].sort((a, b) => a - b),
    uy = [...new Set(ys)].sort((a, b) => a - b);
  const z = [];
  for (let i = 0; i < ux.length - 1; i++)
    for (let j = 0; j < uy.length - 1; j++) {
      const cx0 = ux[i],
        cx1 = ux[i + 1],
        cy0 = uy[j],
        cy1 = uy[j + 1];
      if (cx1 - cx0 < 2 || cy1 - cy0 < 2) continue;
      const mx = (cx0 + cx1) / 2,
        my = (cy0 + cy1) / 2;
      let blocked = false;
      for (const o of obs) {
        if (mx > o.x && mx < o.x + o.w && my > o.y && my < o.y + o.h) {
          blocked = true;
          break;
        }
      }
      if (!blocked) z.push({ x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 });
    }
  return z;
}

function findFloaterSpot(fw, fh, zones, pad) {
  const good = zones.filter((z) => z.w >= fw + 4 && z.h >= fh + 4);
  if (!good.length) return null;
  let best = null,
    bestScore = -1;
  for (let tries = 0; tries < 30; tries++) {
    const z = good[(fxRandom() * good.length) | 0];
    const x = z.x + fxRandom() * Math.max(0, z.w - fw);
    const y = z.y + fxRandom() * Math.max(0, z.h - fh);
    let ok = true;
    for (const r of floaterRects) {
      if (!(
        x + fw + pad < r.x ||
        r.x + r.w + pad < x ||
        y + fh + pad < r.y ||
        r.y + r.h + pad < y
      )) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let minDist = 1e9;
    const cx = x + fw / 2,
      cy = y + fh / 2;
    for (const r of floaterRects) {
      const d = Math.hypot(cx - (r.x + r.w / 2), cy - (r.y + r.h / 2));
      if (d < minDist) minDist = d;
    }
    const score = floaterRects.length ? minDist : 1e9;
    if (score > bestScore) {
      bestScore = score;
      best = { x: x, y: y };
    }
  }
  return best;
}

export function spawnFloater() {
  if (!bindingsState.bgEnabled || isReducedMotion()) return;
  if (activeTypes.size >= floaterMax()) return;
  const s = floaterSize();
  const avail = [];
  for (let t = 0; t < 7; t++) {
    if (!activeTypes.has(t)) avail.push(t);
  }
  if (!avail.length) return;
  const zones = freeZones();
  const pad = Math.max(10, s * 0.6);
  for (const t of avail) {
    if (activeTypes.size >= floaterMax()) break;
    const b = pieceBounds(t);
    const fw = b.w * s,
      fh = b.h * s;
    const spot = findFloaterSpot(fw, fh, zones, pad);
    if (!spot) continue;
    const x = spot.x,
      y = spot.y;
    const rectRef = { x: x, y: y, w: fw, h: fh };
    floaterRects.push(rectRef);
    const el = document.createElement("div");
    el.className = "fpiece";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.setProperty("--c", PIECES[t].c);
    el.style.setProperty("--d", (13 + fxRandom() * 7).toFixed(1) + "s");
    el.style.setProperty("--op", (0.08 + fxRandom() * 0.05).toFixed(2));
    el.style.setProperty("--dx", ((fxRandom() * 30 - 15) | 0) + "px");
    el.style.setProperty("--dy", (-(16 + fxRandom() * 20) | 0) + "px");
    PIECES[t].cells[0].forEach(([cx, cy]) => {
      const i = document.createElement("i");
      i.style.left = cx * s + "px";
      i.style.top = cy * s + "px";
      i.style.width = s - 2 + "px";
      i.style.height = s - 2 + "px";
      el.appendChild(i);
    });
    document.body.appendChild(el);
    activeTypes.add(t);
    el.addEventListener("animationend", () => {
      el.remove();
      activeTypes.delete(t);
      const _i = floaterRects.indexOf(rectRef);
      if (_i >= 0) floaterRects.splice(_i, 1);
    });
  }
  return;
}

export function maybeSpawnFloater(dt) {
  if (!bindingsState.bgEnabled || perfState.tier >= 1) return;
  settingsState.floaterAcc += dt;
  if (settingsState.floaterAcc >= FLOATER_INTERVAL) {
    settingsState.floaterAcc -= FLOATER_INTERVAL;
    spawnFloater();
  }
}

export function syncBg() {
  if (!bindingsState.bgEnabled || isReducedMotion()) {
    document.querySelectorAll(".fpiece").forEach((e) => e.remove());
    activeTypes.clear();
    floaterRects.length = 0;
  }
}

export function snapState() {
  return {
    st: game.state === "editing" ? "playing" : game.state,
    board: game.board.map((r) => r.slice()),
    piece: game.piece
      ? { ...game.piece, lastRotate: game.piece.lastRotate ? { ...game.piece.lastRotate } : null }
      : null,
    hold: game.hold,
    holdUsed: game.holdUsed,
    queue: game.queue.slice(),
    score: game.score,
    lines: game.lines,
    level: game.level,
    combo: game.combo,
    maxCombo: game.maxCombo,
    b2bChain: game.b2bChain,
    pieces: game.pieces,
    playMs: game.playMs,
    gravMs: isFinite(game.gravMs) ? game.gravMs : -1,
    gravT: game.gravT,
    practiceNextGarbage: configState.practiceNextGarbage,
    sharedStream:
      versusLobbyState.sharedStream !== undefined
        ? versusLobbyState.sharedStream.slice()
        : undefined,
    playerPtr: versusLobbyState.playerPtr !== undefined ? versusLobbyState.playerPtr : undefined,
    vs: vsSessionSnap(),
  };
}

function vsSessionSnap() {
  if (versusLobbyState.vsActive === undefined || !versusLobbyState.vsActive || !MP.stations.length)
    return undefined;
  if (onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame)
    return undefined;
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator)
    return undefined;
  return {
    submode: versusLobbyState.vs.submode,
    round: versusLobbyState.vsRound,
    wins: MP.wins.slice(0, 4),
    cum: MP.cum.map(function (c) {
      return {
        lines: c.lines,
        pieces: c.pieces,
        ms: c.ms,
        combo: c.combo,
        score: c.score,
        atk: c.atk || 0,
        recv: c.recv || 0,
        lvl: c.lvl || 1,
      };
    }),
    time: versusLobbyState.vsTime,
    qs: MP.qs.map(function (q) {
      return q.map(function (ch) {
        return { holes: ch.holes.slice(), state: ch.state, t0: ch.t0 };
      });
    }),
    ptrs: MP.ptrs.slice(),
    stream: versusLobbyState.sharedStream.slice(),
    lastHole: MP.lastHole.slice(),
    stations: MP.stations.map(function (st) {
      return {
        slot: st.slot,
        board: st.board.map(function (r) {
          return r.slice();
        }),
        piece: st.piece
          ? { t: st.piece.type, r: st.piece.rot, x: st.piece.x, y: st.piece.y }
          : null,
        queue: st.queue.slice(),
        hold: st.hold,
        holdUsed: st.holdUsed ? 1 : 0,
        score: st.score,
        lines: st.lines,
        level: st.level,
        combo: st.combo,
        maxCombo: st.maxCombo,
        b2b: st.b2b,
        pieces: st.pieces,
        sent: st.sent,
        alive: st.alive ? 1 : 0,
        left: st.left ? 1 : 0,
        gravMs: isFinite(st.gravMs) ? st.gravMs : -1,
        gravT: st.gravT,
        timeMs: st.timeMs,
      };
    }),
  };
}
