// @ts-nocheck
import { MOBILE, SPRINT_LINES, ULTRA_MS, configState } from "../core/config";
import { bindingsState } from "../input/bindings";
import { game } from "../game/state";
import { $, layoutState } from "./layout";
import { gameState, kbNav, modeCardsIn, setKbFocus, visibleButtons } from "../game/game";
import { MP, versusLobbyState, vsGarbageMode } from "../versus/lobby";

export const menusState = {
  _fitEpoch: 0,
};

export function kbNavDir(dir) {
  gameState._ptrInput = false;
  const ov = bindingsState.openOverlayEl;
  if (!ov) return;
  gameState.kbNavActive = true;
  if (bindingsState.menuView === "modes" || bindingsState.menuView === "main") {
    const cards = modeCardsIn(ov);
    if (cards.length) {
      let cur = cards.includes(gameState.kbFocusEl) ? gameState.kbFocusEl : null;
      if (!cur) {
        kbDefault(ov);
        cur = cards.includes(gameState.kbFocusEl) ? gameState.kbFocusEl : cards[0];
      }
      const r = cur.getBoundingClientRect();
      const cx = r.left + r.width / 2,
        cy = r.top + r.height / 2;
      let best = null,
        bestScore = Infinity;
      for (const card of cards) {
        if (card === cur) continue;
        const cr = card.getBoundingClientRect();
        const rx = cr.left + cr.width / 2,
          ry = cr.top + cr.height / 2;
        const dx = rx - cx,
          dy = ry - cy;
        let ok = false,
          sc = 0;
        if (dir === "down") {
          ok = dy > 6;
          sc = dy * 1.5 + Math.abs(dx) * 3;
        } else if (dir === "up") {
          ok = dy < -6;
          sc = -dy * 1.5 + Math.abs(dx) * 3;
        } else if (dir === "right") {
          ok = dx > 6;
          sc = dx * 1.5 + Math.abs(dy) * 3;
        } else if (dir === "left") {
          ok = dx < -6;
          sc = -dx * 1.5 + Math.abs(dy) * 3;
        }
        if (ok && sc < bestScore) {
          bestScore = sc;
          best = card;
        }
      }
      if (best) {
        setKbFocus(best);
        return;
      }
    }
  }
  kbNav(dir === "down" || dir === "right" ? 1 : -1);
}

export function kbDefault(ov) {
  const btns = visibleButtons(ov);
  const pick =
    btns.find((b) => b.classList.contains("primary")) ||
    btns.find((b) => b.classList.contains("mm-continue")) ||
    btns.find((b) => b.classList.contains("mode-card")) ||
    btns.find((b) => b.classList.contains("mm-card")) ||
    btns.find((b) => !b.classList.contains("back-btn")) ||
    btns[0] ||
    null;
  setKbFocus(pick);
}

export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

export function fmtTimeP(ms) {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + ":" + (r < 10 ? "0" : "") + r.toFixed(1);
}

export function setText(el, s) {
  if (el && el.__t !== s) {
    el.__t = s;
    el.textContent = s;
  }
}

function fitEl(el) {
  if (!el) return;
  const t = el.textContent,
    w = el.clientWidth;
  if (!w) return;
  if (el.__ft === t && el.__fw === w) return;
  el.__ft = t;
  el.__fw = w;
  el.style.removeProperty("font-size");
  if (el.scrollWidth <= w + 0.5) return;
  let fs = parseFloat(getComputedStyle(el).fontSize);
  for (let i = 0; i < 18 && el.scrollWidth > w + 0.5 && fs > 6; i++) {
    fs = fs * (w / el.scrollWidth) * 0.94;
    el.style.setProperty("font-size", Math.max(6, fs).toFixed(1) + "px", "important");
  }
}

function fitGroupStable(items) {
  items = (items || []).filter(Boolean);
  if (!items.length) return;
  items.forEach((el) => {
    el.style.removeProperty("font-size");
  });
  let _gf = true;
  for (const el of items) {
    const pw = el.clientWidth;
    if (pw && el.scrollWidth > pw + 0.5) {
      _gf = false;
      break;
    }
  }
  if (_gf) return;
  let scale = 1;
  items.forEach((el) => {
    const pw = el.clientWidth;
    if (!pw) return;
    const sw = el.scrollWidth;
    if (sw > pw + 0.5) {
      const s = (pw / sw) * 0.97;
      if (s < scale) scale = s;
    }
  });
  if (scale >= 1) return;
  items.forEach((el) => {
    const fs = parseFloat(getComputedStyle(el).fontSize) * scale;
    el.style.setProperty("font-size", Math.max(6, fs).toFixed(1) + "px", "important");
  });
}

