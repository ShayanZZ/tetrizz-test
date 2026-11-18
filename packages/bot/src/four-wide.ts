// @ts-nocheck
import { KI, KJ } from "@tetrizz/core";
import { botContext } from "./context";
import { clamp } from "./math";
import { MODE_MOD } from "./mode-mod";

import { createBotOps, encodeBoard, isValid, pieceCells } from "./bitboard";

const ops = createBotOps({
  occRows: () => botContext.rows,
  dropTop: 3,
  guarded: true,
  heightMask: () => bot4wideState.W_MASK_VAL,
});

export const wBoard = encodeBoard;
const wH = ops.height;
const wCells = pieceCells;
const wValid = isValid;
const wDrop = ops.drop;
const wDropFrom = ops.dropFrom;
const wSpin = ops.spin;
const wTSlotScore = ops.tSlotScore;

export const bot4wideState = {
  W_MASK_VAL: (1 << 23) - 1,
  wCtxIComing: false,
};

const WIDE_W_BASE = {
  cell_coveredness: -0.5,
  max_cell_covered_height: 6,
  holes: -3.4,
  row_transitions: -0.12,
  aggregate_height: -0.16,
  bumpiness: -0.5,
  height: -0.9,
  height_upper_half: -2.5,
  height_upper_quarter: -6.0,
  tetris_well_no_i: -1.7,
  tetris_well_has_i: -0.35,
  tslot: [0, 3.0, 6.0, 9.0],
  has_back_to_back: 1.8,
  wasted_t: -1.5,
  softdrop: -0.06,
  normal_clears: [0.0, 0.8, 1.6, 2.6, 4.0],
  mini_spin_clears: [0.0, 3.2, 5.5],
  spin_clears: [0.0, 4.5, 8.0, 12.0],
  back_to_back_clear: 2.8,
  combo_attack: 2.6,
  tspin_quality: 1.2,
  perfect_clear: 22.0,
  perfect_clear_override: true,
};

const WIDE_FIXED = new Set([
  "perfect_clear_override",
  "max_cell_covered_height",
  "cliff_weight",
  "break_b2b",
  "perfect_clear",
]);

const WIDE_CONST = { cliff_weight: -2.4, break_b2b: -5.0 };

const wideWeightCache = { key: "", W: null };

export function wMakeWeights(diff) {
  const key = diff + "|" + botContext.submode;
  if (wideWeightCache.key === key) return wideWeightCache.W;
  const sk = clamp((diff - 1) / 9, 0, 1);
  const scale = 0.45 + 0.55 * sk;
  const W = {};
  for (const k in WIDE_W_BASE) {
    const v = WIDE_W_BASE[k];
    if (WIDE_FIXED.has(k)) W[k] = v;
    else if (Array.isArray(v)) W[k] = v.map((n) => n * scale);
    else if (typeof v === "number") W[k] = v * scale;
    else W[k] = v;
  }
  for (const k in WIDE_CONST) W[k] = WIDE_CONST[k];
  W.perfect_clear = WIDE_W_BASE.perfect_clear;
  W.perfect_clear_override = true;
  const mm = MODE_MOD[botContext.submode] || MODE_MOD.battle;
  W.holes *= mm.surv;
  W.height *= mm.surv;
  W.height_upper_half *= mm.surv;
  W.height_upper_quarter *= mm.surv;
  W.row_transitions *= mm.surv;
  W.aggregate_height *= mm.surv;
  W.bumpiness *= mm.surv;
  W.back_to_back_clear *= mm.atk;
  W.combo_attack *= mm.atk;
  for (let i = 1; i < W.tslot.length; i++) W.tslot[i] *= mm.atk;
  for (let i = 1; i < W.normal_clears.length; i++) W.normal_clears[i] *= mm.clr;
  for (let i = 1; i < W.spin_clears.length; i++) W.spin_clears[i] *= mm.clr;
  for (let i = 1; i < W.mini_spin_clears.length; i++) W.mini_spin_clears[i] *= mm.clr;
  wideWeightCache.key = key;
  wideWeightCache.W = W;
  return W;
}

