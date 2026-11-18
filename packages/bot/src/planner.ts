// @ts-nocheck
import { KI, KJ } from "@tetrizz/core";
import { CC2W, cc2Eval, cc2H, cc2SearchGen, cc2Sim, cc2ToGame } from "./ten-wide";
import { wDanger, wEval, wMakeWeights, wSearchGen, wSim } from "./four-wide";
import { botContext } from "./context";
import { clamp } from "./math";
import { MODE_MOD } from "./mode-mod";

export function rotSteps(from, to, sk) {
  const d = (to - from + 4) % 4;
  if (d === 0) return [];
  if (d === 2 && sk >= 0.5) return ["180"];
  if (d === 2) return ["cw", "cw"];
  if (d === 1) return ["cw"];
  return ["ccw"];
}

export function* botPlanPureGen(cfg) {
  const c = cfg.c,
    cur = cfg.type;
  let doHold = false,
    hm = null,
    cm = null,
    nm = null,
    reuse = null;
  if (!cfg.holdUsed && cfg.skill.hold > 0) {
    const sk = clamp((cfg.diff - 1) / 9, 0, 1);
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
    cm = yield* cc2SearchGen(c, cur, cfg.queue, cfg.b2b > 0, cfg.combo, cfg.diff);
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
    const cs = cm ? cc2Sim(c, cur, cm, cfg.b2b > 0, cfg.combo) : null;
    const sCur = cs ? cc2Eval(cs.c, W, cs.info) : -Infinity;
    const age = Math.min(cfg.holdAge || 0, 8);
    if (cfg.hold !== null) {
      hm = yield* cc2SearchGen(c, cfg.hold, cfg.queue, cfg.b2b > 0, cfg.combo, cfg.diff);
      if (hm && cm) {
        const hs = cc2Sim(c, cfg.hold, hm, cfg.b2b > 0, cfg.combo);
        const sHeld = cc2Eval(hs.c, W, hs.info);
        let cost = 0.6 + (1 - cfg.skill.hold) * 1.8;
        cost *= 1 - danger * 0.75;
        cost -= age * 0.22;
        if (cost < -0.5) cost = -0.5;
        doHold = sHeld > sCur + cost;
      } else doHold = !!hm && !cm;
    } else if (cfg.queue.length > 0) {
      const nx = cfg.queue[0];
      nm = yield* cc2SearchGen(c, nx, cfg.queue.slice(1), cfg.b2b > 0, cfg.combo, cfg.diff);
      if (nm && cm) {
        const ns = cc2Sim(c, nx, nm, cfg.b2b > 0, cfg.combo);
        const sNext = cc2Eval(ns.c, W, ns.info);
        let cost = 0.9 + (1 - cfg.skill.hold) * 2.2;
        if (danger > 0.5) cost += (danger - 0.5) * 14;
        doHold = sNext > sCur + cost;
      } else doHold = !!nm && !cm;
    }
  }
  let hold = cfg.hold,
    finalType = cur,
    queue = cfg.queue,
    holdAction = null;
  if (doHold) {
    if (hold === null) {
      hold = cur;
      finalType = cfg.queue[0];
      queue = cfg.queue.slice(1);
      holdAction = { bank: cur, pull: finalType };
      reuse = nm;
    } else {
      const h = hold;
      hold = cur;
      finalType = h;
      holdAction = { bank: cur, pull: h };
      reuse = hm;
    }
  } else reuse = cm;
  const best =
    reuse || (yield* cc2SearchGen(c, finalType, queue, cfg.b2b > 0, cfg.combo, cfg.diff));
  if (!best) return { empty: true, holdAction: holdAction, finalType: finalType };
  const gm = cc2ToGame(best);
  if (best.spin > 0 && best.ki >= 0 && best.fromRot >= 0) {
    const fromRot = best.fromRot;
    const kicks = KJ[fromRot + ">" + best.rot];
    const preX = gm.x - kicks[best.ki][0];
    const delta = (best.rot - fromRot + 4) % 4;
    const spinKind = delta === 1 ? 1 : delta === 3 ? -1 : 2;
    const spinInfo = best.spin === 2 ? { mini: false } : { mini: true };
    return {
      plan: {
        kind: "S",
        fromRot: fromRot,
        preX: preX,
        spinKind: spinKind,
        targetRot: best.rot,
        targetX: gm.x,
        fy: gm.y,
        spin: spinInfo,
      },
      topActions: rotSteps(0, fromRot, cfg.skill.sk),
      holdAction: holdAction,
      finalType: finalType,
    };
  }
  return {
    plan: {
      kind: "N",
      targetRot: gm.rot,
      targetX: gm.x,
      fy: gm.y,
      spin: null,
      spinKind: null,
    },
    topActions: rotSteps(0, gm.rot, cfg.skill.sk),
    holdAction: holdAction,
    finalType: finalType,
  };
}

