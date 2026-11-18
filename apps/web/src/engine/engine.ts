// @ts-nocheck
import { fxRandom } from "../core/random";
import { log } from "../core/logger";
import {
  BATTLE_GRAV_MS,
  blitzGravMsForLevel,
  blitzLevelForLines,
  collideOn as coreCollideOn,
  detectSpinOn as coreDetectSpinOn,
  emptyRow as coreEmptyRow,
  findFullRows as coreFindFullRows,
  pcAfterClear as corePcAfterClear,
  PIECES,
  speedFor,
  spliceRows as coreSpliceRows,
  SPRINT_GRAV_MS,
} from "@tetrizz/core";
import { MOBILE, clamp, configState, dims, isReducedMotion } from "../core/config";
import { perfState } from "../core/metrics";
import { emitEvent } from "../core/events";
import { GESTURE_ACTS, game } from "../game/state";
import { layoutState } from "../ui/layout";
import { tryRotate } from "../render/render";
import { doHold, hardDrop, softInstant } from "../game/game";
import { saveOpts, syncToggles } from "../ui/settings";
import { MP, versusLobbyState } from "../versus/lobby";
import { stHardDrop, stHold, stRotate, stSoftInstant } from "../versus/stations";

const engineState = {
  actx: null,
  masterGain: null,
  noiseBuf: null,
};

export function execGesture(k) {
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) return;
  if (game.state !== "playing") return;
  const a = game.gestures[k];
  if (a === "rotateCW") tryRotate(1);
  else if (a === "rotateCCW") tryRotate(-1);
  else if (a === "rotate180") tryRotate(2);
  else if (a === "hold") doHold();
  else if (a === "hard") hardDrop();
  else if (a === "soft") softInstant();
}

export function execGestureSt(st, k) {
  if (!st || game.state !== "playing") return;
  const a = game.gestures[k];
  if (a === "rotateCW") stRotate(st, 1);
  else if (a === "rotateCCW") stRotate(st, -1);
  else if (a === "rotate180") stRotate(st, 2);
  else if (a === "hold") stHold(st);
  else if (a === "hard") stHardDrop(st);
  else if (a === "soft") stSoftInstant(st);
}

export function cycleGesture(k) {
  const list = GESTURE_ACTS[k];
  if (!list) return;
  const cur = list.indexOf(game.gestures[k]);
  for (let step = 1; step <= list.length; step++) {
    const candidate = list[(cur + step) % list.length];
    if (candidate === "none") {
      game.gestures[k] = "none";
      break;
    }
    let dup = false;
    for (const ok in game.gestures) {
      if (ok !== k && game.gestures[ok] === candidate) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      game.gestures[k] = candidate;
      break;
    }
  }
  syncToggles();
  saveOpts();
}

export const fx = { x: 0, y: 0, rot: 0, vx: 0, vy: 0, vr: 0, tx: 0, lx: 0, lvx: 0 };

const botFx = { x: 0, y: 0, rot: 0, vx: 0, vy: 0, vr: 0 };

export const FX_K = 130,
  FX_C = 25,
  ROT_K = 150,
  ROT_C = 20,
  LEAN = 5,
  LEAN_K = 500,
  LEAN_C = 40,
  DROPV = 230,
  CLEARV0 = 250,
  CLEARV_PER = 10,
  SPINR = 40;

export const fxNorm = () => configState.fxStrength / 100;

export const fxf = () => {
  const s = fxNorm();
  if (s <= 0) return 0;
  const f = 1.33 * Math.pow(s, 0.6) + 0.67 * s * s;
  return MOBILE.matches ? f * 0.6 : f;
};

const leanF = () => {
  const f = fxf();
  if (f <= 0) return 0;
  return Math.max(0, 0.34 + (f - 0.34) * 0.45);
};

export function fxKick(dx, dy, dr) {
  emitEvent("fxKick", { dx: dx, dy: dy, dr: dr });
  if (configState.fxStrength <= 0 || isReducedMotion() || perfState.tier >= 2) return;
  const f = fxf();
  const gm = MOBILE.matches ? 11 : 18;
  const kx = clamp(dx * f, -1000, 1000),
    ky = clamp(dy * f, -1700, 1700),
    kr = clamp(dr * f, -260, 260);
  if (kx) {
    const gx = 1 - clamp(Math.abs(fx.x) / gm, 0, 1);
    fx.vx = clamp(fx.vx + kx * gx, -Math.abs(kx), Math.abs(kx));
  }
  if (ky) {
    const gy = 1 - clamp(Math.abs(fx.y) / gm, 0, 1);
    fx.vy = clamp(fx.vy + ky * gy, -Math.abs(ky), Math.abs(ky));
  }
  if (kr) fx.vr = clamp(fx.vr + kr, -Math.abs(kr), Math.abs(kr));
}