function presetCtx() {
  const c = presetCtx._c || (presetCtx._c = document.createElement("canvas").getContext("2d"));
  return c;
}

const _fitCache = new Map();

function cachedMeasure(font, text) {
  const k = font + "|" + text;
  let w = _fitCache.get(k);
  if (w === undefined) {
    const c = presetCtx();
    c.font = font;
    w = c.measureText(text).width;
    if (_fitCache.size > 200) _fitCache.clear();
    _fitCache.set(k, w);
  }
  return w;
}

export function presetScoreFont(el, sample) {
  if (!el) return;
  const w = el.clientWidth;
  if (!w) return;
  el.style.removeProperty("font-size");
  el.style.removeProperty("height");
  const cs = getComputedStyle(el);
  const fs0 = parseFloat(cs.fontSize);
  if (!fs0) return;
  const tw = cachedMeasure(
    cs.fontWeight + " " + fs0 + "px " + cs.fontFamily,
    sample || "9,999,999",
  );
  if (tw > w) {
    const fs = Math.max(6, (fs0 * w) / tw);
    el.style.setProperty("font-size", fs.toFixed(1) + "px", "important");
    el.style.setProperty("height", fs.toFixed(1) + "px", "important");
  }
}

function fitTrioKeys(els) {
  const ks = [];
  for (const v of els) {
    if (!v) continue;
    const p = v.parentElement;
    if (!p) continue;
    const k = p.querySelector(".k");
    if (k) ks.push(k);
  }
  if (!ks.length) return;
  ks.forEach((k) => {
    k.style.removeProperty("font-size");
  });
  let scale = 1;
  for (const k of ks) {
    const pw = k.clientWidth;
    if (!pw) continue;
    const sw = k.scrollWidth;
    if (sw > pw + 0.5) {
      const s = (pw / sw) * 0.97;
      if (s < scale) scale = s;
    }
  }
  if (scale >= 1) return;
  for (const k of ks) {
    const fs = parseFloat(getComputedStyle(k).fontSize) * scale;
    k.style.setProperty("font-size", Math.max(6, fs).toFixed(1) + "px", "important");
  }
}

function _fitSignature() {
  let h = 2166136261 >>> 0;
  const mix = (v) => {
    if (v == null) return;
    const s = String(v);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  };
  mix(menusState._fitEpoch);
  mix(document.body.className);
  mix(layoutState.elScore && layoutState.elScore.textContent);
  mix(layoutState.elLevel && layoutState.elLevel.textContent);
  mix(layoutState.elLines && layoutState.elLines.textContent);
  if (MP.stations)
    for (const st of MP.stations) {
      mix(st.scoreEl && st.scoreEl.textContent);
      mix(st.levelEl && st.levelEl.textContent);
      mix(st.linesEl && st.linesEl.textContent);
      mix(st.timeEl && st.timeEl.textContent);
      mix(st.piecesEl && st.piecesEl.textContent);
      mix(st.ppsEl && st.ppsEl.textContent);
    }
  return h;
}

