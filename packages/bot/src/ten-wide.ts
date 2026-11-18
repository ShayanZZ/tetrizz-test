// @ts-nocheck
import { KI, KJ } from "@tetrizz/core";
import { botContext } from "./context";
import { clamp } from "./math";
import { MODE_MOD } from "./mode-mod";

import { createBotOps, encodeBoard, isValid, pieceCells } from "./bitboard";

const ops = createBotOps({
  occRows: () => 40,
  dropTop: 4,
  guarded: false,
  heightMask: () => undefined,
});

export const cc2Board = encodeBoard;
export const cc2H = ops.height;
const cc2Cells = pieceCells;
const cc2Valid = isValid;
const cc2Drop = ops.drop;
const cc2DropFrom = ops.dropFrom;
const cc2Spin = ops.spin;
const cc2TSlotScore = ops.tSlotScore;

function cc2FindMoves(c, type) {
  const moves = [];
  const seen = new Set();
  const rots = type === 3 ? [0] : [0, 1, 2, 3];
  for (const rot of rots) {
    const cells = cc2Cells(type, rot);
    let mn = 9,
      mx = -9;
    for (const [dx] of cells) {
      if (dx < mn) mn = dx;
      if (dx > mx) mx = dx;
    }
    for (let x = -mn; x <= botContext.cols - 1 - mx; x++) {
      const y = cc2Drop(c, type, rot, x);
      if (y < 0) continue;
      const k = rot * 1000 + x * 50 + y;
      if (seen.has(k)) continue;
      seen.add(k);
      moves.push({
        rot: rot,
        x: x,
        y: y,
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
      const cells = cc2Cells(type, fromRot);
      let mn = 9,
        mx = -9;
      for (const [dx] of cells) {
        if (dx < mn) mn = dx;
        if (dx > mx) mx = dx;
      }
      for (let px = -mn; px <= botContext.cols - 1 - mx; px++) {
        const sy = cc2Drop(c, type, fromRot, px);
        if (sy < 0) continue;
        for (const dir of [1, 3]) {
          const nr = (fromRot + dir) % 4;
          const kicks = kt[fromRot + ">" + nr];
          if (!kicks) continue;
          for (let ki = 1; ki < kicks.length; ki++) {
            const nx = px + kicks[ki][0],
              ny = sy + kicks[ki][1];
            if (!cc2Valid(c, type, nr, nx, ny)) continue;
            let earlier = false;
            for (let ej = 0; ej < ki; ej++) {
              if (cc2Valid(c, type, nr, px + kicks[ej][0], sy + kicks[ej][1])) {
                earlier = true;
                break;
              }
            }
            if (earlier) continue;
            const fy = cc2DropFrom(c, type, nr, nx, ny);
            if (fy < 0) continue;
            const spin = cc2Spin(c, type, nr, nx, fy, ki);
            if (spin > 0) {
              const k2 = nr * 1000 + nx * 50 + fy;
              if (seen.has(k2)) continue;
              seen.add(k2);
              moves.push({
                rot: nr,
                x: nx,
                y: fy,
                spin: spin,
                ki: ki,
                sd: Math.max(0, botContext.rows - 1 - sy),
                fromRot: fromRot,
              });
            }
          }
        }
      }
    }
  }
  return moves;
}

function cc2Place(c, type, mv) {
  const cells = cc2Cells(type, mv.rot);
  const nc = c.slice();
  for (const [dx, dy] of cells) {
    const bx = mv.x + dx,
      by = mv.y + dy;
    if (bx >= 0 && bx < botContext.cols && by >= 0 && by < 31)
      nc[bx] = ((nc[bx] || 0) >>> 0) | (1 << by);
  }
  let full = ~0;
  for (let x = 0; x < botContext.cols; x++) full &= nc[x];
  full &= (1 << Math.min(botContext.rows, 31)) - 1;
  if (!full) return [nc, 0];
  let cnt = 0,
    v = full >>> 0;
  while (v) {
    cnt++;
    v &= v - 1;
  }
  const rc = new Array(botContext.cols);
  for (let x = 0; x < botContext.cols; x++) {
    let r = 0,
      s = 0;
    for (let y = 0; y < Math.min(botContext.rows + 4, 31); y++) {
      if (full & (1 << y)) {
        s++;
      } else {
        if (((nc[x] || 0) >>> 0) & (1 << y)) r |= 1 << (y - s);
      }
    }
    rc[x] = r;
  }
  return [rc, cnt];
}

export const CC2W = {
  cell_coveredness: -0.2,
  max_cell_covered_height: 6,
  holes: -1.5,
  row_transitions: -0.2,
  height: -0.4,
  height_upper_half: -1.5,
  height_upper_quarter: -5.0,
  tetris_well_depth: 0.3,
  tslot: [0, 1.5, 3.5, 5.0],
  has_back_to_back: 0.5,
  wasted_t: -1.5,
  softdrop: -0.2,
  normal_clears: [0.0, -2.0, -1.5, -1.0, 3.5],
  mini_spin_clears: [0.0, 2.0, 3.5],
  spin_clears: [0.0, 1.5, 4.5, 7.0],
  back_to_back_clear: 1.0,
  combo_attack: 1.5,
  perfect_clear: 15.0,
  perfect_clear_override: true,
};

export function cc2Eval(c, W, info) {
  let ev = 0,
    rw = 0;
  if (info) {
    if (info.pc) rw += W.perfect_clear;
    if (!info.pc || !W.perfect_clear_override) {
      if (info.b2b) rw += W.back_to_back_clear;
      if (info.spin === 2) rw += W.spin_clears[Math.min(info.lines, 3)];
      else if (info.spin === 1) rw += W.mini_spin_clears[Math.min(info.lines, 2)];
      else rw += W.normal_clears[Math.min(info.lines, 4)];
      if (info.combo > 1) rw += W.combo_attack * Math.floor((info.combo - 1) / 2);
    }
    if (info.ptype === 5 && (info.lines < 2 || info.spin !== 2)) rw += W.wasted_t;
    rw += W.softdrop * (info.sd || 0);
  }
  if (info && info.hasB2B) ev += W.has_back_to_back;
  let hc = 0;
  for (let x = 0; x < botContext.cols; x++) {
    const h = cc2H(c, x);
    if (!h) continue;
    const um = (1 << h) - 1;
    let holes = ~((c[x] || 0) >>> 0) & um;
    while (holes) {
      hc++;
      holes &= holes - 1;
    }
  }
  ev += W.holes * hc;
  let cov = 0;
  for (let x = 0; x < botContext.cols; x++) {
    const h = cc2H(c, x);
    if (!h) continue;
    const um = (1 << h) - 1;
    let holes = ~((c[x] || 0) >>> 0) & um;
    while (holes) {
      const bit = holes & -holes;
      let y = 0,
        t = bit >>> 0;
      while (t > 1) {
        t >>>= 1;
        y++;
      }
      cov += Math.min(h - y, W.max_cell_covered_height);
      holes &= holes - 1;
    }
  }
  ev += W.cell_coveredness * cov;
  let wCol = 0,
    wH = Infinity;
  for (let x = 0; x < botContext.cols; x++) {
    const h = cc2H(c, x);
    if (h < wH) {
      wH = h;
      wCol = x;
    }
  }
  let twd = 0;
  for (let y = wH; y < Math.min(botContext.rows, 31); y++) {
    let full = true;
    for (let x = 0; x < botContext.cols; x++) {
      if (x === wCol) continue;
      if (!(((c[x] || 0) >>> 0) & (1 << y))) {
        full = false;
        break;
      }
    }
    if (full) twd++;
    else break;
  }
  ev += twd * W.tetris_well_depth;
  let maxH = 0;
  for (let x = 0; x < botContext.cols; x++) {
    const h = cc2H(c, x);
    if (h > maxH) maxH = h;
  }
  ev += W.height * maxH;
  if (maxH > 10) ev += W.height_upper_half * (maxH - 10);
  if (maxH > 15) ev += W.height_upper_quarter * (maxH - 15);
  let rt = 0;
  const lc = (c[0] || 0) >>> 0,
    rc2 = (c[botContext.cols - 1] || 0) >>> 0;
  for (let y = 0; y < Math.min(botContext.rows, 31); y++) {
    if (!(lc & (1 << y))) rt++;
    if (!(rc2 & (1 << y))) rt++;
  }
  for (let x = 0; x < botContext.cols - 1; x++) {
    let d = ((c[x] || 0) ^ (c[x + 1] || 0)) & ((1 << Math.min(botContext.rows, 31)) - 1);
    while (d) {
      rt++;
      d &= d - 1;
    }
  }
  ev += rt * W.row_transitions;
  return ev + rw;
}

export function* cc2SearchGen(c, type, queue, b2b, combo, diff) {
  const sk = clamp((diff - 1) / 9, 0, 1);
  const scale = 0.3 + 0.7 * sk;
  const W = {};
  for (const k in CC2W) {
    if (Array.isArray(CC2W[k]))
      W[k] = CC2W[k].map(function (v) {
        return v * scale;
      });
    else if (typeof CC2W[k] === "number") W[k] = CC2W[k] * scale;
    else W[k] = CC2W[k];
  }
  W.perfect_clear = CC2W.perfect_clear;
  W.perfect_clear_override = CC2W.perfect_clear_override;
  let maxH = 0;
  for (let x = 0; x < botContext.cols; x++) {
    const h = cc2H(c, x);
    if (h > maxH) maxH = h;
  }
  const danger = clamp((maxH - (botContext.rows - 8)) / 8, 0, 1);
  const survBoost = 1 + danger * 2.5;
  W.holes *= survBoost;
  W.height *= survBoost;
  W.height_upper_half *= survBoost;
  W.height_upper_quarter *= survBoost;
  W.row_transitions *= survBoost;
  W.cell_coveredness *= survBoost;
  const noise = Math.max(0, (8 - diff) * 0.13);
  const mm = MODE_MOD[botContext.submode] || MODE_MOD.battle;
  W.holes *= mm.surv;
  W.height *= mm.surv;
  W.height_upper_half *= mm.surv;
  W.height_upper_quarter *= mm.surv;
  W.row_transitions *= mm.surv;
  W.cell_coveredness *= mm.surv;
  W.combo_attack *= mm.atk;
  W.back_to_back_clear *= mm.atk;
  for (let i = 1; i < W.normal_clears.length; i++) W.normal_clears[i] *= mm.clr;
  const mistake = Math.max(0, (7 - diff) * 0.012);
  const useLA = diff >= 3 && queue.length > 0;
  const useDeep = diff >= 6 && queue.length > 1;
  const topN1 = Math.round(6 + sk * 9);
  const tComing = queue.slice(0, 3).indexOf(5) >= 0;
  const moves = cc2FindMoves(c, type);
  if (!moves.length) return null;
  const scored = [];
  for (let i = 0; i < moves.length; i++) {
    if ((i & 31) === 31) yield;
    const mv = moves[i];
    const sim = cc2Sim(c, type, mv, b2b, combo);
    const s = cc2Eval(sim.c, W, sim.info) + cc2TSlotScore(sim.c, W, tComing);
    scored.push({ mv: mv, sim: sim, s: s });
  }
  scored.sort(function (a, b) {
    return b.s - a.s;
  });
  if (useLA) {
    const n1 = Math.min(scored.length, topN1);
    for (let i = 0; i < n1; i++) {
      yield;
      const node = scored[i];
      const nm = cc2FindMoves(node.sim.c, queue[0]);
      if (!nm.length) continue;
      let bestV = -Infinity,
        bestS2 = null;
      for (let j = 0; j < nm.length; j++) {
        const s2 = cc2Sim(node.sim.c, queue[0], nm[j], node.sim.nb, node.sim.nc2);
        const v = cc2Eval(s2.c, W, s2.info);
        if (v > bestV) {
          bestV = v;
          bestS2 = s2;
        }
      }
      let val = bestV;
      if (useDeep && bestS2) {
        const nm2 = cc2FindMoves(bestS2.c, queue[1]);
        if (nm2.length) {
          let bestV3 = -Infinity;
          for (let j = 0; j < nm2.length; j++) {
            const s3 = cc2Sim(bestS2.c, queue[1], nm2[j], bestS2.nb, bestS2.nc2);
            const v = cc2Eval(s3.c, W, s3.info);
            if (v > bestV3) bestV3 = v;
          }
          val = bestV * 0.5 + bestV3 * 0.5;
        }
      }
      node.s = node.s * 0.35 + val * 0.65;
    }
    scored.sort(function (a, b) {
      return b.s - a.s;
    });
  }
  if (noise > 0) {
    for (const n of scored) n.s += (botContext.random() * 2 - 1) * noise;
    scored.sort(function (a, b) {
      return b.s - a.s;
    });
  }
  if (mistake > 0 && botContext.random() < mistake && scored.length > 1) {
    const pool = scored.slice(0, Math.max(2, Math.ceil(scored.length * 0.4)));
    return pool[(botContext.random() * pool.length) | 0].mv;
  }
  return scored[0].mv;
}

export function cc2ToGame(mv) {
  return { rot: mv.rot, x: mv.x, y: botContext.rows - 1 - mv.y };
}

export const cc2Sim = ops.makeSim(cc2Place);