export function fxSpin(dir) {
  emitEvent("fxSpin", { dir: dir });
  if (configState.fxStrength <= 0 || !dir) return;
  const s = fxNorm();
  const target = dir * SPINR * (0.55 + 0.75 * s);
  fx.vr += (target - fx.vr) * 0.6;
}

function fxStepObj(o, dt) {
  o.vx = (o.vx - FX_K * o.x * dt) / (1 + FX_C * dt);
  o.vy = (o.vy - FX_K * o.y * dt) / (1 + FX_C * dt);
  o.vr = (o.vr - ROT_K * o.rot * dt) / (1 + ROT_C * dt);
  o.x += o.vx * dt;
  o.y += o.vy * dt;
  o.rot += o.vr * dt;
  if (Math.abs(o.x) < 0.02 && Math.abs(o.vx) < 0.6) {
    o.x = 0;
    o.vx = 0;
  }
  if (Math.abs(o.y) < 0.02 && Math.abs(o.vy) < 0.6) {
    o.y = 0;
    o.vy = 0;
  }
  if (Math.abs(o.rot) < 0.004 && Math.abs(o.vr) < 0.6) {
    o.rot = 0;
    o.vr = 0;
  }
}

export function fxStep(dt) {
  const _mx = MOBILE.matches ? 17 : 28,
    _my = MOBILE.matches ? 16 : 26,
    _mr = MOBILE.matches ? 6 : 9;
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive && MP.stations.length) {
    for (const st of MP.stations) {
      fxStepObj(st.fx, dt);
      const _stx = (st.fx.tx || 0) * leanF();
      st.fx.lvx = ((st.fx.lvx || 0) - LEAN_K * ((st.fx.lx || 0) - _stx) * dt) / (1 + LEAN_C * dt);
      st.fx.lx = (st.fx.lx || 0) + st.fx.lvx * dt;
      if (Math.abs((st.fx.lx || 0) - _stx) < 0.02 && Math.abs(st.fx.lvx || 0) < 0.6) {
        st.fx.lx = _stx;
        st.fx.lvx = 0;
      }
      st.fx.x = clamp(st.fx.x, -_mx, _mx);
      st.fx.y = clamp(st.fx.y, -_my, _my);
      st.fx.rot = clamp(st.fx.rot, -_mr, _mr);
      st.fx.lx = clamp(st.fx.lx || 0, -10, 10);
      const _t = `translate(${(st.fx.x + (st.fx.lx || 0)).toFixed(2)}px,${st.fx.y.toFixed(2)}px) rotate(${st.fx.rot.toFixed(3)}deg)`;
      if (st._ft !== _t) {
        st._ft = _t;
        if (st.wrapEl) st.wrapEl.style.transform = _t;
      }
    }
    return;
  }
  const tx = fx.tx * leanF();
  fx.lvx = (fx.lvx - LEAN_K * (fx.lx - tx) * dt) / (1 + LEAN_C * dt);
  fx.lx += fx.lvx * dt;
  fxStepObj(fx, dt);
  if (Math.abs(fx.lx - tx) < 0.02 && Math.abs(fx.lvx) < 0.6) {
    fx.lx = tx;
    fx.lvx = 0;
  }
  fx.x = clamp(fx.x, -_mx, _mx);
  fx.y = clamp(fx.y, -_my, _my);
  fx.rot = clamp(fx.rot, -_mr, _mr);
  fx.lx = clamp(fx.lx, -10, 10);
  const _ft = `translate(${(fx.x + fx.lx).toFixed(2)}px,${fx.y.toFixed(2)}px) rotate(${fx.rot.toFixed(3)}deg)`;
  if (_ft !== fxStep._lw) {
    fxStep._lw = _ft;
    layoutState.wrap.style.transform = _ft;
  }
  fxStepObj(botFx, dt);
  botFx.x = clamp(botFx.x, -_mx, _mx);
  botFx.y = clamp(botFx.y, -_my, _my);
  botFx.rot = clamp(botFx.rot, -_mr, _mr);
  const bw = document.getElementById("botWrap");
  if (bw) {
    const _bt = `translate(${botFx.x.toFixed(2)}px,${botFx.y.toFixed(2)}px) rotate(${botFx.rot.toFixed(3)}deg)`;
    if (_bt !== fxStep._lb) {
      fxStep._lb = _bt;
      bw.style.transform = _bt;
    }
  }
}