function wPop(v) {
  v >>>= 0;
  let n = 0;
  while (v) {
    v &= v - 1;
    n++;
  }
  return n;
}

function wMask() {
  return bot4wideState.W_MASK_VAL;
}

function wMaxH(c) {
  let m = 0;
  for (let x = 0; x < botContext.cols; x++) {
    const h = wH(c, x);
    if (h > m) m = h;
  }
  return m;
}

export function wDanger(c) {
  return clamp((wMaxH(c) - (botContext.rows - 14)) / 9, 0, 1);
}

function wFindMoves(c, type) {
  const moves = [];
  const seen = new Set();
  const rots = type === 3 ? [0] : [0, 1, 2, 3];
  for (const rot of rots) {
    const cells = wCells(type, rot);
    let mn = 9,
      mx = -9;
    for (const [dx] of cells) {
      if (dx < mn) mn = dx;
      if (dx > mx) mx = dx;
    }
    for (let x = -mn; x <= botContext.cols - 1 - mx; x++) {
      const y = wDrop(c, type, rot, x);
      if (y < 0 || y > botContext.rows - 1) continue;
      const key = "n:" + rot + ":" + x + ":" + y;
      if (seen.has(key)) continue;
      seen.add(key);
      moves.push({
        rot,
        x,
        y,
        spin: 0,
        ki: -1,
        sd: Math.max(0, botContext.rows - 1 - y),
        fromRot: -1,
      });
    }
  }
  if (type !== 3) {
    const kt = type === 0 ? KI : KJ;
    for (const fromRot of [0, 1, 2, 3]) {
      const cells = wCells(type, fromRot);
      let mn = 9,
        mx = -9;
      for (const [dx] of cells) {
        if (dx < mn) mn = dx;
        if (dx > mx) mx = dx;
      }
      for (let px = -mn; px <= botContext.cols - 1 - mx; px++) {
        const sy = wDrop(c, type, fromRot, px);
        if (sy < 0 || sy > botContext.rows + 2) continue;
        for (const dir of [1, 3]) {
          const nr = (fromRot + dir) % 4;
          const kicks = kt[fromRot + ">" + nr];
          if (!kicks) continue;
          for (let ki = 1; ki < kicks.length; ki++) {
            const nx = px + kicks[ki][0],
              ny = sy + kicks[ki][1];
            if (!wValid(c, type, nr, nx, ny)) continue;
            let earlier = false;
            for (let ej = 0; ej < ki; ej++) {
              if (wValid(c, type, nr, px + kicks[ej][0], sy + kicks[ej][1])) {
                earlier = true;
                break;
              }
            }
            if (earlier) continue;
            const fy = wDropFrom(c, type, nr, nx, ny);
            if (fy < 0 || fy > botContext.rows - 1) continue;
            const spin = wSpin(c, type, nr, nx, fy, ki);
            if (spin <= 0) continue;
            const key = "s:" + nr + ":" + nx + ":" + fy + ":" + fromRot + ":" + ki;
            if (seen.has(key)) continue;
            seen.add(key);
            moves.push({
              rot: nr,
              x: nx,
              y: fy,
              spin,
              ki,
              sd: Math.max(0, botContext.rows - 1 - sy),
              fromRot,
            });
          }
        }
      }
    }
  }
  return moves;
}

function wPlace(c, type, mv) {
  const mask = wMask();
  const nc = c.slice();
  const cells = wCells(type, mv.rot);
  for (const [dx, dy] of cells) {
    const bx = mv.x + dx,
      by = mv.y + dy;
    if (bx >= 0 && bx < botContext.cols && by >= 0 && by < 31) {
      nc[bx] = (((nc[bx] || 0) >>> 0) | (1 << by)) >>> 0;
    }
  }
  for (let x = 0; x < botContext.cols; x++) nc[x] = ((nc[x] || 0) >>> 0) & mask;
  let full = mask;
  for (let x = 0; x < botContext.cols; x++) full &= nc[x];
  if (!full) return [nc, 0];
  const cnt = wPop(full);
  const rc = new Array(botContext.cols);
  for (let x = 0; x < botContext.cols; x++) {
    let r = 0,
      s = 0;
    const v = nc[x] >>> 0;
    for (let y = 0; y < Math.min(botContext.rows, 31); y++) {
      if (full & (1 << y)) s++;
      else if (v & (1 << y)) r |= 1 << (y - s);
    }
    rc[x] = r >>> 0;
  }
  return [rc, cnt];
}