export function* botPlanPureWideGen(cfg) {
  const c = cfg.c,
    cur = cfg.type;
  let doHold = false,
    hm = null,
    cm = null,
    nm = null,
    reuse = null;
  if (!cfg.holdUsed && cfg.skill.hold > 0) {
    const W = wMakeWeights(cfg.diff);
    cm = yield* wSearchGen(c, cur, cfg.queue, cfg.b2b > 0, cfg.combo, cfg.diff, cfg.hold);
    const cs = cm ? wSim(c, cur, cm, cfg.b2b > 0, cfg.combo) : null;
    const sCur = cs ? wEval(cs.c, W, cs.info) : -Infinity;
    const danger = wDanger(c);
    const age = Math.min(cfg.holdAge || 0, 8);
    if (cfg.hold !== null) {
      hm = yield* wSearchGen(c, cfg.hold, cfg.queue, cfg.b2b > 0, cfg.combo, cfg.diff, cfg.hold);
      if (hm && cm) {
        const hs = wSim(c, cfg.hold, hm, cfg.b2b > 0, cfg.combo);
        const sHeld = wEval(hs.c, W, hs.info);
        let cost = 0.5 + (1 - cfg.skill.hold) * 1.5;
        cost *= 1 - danger * 0.75;
        cost -= age * 0.22;
        if (cost < -0.5) cost = -0.5;
        doHold = sHeld > sCur + cost;
      } else doHold = !!hm && !cm;
    } else if (cfg.queue.length > 0) {
      const nx = cfg.queue[0];
      nm = yield* wSearchGen(c, nx, cfg.queue.slice(1), cfg.b2b > 0, cfg.combo, cfg.diff, cfg.hold);
      if (nm && cm) {
        const ns = wSim(c, nx, nm, cfg.b2b > 0, cfg.combo);
        const sNext = wEval(ns.c, W, ns.info);
        let cost = 0.8 + (1 - cfg.skill.hold) * 2.0;
        if (danger > 0.5) cost += (danger - 0.5) * 14;
        doHold = sNext > sCur + cost;
      } else doHold = !!nm && !cm;
    }
  }
  let hold = cfg.hold,
    finalType = cur,
    queue = cfg.queue,
    holdAction = null;
  if (doHold) {
    if (hold === null) {
      hold = cur;
      finalType = cfg.queue[0];
      queue = cfg.queue.slice(1);
      holdAction = { bank: cur, pull: finalType };
      reuse = nm;
    } else {
      const h = hold;
      hold = cur;
      finalType = h;
      holdAction = { bank: cur, pull: h };
      reuse = hm;
    }
  } else reuse = cm;
  const best =
    reuse || (yield* wSearchGen(c, finalType, queue, cfg.b2b > 0, cfg.combo, cfg.diff, hold));
  if (!best) return { empty: true, holdAction: holdAction, finalType: finalType };
  if (best.spin > 0 && best.ki >= 0 && best.fromRot >= 0) {
    const fromRot = best.fromRot;
    const table = finalType === 0 ? KI : KJ;
    const kicks = table[fromRot + ">" + best.rot] || [[0, 0]];
    const preX = best.x - (kicks[best.ki] ? kicks[best.ki][0] : 0);
    const delta = (best.rot - fromRot + 4) % 4;
    const spinKind = delta === 1 ? 1 : delta === 3 ? -1 : 2;
    const spinInfo = best.spin === 2 ? { mini: false } : { mini: true };
    return {
      plan: {
        kind: "S",
        fromRot: fromRot,
        preX: preX,
        spinKind: spinKind,
        targetRot: best.rot,
        targetX: best.x,
        fy: botContext.rows - 1 - best.y,
        spin: spinInfo,
      },
      topActions: rotSteps(0, fromRot, cfg.skill.sk),
      holdAction: holdAction,
      finalType: finalType,
    };
  }
  return {
    plan: {
      kind: "N",
      targetRot: best.rot,
      targetX: best.x,
      fy: botContext.rows - 1 - best.y,
      spin: null,
      spinKind: null,
    },
    topActions: rotSteps(0, best.rot, cfg.skill.sk),
    holdAction: holdAction,
    finalType: finalType,
  };
}