export const emptyRow = () => coreEmptyRow(configState.COLS);

export function levelForLines(m, n) {
  if (m === "ultra") return blitzLevelForLines(n);
  if (m === "sprint") return 1;
  if (m === "practice")
    return configState.practice.levelUp
      ? configState.practice.level + Math.floor(n / 10)
      : configState.practice.level;
  if (m === "vsbot") {
    const s = versusLobbyState.vs !== undefined ? versusLobbyState.vs.submode : "battle";
    if (s === "battle" || s === "wide") return 1;
    if (s === "ultra") return blitzLevelForLines(n);
    if (s === "sprint") return 1;
    return 1 + Math.floor(n / 10);
  }
  return 1 + Math.floor(n / 10);
}

export function gravMsFor(m, lv) {
  if (m === "sprint") return SPRINT_GRAV_MS;
  if (m === "ultra") return blitzGravMsForLevel(lv);
  if (m === "practice") return lv <= 0 ? Infinity : speedFor(lv);
  if (m === "vsbot") {
    const s = versusLobbyState.vs !== undefined ? versusLobbyState.vs.submode : "battle";
    if (s === "sprint") return SPRINT_GRAV_MS;
    if (s === "ultra") return blitzGravMsForLevel(lv);
    return BATTLE_GRAV_MS;
  }
  return speedFor(lv);
}

export const curCells = () => PIECES[game.piece.type].cells[game.piece.rot];

export const collideOn = (bd, cells, x, y) => coreCollideOn(bd, dims, cells, x, y);

export function collide(cells, x, y) {
  return collideOn(game.board, cells, x, y);
}

export const findFullRows = (bd) => coreFindFullRows(bd, dims);

export const pcAfterClear = (bd, rows) => corePcAfterClear(bd, dims, rows);

export const spliceRows = (bd, rows) => coreSpliceRows(bd, dims, rows);

export const detectSpinOn = (bd, p) => coreDetectSpinOn(bd, dims, p);

function ac() {
  if (!engineState.actx) {
    try {
      engineState.actx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      return null;
    }
    engineState.masterGain = engineState.actx.createGain();
    engineState.masterGain.gain.value = 1;
    let _compOk = false;
    try {
      const comp = engineState.actx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 24;
      comp.ratio.value = 8;
      comp.attack.value = 0.002;
      comp.release.value = 0.18;
      engineState.masterGain.connect(comp);
      comp.connect(engineState.actx.destination);
      _compOk = true;
    } catch (_) {
      log.debug("engine/engine.ac", _);
    }
    if (!_compOk) engineState.masterGain.connect(engineState.actx.destination);
    const len = engineState.actx.sampleRate | 0;
    engineState.noiseBuf = engineState.actx.createBuffer(1, len, engineState.actx.sampleRate);
    const d = engineState.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = fxRandom() * 2 - 1;
  }
  if (engineState.actx.state === "suspended") engineState.actx.resume();
  return engineState.actx;
}

export function voice(freq, dur, type, vol, o) {
  if (game.muted || game.volume <= 0) return;
  const a = ac();
  if (!a) return;
  o = o || {};
  const t = a.currentTime + (o.t0 || 0),
    v = vol * (game.volume / 100);
  if (v <= 0) return;
  const g = a.createGain(),
    atk = o.attack != null ? o.attack : 0.006;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v, t + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = g;
  if (o.filter) {
    const f = a.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(o.filter, t);
    if (o.filterSlide)
      f.frequency.exponentialRampToValueAtTime(Math.max(40, o.filterSlide), t + dur);
    f.connect(g);
    node = f;
  }
  g.connect(engineState.masterGain);
  const mk = (ff, ty, det) => {
    if (ff <= 0) return;
    const os = a.createOscillator();
    os.type = ty;
    os.frequency.setValueAtTime(ff, t);
    if (o.slide) os.frequency.exponentialRampToValueAtTime(Math.max(30, o.slide), t + dur);
    if (det) os.detune.value = det;
    os.connect(node);
    os.start(t);
    os.stop(t + dur + 0.04);
  };
  mk(freq, type, 0);
  if (o.rich) {
    mk(freq, type, 7);
    mk(freq, type, -7);
  }
  if (o.noise && engineState.noiseBuf) {
    const ns = a.createBufferSource();
    ns.buffer = engineState.noiseBuf;
    const nf = a.createBiquadFilter();
    nf.type = "lowpass";
    nf.frequency.value = o.noiseF || 1200;
    const ng = a.createGain(),
      nv = (o.noiseVol || 0.3) * v;
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(Math.max(0.0001, nv), t + 0.004);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + (o.noiseDur || dur));
    ns.connect(nf);
    nf.connect(ng);
    ng.connect(engineState.masterGain);
    ns.start(t);
    ns.stop(t + (o.noiseDur || dur) + 0.02);
  }
}