export function wEval(c, W, info) {
  let ev = 0;
  const mask = wMask();
  const H = new Array(botContext.cols);
  let maxH = 0,
    agg = 0;
  for (let x = 0; x < botContext.cols; x++) {
    const h = wH(c, x);
    H[x] = h;
    if (h > maxH) maxH = h;
    agg += h;
  }
  let bump = 0;
  for (let x = 0; x < botContext.cols - 1; x++) bump += Math.abs(H[x] - H[x + 1]);
  const cliffLine = botContext.rows - 8;
  let cliff = 0;
  for (let x = 0; x < botContext.cols; x++) {
    const e = H[x] - cliffLine;
    if (e > 0) cliff += e * e;
  }
  let hc = 0,
    cov = 0;
  for (let x = 0; x < botContext.cols; x++) {
    const h = H[x];
    if (!h) continue;
    const v = ((c[x] || 0) >>> 0) & mask;
    const um = h >= 31 ? 0x7fffffff : (1 << h) - 1;
    let holes = (mask ^ v) & um;
    while (holes) {
      const bit = holes & -holes;
      let b = bit >>> 0,
        y = 0;
      while (b > 1) {
        b >>>= 1;
        y++;
      }
      cov += Math.min(h - y, W.max_cell_covered_height);
      hc++;
      holes &= holes - 1;
    }
  }
  let well = 0;
  for (let x = 0; x < botContext.cols; x++) {
    const lH = x > 0 ? H[x - 1] : botContext.rows + 10;
    const rH = x < botContext.cols - 1 ? H[x + 1] : botContext.rows + 10;
    const base = Math.min(lH, rH);
    if (base > H[x]) well += base - H[x];
  }
  const wellW = bot4wideState.wCtxIComing ? W.tetris_well_has_i : W.tetris_well_no_i;
  let rt = 0;
  const lc = (c[0] || 0) >>> 0,
    rc2 = (c[botContext.cols - 1] || 0) >>> 0;
  for (let y = 0; y < Math.min(botContext.rows, 31); y++) {
    if (!(lc & (1 << y))) rt++;
    if (!(rc2 & (1 << y))) rt++;
  }
  for (let x = 0; x < botContext.cols - 1; x++) {
    const d = (((c[x] || 0) >>> 0) ^ ((c[x + 1] || 0) >>> 0)) & mask;
    rt += wPop(d);
  }
  const danger = clamp((maxH - (botContext.rows - 14)) / 9, 0, 1);
  const clearUrg = 1 + 2.5 * danger;
  const heightUrg = 1 + 1.8 * danger;
  ev += W.aggregate_height * agg * heightUrg;
  ev += W.bumpiness * bump * heightUrg;
  ev += W.height * maxH * heightUrg;
  const uH = Math.round(botContext.rows * 0.55),
    uQ = Math.round(botContext.rows * 0.75);
  if (maxH > uH) ev += W.height_upper_half * (maxH - uH) * heightUrg;
  if (maxH > uQ) ev += W.height_upper_quarter * (maxH - uQ) * heightUrg;
  ev += W.cliff_weight * cliff * heightUrg;
  ev += W.holes * hc;
  ev += W.cell_coveredness * cov;
  ev += wellW * well * (1 + 0.5 * danger);
  ev += W.row_transitions * rt;
  let clearRW = 0,
    penaltyRW = 0;
  if (info) {
    if (info.pc) clearRW += W.perfect_clear;
    if (!info.pc || !W.perfect_clear_override) {
      if (info.b2b) clearRW += W.back_to_back_clear;
      if (info.spin === 2) clearRW += W.spin_clears[Math.min(info.lines, 3)];
      else if (info.spin === 1) clearRW += W.mini_spin_clears[Math.min(info.lines, 2)];
      else clearRW += W.normal_clears[Math.min(info.lines, 4)];
      if (info.combo > 1) clearRW += W.combo_attack * Math.floor((info.combo - 1) / 2);
      if (info.ptype === 5 && info.spin === 2 && info.lines >= 1) clearRW += W.tspin_quality;
      if (info.brokeB2B) penaltyRW += W.break_b2b * (1 - 0.6 * danger);
    }
    if (info.ptype === 5 && info.spin === 0 && info.lines === 0) penaltyRW += W.wasted_t;
    penaltyRW += W.softdrop * (info.sd || 0);
  }
  if (info && info.hasB2B) ev += W.has_back_to_back;
  return ev + clearRW * clearUrg + penaltyRW;
}