export function fitAllStats() {
  if (game.state === "menu") return;
  const _fs = _fitSignature();
  if (fitAllStats._sig === _fs) return;
  fitAllStats._sig = _fs;
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive && MP.stations.length) {
    const mobMulti = document.body.classList.contains("mobOnMulti");
    const wideSkip = MOBILE.matches && document.body.classList.contains("vsWide");
    for (const st of MP.stations) {
      if (wideSkip) {
        [
          st.scoreH3El,
          st.levelEl,
          st.linesEl,
          st.lvlKEl,
          st.lnKEl,
          st.timeEl,
          st.piecesEl,
          st.ppsEl,
        ].forEach((el) => {
          if (el) el.style.removeProperty("font-size");
        });
        for (const v of [st.timeEl, st.piecesEl, st.ppsEl]) {
          if (v && v.parentElement) {
            const k = v.parentElement.querySelector(".k");
            if (k) k.style.removeProperty("font-size");
          }
        }
        continue;
      }
      if (mobMulti && st.idx > 0) {
        [
          st.scoreEl,
          st.scoreH3El,
          st.levelEl,
          st.linesEl,
          st.lvlKEl,
          st.lnKEl,
          st.timeEl,
          st.piecesEl,
          st.ppsEl,
        ].forEach((el) => {
          if (el) el.style.removeProperty("font-size");
        });
        if (document.body.classList.contains("vsWide")) {
          fitGroupStable([st.timeEl, st.piecesEl, st.ppsEl]);
          fitTrioKeys([st.timeEl, st.piecesEl, st.ppsEl]);
        }
        continue;
      }
      presetScoreFont(st.scoreEl, vsGarbageMode() ? "999" : "9,999,999,999");
      fitGroupStable([st.levelEl, st.linesEl]);
      fitGroupStable([st.lvlKEl, st.lnKEl]);
      fitGroupStable([st.timeEl, st.piecesEl, st.ppsEl]);
      fitTrioKeys([st.timeEl, st.piecesEl, st.ppsEl]);
      fitEl(st.scoreH3El);
    }
    return;
  }
  presetScoreFont(layoutState.elScore, isBattle() ? "999" : "9,999,999");
  fitGroupStable([layoutState.elLevel, layoutState.elLines]);
  fitGroupStable([layoutState.lvlK, layoutState.lnK]);
  fitGroupStable([layoutState.elTime, layoutState.elPieces, layoutState.elPps]);
  fitTrioKeys([layoutState.elTime, layoutState.elPieces, layoutState.elPps]);
  fitEl(layoutState.pScoreH3);
  presetScoreFont(
    $("botScore"),
    versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive && vsGarbageMode()
      ? "999"
      : "9,999,999,999",
  );
  fitGroupStable([$("botLevel"), $("botLines")]);
  fitGroupStable([$("bLvlK"), $("bLnK")]);
  fitGroupStable([$("botTime"), $("botPieces"), $("botPps")]);
  fitTrioKeys([$("botTime"), $("botPieces"), $("botPps")]);
  fitEl($("botScoreH3"));
}

export function isBattle() {
  return configState.mode === "vsbot" && versusLobbyState.vs !== undefined && vsGarbageMode();
}

export function bumpScore() {
  setText(layoutState.elScore, game.score.toLocaleString("en-US"));
  if (layoutState.elScore.animate) {
    layoutState.elScore.getAnimations().forEach((a) => a.cancel());
    layoutState.elScore.animate(
      [{ color: "var(--txt)" }, { color: "var(--acchi)", offset: 0.4 }, { color: "var(--txt)" }],
      { duration: 280 },
    );
  } else {
    layoutState.elScore.classList.remove("bump");
    void layoutState.elScore.offsetWidth;
    layoutState.elScore.classList.add("bump");
  }
  presetScoreFont(layoutState.elScore, isBattle() ? "999" : "9,999,999");
}

export function updateStatsCore(
  h3El,
  lvlKEl,
  lnKEl,
  scoreEl,
  levelEl,
  linesEl,
  piecesEl,
  timeEl,
  ppsEl,
  scoreVal,
  levelVal,
  linesVal,
  piecesVal,
  timeVal,
  ppsVal,
  isBattleMode,
  isSprint,
  isUltra,
) {
  setText(h3El, isBattleMode ? "ATTACK" : "SCORE");
  setText(lvlKEl, isBattleMode ? "APM" : "LEVEL");
  setText(lnKEl, "LINES");
  setText(scoreEl, scoreVal);
  setText(levelEl, levelVal);
  setText(linesEl, linesVal);
  setText(piecesEl, piecesVal);
  setText(timeEl, timeVal);
  setText(ppsEl, ppsVal);
}

export function updateStats() {
  const battle = isBattle();
  updateStatsCore(
    layoutState.pScoreH3,
    layoutState.lvlK,
    layoutState.lnK,
    layoutState.elScore,
    layoutState.elLevel,
    layoutState.elLines,
    layoutState.elPieces,
    layoutState.elTime,
    layoutState.elPps,
    game.score.toLocaleString("en-US"),
    String(game.level),
    configState.mode === "sprint" ? game.lines + "/" + SPRINT_LINES : String(game.lines),
    String(game.pieces),
    configState.mode === "ultra"
      ? fmtTime(Math.max(0, ULTRA_MS - game.playMs))
      : fmtTime(game.playMs),
    game.playMs > 0 ? (game.pieces / (game.playMs / 1000)).toFixed(2) : "0.00",
    battle,
    configState.mode === "sprint",
    configState.mode === "ultra",
  );
  fitAllStats();
}