export const SFX = {
  move: () => voice(330, 0.04, "sine", 0.03, { filter: 2200, attack: 0.002 }),
  rotate: () =>
    voice(420, 0.04, "triangle", 0.03, {
      filter: 1800,
      attack: 0.001,
      noise: true,
      noiseF: 3000,
      noiseVol: 0.18,
      noiseDur: 0.015,
    }),
  hold: () => {
    voice(196, 0.055, "sine", 0.03, { slide: 294, filter: 1600, attack: 0.001 });
    voice(392, 0.05, "sine", 0.022, { slide: 262, filter: 1800, attack: 0.001, t0: 0.034 });
  },
  soft: () =>
    voice(110, 0.11, "sine", 0.028, {
      slide: 56,
      filter: 560,
      noise: true,
      noiseF: 750,
      noiseVol: 0.3,
      noiseDur: 0.07,
    }),
  slam: () =>
    voice(110, 0.13, "sine", 0.05, {
      slide: 52,
      filter: 650,
      noise: true,
      noiseF: 900,
      noiseVol: 0.55,
      noiseDur: 0.09,
    }),
  lock: () =>
    voice(180, 0.055, "triangle", 0.034, {
      filter: 1400,
      noise: true,
      noiseF: 1600,
      noiseVol: 0.34,
      noiseDur: 0.045,
    }),
  chime: () => {
    [523, 659, 784].forEach((f, i) =>
      voice(f, 0.18, "sine", 0.022, { filter: 4000, t0: i * 0.045 }),
    );
  },
  tetris: () => {
    [523, 659, 784, 1046, 1318].forEach((f, i) =>
      voice(f, 0.22, "triangle", 0.022, { filter: 4200, rich: true, t0: i * 0.05 }),
    );
    voice(0, 0.18, "sine", 0.03, {
      noise: true,
      noiseF: 5000,
      noiseVol: 0.16,
      noiseDur: 0.16,
    });
  },
  spinClear: () => {
    voice(660, 0.13, "triangle", 0.02, { filter: 3600, rich: true });
    voice(880, 0.13, "triangle", 0.018, { filter: 3600, rich: true, t0: 0.035 });
    voice(1318.51, 0.16, "triangle", 0.016, { filter: 4600, rich: true, t0: 0.07 });
    voice(1760, 0.16, "triangle", 0.012, { filter: 5600, rich: true, t0: 0.105 });
  },
  spinMove: () => {
    voice(560, 0.09, "sine", 0.011, { slide: 340, filter: 1900, attack: 0.006 });
  },
  combo: (c) => {
    if (c < 1) return;
    const T1 = [523.25, 587.33, 659.25, 698.46, 783.99, 880.0, 987.77, 1046.5];
    if (c <= 8) {
      voice(T1[c - 1], 0.15, "triangle", 0.025, { filter: 3800, attack: 0.003 });
    } else if (c <= 15) {
      const T2 = [1174.66, 1318.51, 1396.91, 1567.98, 1760.0, 1975.53, 2093.0];
      voice(T2[c - 9], 0.14, "triangle", 0.023, { filter: 4200, attack: 0.003 });
    } else {
      voice(2093.0, 0.12, "triangle", 0.02, { filter: 4200, attack: 0.003 });
    }
  },
  sigh: () => {
    voice(330, 0.2, "triangle", 0.016, { slide: 165, filter: 1600, attack: 0.01 });
  },
  level: () =>
    [392, 523, 659, 784].forEach((f, i) =>
      voice(f, 0.16, "triangle", 0.022, { filter: 3200, rich: true, t0: i * 0.07 }),
    ),
  pc: () =>
    [523, 659, 784, 1046, 1318, 1568].forEach((f, i) =>
      voice(f, 0.24, "sine", 0.022, { filter: 4500, rich: true, t0: i * 0.05 }),
    ),
  over: () =>
    [392, 330, 262, 196].forEach((f, i) =>
      voice(f, 0.3, "sine", 0.035, { filter: 2000, slide: f * 0.85, t0: i * 0.13 }),
    ),
  count: () => voice(523.25, 0.07, "triangle", 0.03, { filter: 2600, attack: 0.001 }),
  go: () => {
    voice(784, 0.16, "triangle", 0.035, { filter: 3600, rich: true });
    voice(1046.5, 0.18, "triangle", 0.03, { filter: 4200, rich: true, t0: 0.04 });
  },
};