export function* wSearchGen(c, type, queue, b2b, combo, diff, holdVal) {
  const W = wMakeWeights(diff);
  const noise = Math.max(0, (8 - diff) * 0.15);
  const mistake = Math.max(0, (7 - diff) * 0.015);
  const useLA = diff >= 2 && queue.length > 0;
  const useDeep = diff >= 5 && queue.length > 1;
  const topN1 = Math.round(12 + clamp((diff - 1) / 9, 0, 1) * 16);
  bot4wideState.wCtxIComing = queue.slice(0, 4).indexOf(0) >= 0 || holdVal === 0;
  const tComing = queue.slice(0, 3).indexOf(5) >= 0;
  const moves = wFindMoves(c, type);
  if (!moves.length) return null;
  const scored = [];
  for (let i = 0; i < moves.length; i++) {
    if ((i & 31) === 31) yield;
    const mv = moves[i];
    const sim = wSim(c, type, mv, b2b, combo);
    let s = wEval(sim.c, W, sim.info) + wTSlotScore(sim.c, W, tComing);
    const dg = wDanger(sim.c);
    s += sim.info.lines * 0.6 * (1 + dg);
    s += sim.info.spin === 2 ? 1.0 : sim.info.spin === 1 ? 0.4 : 0;
    scored.push({ mv, sim, s });
  }
  scored.sort((a, b) => b.s - a.s);
  if (useLA) {
    const n1 = Math.min(scored.length, topN1);
    for (let i = 0; i < n1; i++) {
      yield;
      const node = scored[i];
      const nm = wFindMoves(node.sim.c, queue[0]);
      if (!nm.length) continue;
      let bestV = -Infinity,
        bestS2 = null;
      for (const m2 of nm) {
        const s2 = wSim(node.sim.c, queue[0], m2, node.sim.nb, node.sim.nc2);
        const v = wEval(s2.c, W, s2.info);
        if (v > bestV) {
          bestV = v;
          bestS2 = s2;
        }
      }
      if (bestV === -Infinity) continue;
      let val = bestV;
      if (useDeep && bestS2) {
        const nm2 = wFindMoves(bestS2.c, queue[1]);
        if (nm2.length) {
          let bestV3 = -Infinity;
          for (const m3 of nm2) {
            const s3 = wSim(bestS2.c, queue[1], m3, bestS2.nb, bestS2.nc2);
            const v = wEval(s3.c, W, s3.info);
            if (v > bestV3) bestV3 = v;
          }
          if (bestV3 !== -Infinity) val = bestV * 0.5 + bestV3 * 0.5;
        }
      }
      node.s = node.s * 0.35 + val * 0.65;
    }
    scored.sort((a, b) => b.s - a.s);
  }
  if (noise > 0) {
    for (const n of scored) n.s += (botContext.random() * 2 - 1) * noise;
    scored.sort((a, b) => b.s - a.s);
  }
  if (mistake > 0 && botContext.random() < mistake && scored.length > 1) {
    const pool = scored.slice(0, Math.max(2, Math.ceil(scored.length * 0.4)));
    return pool[(botContext.random() * pool.length) | 0].mv;
  }
  return scored[0].mv;
}

export const wSim = ops.makeSim(wPlace);
