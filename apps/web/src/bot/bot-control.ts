// @ts-nocheck
import { clock } from "../core/clock";
import { recordPagePlan, recordPageThink } from "../core/metrics";
import { gameRandom } from "../core/random";
import { PIECES, calcAttack, calcLockScore, tryRotateOn } from "@tetrizz/core";
import { HID, LOCK_MS, MAX_RESETS, clamp, configState, lerp, dims } from "../core/config";
import { game } from "../game/state";
import {
  CLEARV0,
  CLEARV_PER,
  DROPV,
  SFX,
  emptyRow,
  findFullRows,
  levelForLines,
  pcAfterClear,
  spliceRows,
} from "../engine/engine";
import { spawnXFor } from "../render/render";
import { swipeCancelSoft } from "../ui/controls";
import { MP, onSpawnIdx, versusLobbyState, vsGarbageMode } from "../versus/lobby";
import {
  calcLockLabel,
  consumeIdx,
  ensureStream,
  insertActiveIdx,
  refreshQueuesAll,
  sendAttack,
  stTopOut,
  vsMult,
} from "../versus/garbage";
import {
  SPIN_SHOW_MS,
  botCollide,
  botSdfFor,
  drawStHold,
  drawStNexts,
  showStAction,
  stBanner,
  stBurstAt,
  stCheckDanger,
  stFxKick,
  stUpdateChips,
} from "../versus/stations";
import {
  MODE_MOD,
  cc2Board,
  cc2H,
  createPlanGen,
  paceCarry,
  paceDeadline,
  setBotContext,
  wBoard,
} from "@tetrizz/bot";
import { botPlanningOffloaded, checkPlanHandle, startPlan } from "./planning";

export const botControlState = {
  _frameGap: undefined,
  _frameWork: undefined,
  _lastFrameTs: undefined,
  /** False on the extra simulation steps of one frame, so bots do not think more than once per frame. */
  thinkSlice: true,
};

/** Copies the current board size and versus sub-mode into the shared bot context. */
function currentPlanContext() {
  return {
    cols: configState.COLS,
    rows: configState.ROWS,
    submode: versusLobbyState.vs.submode,
  };
}

function syncBotContext() {
  setBotContext(currentPlanContext());
}

export function botDiff() {
  const p = versusLobbyState.vs.players[versusLobbyState.bot.slot];
  return p && p.type === "bot" && typeof p.diff === "number" ? p.diff : versusLobbyState.vs.diff;
}

export function botSkill() {
  const L = botDiff(),
    sk = clamp((L - 1) / 9, 0, 1);
  return {
    sk: sk,
    noise: Math.max(0, (8 - L) * 0.13),
    mistake: Math.max(0, (7 - L) * 0.012),
    spin: L >= 2 ? clamp((L - 1) / 8, 0, 1) : 0,
    pc: L >= 5 ? clamp((L - 4) / 5, 0, 1) : 0,
    hold: L >= 2 ? clamp((L - 1) / 8, 0, 1) : 0,
  };
}

function dynPps(skill) {
  const c = cc2Board(versusLobbyState.bot.board);
  let mx = 0;
  for (let x = 0; x < configState.COLS; x++) {
    const h = cc2H(c, x);
    if (h > mx) mx = h;
  }
  const sk = skill.sk;
  const base = 0.2 + Math.pow(sk, 1.35) * 4.8;
  const danger = 1 + clamp((mx - (configState.ROWS - 6)) / 10, 0, 1) * 0.4;
  let eff = base * danger;
  eff *= clamp((MODE_MOD[versusLobbyState.vs.submode] || MODE_MOD.battle).clr, 0.8, 1.3);
  if (versusLobbyState.bot.plan && versusLobbyState.bot.plan.spinKind != null) eff *= 0.92;
  eff *= 0.94 + gameRandom() * 0.12;
  return clamp(eff, 0.15, 6);
}

function resetBotTiming() {
  const p = versusLobbyState.vs.players[versusLobbyState.bot.slot];
  const useAuto = p && p.type === "bot" ? p.autoPps : versusLobbyState.vs.autoPps;
  const usePps =
    p && p.type === "bot" && typeof p.pps === "number" ? p.pps : versusLobbyState.vs.pps;
  const eff = useAuto ? dynPps(versusLobbyState.bot.skill) : usePps;
  const budget = Math.max(90, 1000 / eff);
  versusLobbyState.bot.budgetMs = budget;
  versusLobbyState.bot.pieceStart = versusLobbyState.vsTime;
  versusLobbyState.bot.deadline = paceDeadline(
    versusLobbyState.vsTime,
    budget,
    versusLobbyState.bot.paceCarry || 0,
  );
  versusLobbyState.bot.paceCarry = 0;
  versusLobbyState.bot.execIdx = 0;
  versusLobbyState.bot.topAcc = 0;
  versusLobbyState.bot.gravT = 0;
  versusLobbyState.bot.spinDone = false;
  versusLobbyState.bot.spinAt = 0;
  versusLobbyState.bot.stallDir = 1;
  versusLobbyState.bot.bottomFail = 0;
  queueSpecThink();
}

function botDoHoldAction(act) {
  if (!act) return;
  if (versusLobbyState.bot.hold === null) {
    versusLobbyState.bot.hold = act.bank;
    const nt = consumeIdx(versusLobbyState.bot.idx);
    refreshQueuesAll();
    botSetPiece(nt);
  } else {
    versusLobbyState.bot.hold = act.bank;
    botSetPiece(act.pull);
  }
  versusLobbyState.bot.holdUsed = true;
  versusLobbyState.bot.holdAge = 0;
  drawStHold(versusLobbyState.bot);
  drawStNexts(versusLobbyState.bot);
}

export function applyPlanResult(res) {
  botDoHoldAction(res.holdAction);
  if (!versusLobbyState.bot.piece || !versusLobbyState.bot.alive) return;
  if (versusLobbyState.bot.piece.type !== res.finalType) {
    versusLobbyState.bot.plan = null;
    return;
  }
  if (res.empty) {
    versusLobbyState.bot.plan = {
      kind: "N",
      targetRot: versusLobbyState.bot.piece.rot,
      targetX: versusLobbyState.bot.piece.x,
      fy: versusLobbyState.bot.piece.y,
      spin: null,
      spinKind: null,
    };
    versusLobbyState.bot.topActions = [];
    resetBotTiming();
    return;
  }
  versusLobbyState.bot.plan = res.plan;
  versusLobbyState.bot.topActions = res.topActions;
  resetBotTiming();
}

/**
 * Builds the planning request for the bot's current piece and refreshes its skill and soft-drop
 * speed. Returns null when there is nothing to plan yet.
 */
function prepareThinkRequest() {
  const bot = versusLobbyState.bot;
  if (!bot.piece || !bot.alive) return null;
  const wide = versusLobbyState.vs.submode === "wide";
  if (bot.pieces === 0 && game.state !== "playing") {
    if (wide) bot.plan = null;
    return null;
  }
  bot.skill = botSkill();
  bot.sdf = botSdfFor(bot.skill.sk);
  bot.softMs = bot.sdf === Infinity ? 0 : Math.round(140 / bot.sdf);
  ensureStream(MP.ptrs[bot.idx] + 7);
  return {
    kind: wide ? "wide" : "ten",
    cfg: {
      c: wide ? wBoard(bot.board) : cc2Board(bot.board),
      type: bot.piece.type,
      queue: bot.queue.slice(0, 5),
      hold: bot.hold,
      holdUsed: bot.holdUsed,
      holdAge: bot.holdAge || 0,
      skill: bot.skill,
      b2b: bot.b2b,
      combo: bot.combo,
      diff: botDiff(),
    },
  };
}

function finishThink(res) {
  if (!versusLobbyState.bot.piece || !versusLobbyState.bot.alive) return;
  applyPlanResult(res);
}

function* botThinkGen() {
  const req = prepareThinkRequest();
  if (!req) return null;
  const res = yield* createPlanGen(req.kind, req.cfg);
  finishThink(res);
  return null;
}

/**
 * Whether bots may plan on this simulation step. A drawn frame split into several steps lets them
 * plan on the first step only; a hidden page draws nothing, so every step may.
 */
function mayThinkThisStep() {
  return botControlState.thinkSlice || document.hidden;
}

/** Time a bot may spend planning in one step: unlimited on a hidden page, so a plan always finishes. */
function thinkBudgetFor(visibleBudgetMs) {
  return document.hidden ? Infinity : visibleBudgetMs;
}

/** Adds planning time to the frame's figures; a hidden page has no frames to attribute it to. */
function recordPageThinkTime(ms) {
  if (!document.hidden) recordPageThink(ms);
}

function thinkBudgetMs() {
  if (versusLobbyState.vs.autoPps) {
    const gms = versusLobbyState.bot.gravMs || 1000;
    return clamp(6 + (1000 - Math.max(gms, 8)) * 0.015, 6, 16);
  }
  return clamp((1000 / Math.max(0.25, versusLobbyState.vs.pps)) * 0.15, 3, 8);
}

function startBotThink() {
  if (!versusLobbyState.bot || !versusLobbyState.bot.alive || !versusLobbyState.bot.piece) return;
  if (!botPlanningOffloaded()) {
    versusLobbyState.bot.thinkGen = botThinkGen();
    return;
  }
  const req = prepareThinkRequest();
  if (!req) return;
  versusLobbyState.bot.thinkGen = {
    async: true,
    handle: startPlan(req.kind, req.cfg, currentPlanContext()),
  };
}

function pollAsyncThink() {
  const bot = versusLobbyState.bot;
  const handle = bot.thinkGen.handle;
  checkPlanHandle(handle);
  if (handle.gen) {
    const gen = handle.gen;
    bot.thinkGen = (function* () {
      finishThink(yield* gen);
      return null;
    })();
    return;
  }
  if (!handle.result) return;
  bot.thinkGen = null;
  finishThink(handle.result);
}

function stepBotThink() {
  if (!versusLobbyState.bot || !versusLobbyState.bot.thinkGen) return;
  if (versusLobbyState.bot.thinkGen.async) {
    pollAsyncThink();
    return;
  }
  if (!mayThinkThisStep()) return;
  const budget = thinkBudgetFor(thinkBudgetMs());
  const t0 = clock.now();
  for (;;) {
    const r = versusLobbyState.bot.thinkGen.next();
    if (r.done) {
      versusLobbyState.bot.thinkGen = null;
      recordPagePlan();
      break;
    }
    if (clock.now() - t0 >= budget) break;
  }
  recordPageThinkTime(clock.now() - t0);
}

function botGravityOnly(dt) {
  const p = versusLobbyState.bot.piece;
  if (!p) return;
  const gms = versusLobbyState.bot.gravMs || game.gravMs || 1000;
  if (!botCollide(p.cells, p.x, p.y + 1)) {
    p.lockT = 0;
    versusLobbyState.bot.gravT += dt;
    let gg = 0;
    while (versusLobbyState.bot.gravT >= gms && gg++ < 80) {
      versusLobbyState.bot.gravT -= gms;
      if (!botFallStep()) {
        versusLobbyState.bot.gravT = 0;
        break;
      }
    }
  } else versusLobbyState.bot.gravT = 0;
}

function specBudgetMs() {
  return clamp(botControlState._frameGap - botControlState._frameWork - 2.5, 4, 12);
}

export function boardHash(bd) {
  let h = 2166136261 >>> 0;
  for (let y = 0; y < configState.ROWS; y++) {
    const r = bd[y];
    for (let x = 0; x < configState.COLS; x++) h = Math.imul(h ^ (r[x] | 0), 16777619) >>> 0;
  }
  return h;
}

function simPlaceClear(bd, type, rot, x, fy) {
  const nb = bd.map((r) => r.slice());
  const cells = PIECES[type].cells[rot];
  let allHidden = true;
  for (const q of cells) {
    const X = x + q[0],
      Y = fy + q[1];
    if (X < 0 || X >= configState.COLS || Y >= configState.ROWS) return null;
    if (Y >= 0) nb[Y][X] = type + 1;
    if (Y >= HID) allHidden = false;
  }
  if (allHidden) return null;
  const rows = [];
  for (let y = 0; y < configState.ROWS; y++) if (nb[y].every((v) => v)) rows.push(y);
  for (const r of rows) {
    nb.splice(r, 1);
    nb.unshift(emptyRow());
  }
  return { bd: nb, lines: rows.length };
}

function simInsertGarbage(bd) {
  const nb = bd.map((r) => r.slice());
  let cap = 8,
    overflow = false;
  const q =
    versusLobbyState.bot && versusLobbyState.bot.idx !== undefined
      ? MP.qs[versusLobbyState.bot.idx]
      : [];
  for (const p of q) {
    if (cap <= 0 || p.state !== "active") continue;
    const take = Math.min(cap, p.holes.length);
    cap -= take;
    for (let i = 0; i < take; i++) {
      const h = p.holes[i];
      const removed = nb.shift();
      if (!overflow && removed && removed.some((v) => v)) overflow = true;
      const row = emptyRow();
      for (let x = 0; x < configState.COLS; x++) if (x !== h) row[x] = 8;
      nb.push(row);
    }
  }
  return { bd: nb, overflow: overflow };
}

function queueSpecThink() {
  if (
    !versusLobbyState.bot ||
    !versusLobbyState.bot.alive ||
    !versusLobbyState.bot.piece ||
    !versusLobbyState.bot.plan ||
    versusLobbyState.bot.spec
  )
    return;
  if (typeof versusLobbyState.bot.plan.fy !== "number") return;
  if (game.state !== "playing") return;
  const p = versusLobbyState.bot.piece;
  const spinInfo = versusLobbyState.bot.plan.spin || null;
  const sim = simPlaceClear(
    versusLobbyState.bot.board,
    p.type,
    versusLobbyState.bot.plan.targetRot,
    versusLobbyState.bot.plan.targetX,
    versusLobbyState.bot.plan.fy,
  );
  if (!sim) return;
  let bd = sim.bd;
  if (vsGarbageMode()) {
    const gi = simInsertGarbage(bd);
    if (gi.overflow) return;
    bd = gi.bd;
  }
  const lines = sim.lines;
  const difficult =
    lines === 4 ||
    (spinInfo && !spinInfo.mini && lines >= 1) ||
    (spinInfo && spinInfo.mini && lines === 2);
  let b2b = versusLobbyState.bot.b2b,
    combo = versusLobbyState.bot.combo;
  if (lines) combo++;
  else combo = -1;
  if (lines || spinInfo) {
    if (difficult) b2b++;
    else if (lines) b2b = 0;
  }
  const nextType = versusLobbyState.bot.queue[0];
  if (nextType === undefined || nextType === null) return;
  ensureStream(MP.ptrs[versusLobbyState.bot.idx] + 8);
  const skill = versusLobbyState.bot.skill || botSkill();
  const cfg = {
    c: versusLobbyState.vs.submode === "wide" ? wBoard(bd) : cc2Board(bd),
    type: nextType,
    queue: versusLobbyState.sharedStream.slice(
      MP.ptrs[versusLobbyState.bot.idx] + 1,
      MP.ptrs[versusLobbyState.bot.idx] + 6,
    ),
    hold: versusLobbyState.bot.hold,
    holdUsed: false,
    holdAge: (versusLobbyState.bot.holdAge || 0) + 1,
    skill: skill,
    b2b: b2b,
    combo: combo,
    diff: botDiff(),
  };
  const kind = versusLobbyState.vs.submode === "wide" ? "wide" : "ten";
  const handle = botPlanningOffloaded() ? startPlan(kind, cfg, currentPlanContext()) : null;
  versusLobbyState.bot.spec = {
    bIdx: MP.ptrs[versusLobbyState.bot.idx],
    holdAtStart: versusLobbyState.bot.hold,
    diffAtStart: versusLobbyState.vs.diff,
    submodeAtStart: versusLobbyState.vs.submode,
    boardHash: boardHash(bd),
    handle,
    gen: handle ? null : createPlanGen(kind, cfg),
    result: null,
  };
}

function stepSpecThink() {
  const spec = versusLobbyState.bot && versusLobbyState.bot.spec;
  if (!spec) return;
  if (spec.handle) {
    checkPlanHandle(spec.handle);
    if (spec.handle.gen) {
      spec.gen = spec.handle.gen;
      spec.handle = null;
    } else {
      if (spec.handle.result) {
        spec.result = spec.handle.result;
        spec.handle = null;
      }
      return;
    }
  }
  if (!spec.gen || !mayThinkThisStep()) return;
  const budget = thinkBudgetFor(specBudgetMs());
  const t0 = clock.now();
  for (;;) {
    const r = spec.gen.next();
    if (r.done) {
      spec.result = r.value || null;
      spec.gen = null;
      recordPagePlan();
      break;
    }
    if (clock.now() - t0 >= budget) break;
  }
  recordPageThinkTime(clock.now() - t0);
}

function tryApplySpec() {
  const sp = versusLobbyState.bot.spec;
  if (!sp || !sp.result) return false;
  versusLobbyState.bot.spec = null;
  if (!versusLobbyState.bot.alive || !versusLobbyState.bot.piece || game.state !== "playing")
    return false;
  if (
    sp.diffAtStart !== versusLobbyState.vs.diff ||
    sp.submodeAtStart !== versusLobbyState.vs.submode
  )
    return false;
  if (sp.bIdx !== MP.ptrs[versusLobbyState.bot.idx] - 1) return false;
  if (sp.holdAtStart !== versusLobbyState.bot.hold) return false;
  if (boardHash(versusLobbyState.bot.board) !== sp.boardHash) return false;
  const res = sp.result;
  botDoHoldAction(res.holdAction);
  if (!versusLobbyState.bot.piece || !versusLobbyState.bot.alive) return false;
  if (versusLobbyState.bot.piece.type !== res.finalType) return false;
  versusLobbyState.bot.skill = versusLobbyState.bot.skill || botSkill();
  versusLobbyState.bot.sdf = botSdfFor(versusLobbyState.bot.skill.sk);
  versusLobbyState.bot.softMs =
    versusLobbyState.bot.sdf === Infinity ? 0 : Math.round(140 / versusLobbyState.bot.sdf);
  if (res.empty) {
    versusLobbyState.bot.plan = {
      kind: "N",
      targetRot: versusLobbyState.bot.piece.rot,
      targetX: versusLobbyState.bot.piece.x,
      fy: versusLobbyState.bot.piece.y,
      spin: null,
      spinKind: null,
    };
    versusLobbyState.bot.topActions = [];
    resetBotTiming();
    return true;
  }
  versusLobbyState.bot.plan = res.plan;
  versusLobbyState.bot.topActions = res.topActions;
  resetBotTiming();
  return true;
}

export function botStep(dt) {
  if (!versusLobbyState.bot || !versusLobbyState.bot.alive) return;
  syncBotContext();
  if (!versusLobbyState.bot.piece) {
    botPull();
    return;
  }
  if (!versusLobbyState.bot.skill) {
    versusLobbyState.bot.skill = botSkill();
    versusLobbyState.bot.sdf = botSdfFor(versusLobbyState.bot.skill.sk);
    versusLobbyState.bot.softMs =
      versusLobbyState.bot.sdf === Infinity ? 0 : Math.round(140 / versusLobbyState.bot.sdf);
  }
  if (!versusLobbyState.bot.plan) {
    if (versusLobbyState.bot.spec) {
      stepSpecThink();
      if (versusLobbyState.bot.spec && versusLobbyState.bot.spec.result) tryApplySpec();
    }
    if (!versusLobbyState.bot.plan) {
      if (!versusLobbyState.bot.thinkGen) startBotThink();
      if (versusLobbyState.bot.thinkGen) stepBotThink();
      if (!versusLobbyState.bot.plan) {
        botGravityOnly(dt);
        return;
      }
    }
  } else if (
    versusLobbyState.bot.spec &&
    (versusLobbyState.bot.spec.gen || versusLobbyState.bot.spec.handle)
  )
    stepSpecThink();
  const p = versusLobbyState.bot.piece;
  const now = versusLobbyState.vsTime;
  const sk = versusLobbyState.bot.skill.sk;
  if (versusLobbyState.vs.submode === "wide" && versusLobbyState.bot.plan.spinKind == null) {
    const doneRots =
      !versusLobbyState.bot.topActions ||
      versusLobbyState.bot.execIdx >= versusLobbyState.bot.topActions.length;
    if (
      doneRots &&
      typeof versusLobbyState.bot.plan.targetX === "number" &&
      p.x === versusLobbyState.bot.plan.targetX &&
      botCollide(p.cells, p.x, p.y + 1)
    ) {
      botHardDrop();
      return;
    }
  }
  const gms = versusLobbyState.bot.gravMs || game.gravMs || 1000;
  const isSpin = versusLobbyState.bot.plan.spinKind != null;
  const moveTarget = isSpin ? versusLobbyState.bot.plan.preX : versusLobbyState.bot.plan.targetX;
  const rotDone = versusLobbyState.bot.execIdx >= versusLobbyState.bot.topActions.length;
  let rest = botCollide(p.cells, p.x, p.y + 1);
  if (!rest) {
    p.lockT = 0;
    const fallMs =
      isSpin && rotDone && p.x === moveTarget
        ? Math.max(1, Math.min(gms, versusLobbyState.bot.softMs || 1))
        : gms;
    versusLobbyState.bot.gravT += dt;
    let gg = 0;
    while (versusLobbyState.bot.gravT >= fallMs && gg++ < 80) {
      versusLobbyState.bot.gravT -= fallMs;
      if (!botFallStep()) {
        versusLobbyState.bot.gravT = 0;
        break;
      }
    }
  } else {
    versusLobbyState.bot.gravT = 0;
  }
  rest = botCollide(p.cells, p.x, p.y + 1);
  if (!rotDone) {
    versusLobbyState.bot.topAcc += dt;
    const n = Math.max(1, versusLobbyState.bot.topActions.length);
    const per = clamp(
      ((versusLobbyState.bot.budgetMs || 0) * lerp(0.6, 0.22, sk)) / n,
      lerp(70, 12, sk),
      lerp(220, 40, sk),
    );
    let gg = 0;
    while (
      versusLobbyState.bot.topAcc >= per &&
      versusLobbyState.bot.execIdx < versusLobbyState.bot.topActions.length &&
      gg++ < 8
    ) {
      botTopDo(versusLobbyState.bot.topActions[versusLobbyState.bot.execIdx]);
      versusLobbyState.bot.execIdx++;
      versusLobbyState.bot.topAcc -= per;
    }
  }
  if (rotDone && p.x !== moveTarget) {
    versusLobbyState.bot.topAcc += dt;
    const per = lerp(110, 22, sk);
    let gg = 0;
    while (versusLobbyState.bot.topAcc >= per && gg++ < 6) {
      versusLobbyState.bot.topAcc -= per;
      const dir = moveTarget > p.x ? 1 : -1;
      if (!botDoMove(dir)) break;
    }
  }
  rest = botCollide(p.cells, p.x, p.y + 1);
  const readyNow =
    versusLobbyState.bot.execIdx >= versusLobbyState.bot.topActions.length && p.x === moveTarget;
  if (rest) {
    if (!readyNow) {
      versusLobbyState.bot.topAcc += dt;
      const per = lerp(100, 22, sk);
      if (versusLobbyState.bot.topAcc >= per) {
        versusLobbyState.bot.topAcc = 0;
        if (versusLobbyState.bot.execIdx < versusLobbyState.bot.topActions.length) {
          botTopDo(versusLobbyState.bot.topActions[versusLobbyState.bot.execIdx]);
          versusLobbyState.bot.execIdx++;
        } else if (p.x !== moveTarget) {
          const dir = moveTarget > p.x ? 1 : -1;
          if (!botDoMove(dir)) {
            versusLobbyState.bot.bottomFail = (versusLobbyState.bot.bottomFail || 0) + 1;
            if (versusLobbyState.bot.bottomFail >= 8) {
              botHardDrop();
              return;
            }
          }
        }
      }
    } else if (isSpin) {
      if (!versusLobbyState.bot.spinDone) {
        botDoRotate(versusLobbyState.bot.plan.spinKind);
        versusLobbyState.bot.spinDone = true;
        versusLobbyState.bot.spinAt = now;
        stFxKick(
          versusLobbyState.bot,
          0,
          0,
          versusLobbyState.bot.plan.spinKind === 1
            ? 55
            : versusLobbyState.bot.plan.spinKind === -1
              ? -55
              : 0,
        );
      } else if (now - (versusLobbyState.bot.spinAt || 0) >= SPIN_SHOW_MS) {
        botHardDrop();
        return;
      }
    }
    p.lockT += dt;
    if (p.lockT >= LOCK_MS || (p.lockResets || 0) >= MAX_RESETS) {
      botLockPiece();
      return;
    }
  } else {
    if (!isSpin && readyNow && now >= versusLobbyState.bot.deadline) {
      botHardDrop();
      return;
    }
  }
}

function botRotateKind(kind) {
  const p = versusLobbyState.bot.piece;
  if (!p || p.type === 3) return false;
  const r = tryRotateOn(versusLobbyState.bot.board, dims, p, kind);
  if (!r) return false;
  p.x = r.x;
  p.y = r.y;
  p.rot = r.rot;
  p.cells = r.cells;
  return true;
}

function botMove(d) {
  const p = versusLobbyState.bot.piece;
  if (!p) return false;
  if (!botCollide(p.cells, p.x + d, p.y)) {
    p.x += d;
    return true;
  }
  return false;
}

function botFallStep() {
  const p = versusLobbyState.bot.piece;
  if (!p) return false;
  if (!botCollide(p.cells, p.x, p.y + 1)) {
    p.y++;
    return true;
  }
  return false;
}

function botAfterAction() {
  const p = versusLobbyState.bot.piece;
  if (!p) return;
  p.lockResets = (p.lockResets || 0) + 1;
  if (p.lockResets >= MAX_RESETS) return;
  if (!botCollide(p.cells, p.x, p.y + 1)) return;
  p.lockT = 0;
}

function botDoMove(d) {
  const ok = botMove(d);
  if (ok) botAfterAction();
  return ok;
}

function botDoRotate(kind) {
  const ok = botRotateKind(kind);
  if (ok) botAfterAction();
  return ok;
}

function botTopDo(a) {
  const p = versusLobbyState.bot.piece;
  if (!p) return false;
  if (a === "l") return botDoMove(-1);
  if (a === "r") return botDoMove(1);
  if (a === "cw") return botDoRotate(1);
  if (a === "ccw") return botDoRotate(-1);
  if (a === "180") return botDoRotate(2);
  return false;
}

function botHardDrop() {
  const p = versusLobbyState.bot.piece;
  if (!p) return;
  SFX.slam();
  stFxKick(versusLobbyState.bot, 0, DROPV, 0);
  let gg = 0;
  while (!botCollide(p.cells, p.x, p.y + 1) && gg++ < configState.ROWS + 4) p.y++;
  botLockPiece();
}

function botSetPiece(t) {
  versusLobbyState.bot.piece = {
    type: t,
    rot: 0,
    x: spawnXFor(t),
    y: 0,
    cells: PIECES[t].cells[0],
    lockT: 0,
    lockResets: 0,
  };
  if (
    botCollide(
      versusLobbyState.bot.piece.cells,
      versusLobbyState.bot.piece.x,
      versusLobbyState.bot.piece.y,
    )
  )
    stTopOut(versusLobbyState.bot);
  versusLobbyState.bot.plan = null;
}

function botEnter(t) {
  botSetPiece(t);
  if (!versusLobbyState.bot.alive) return;
  if (versusLobbyState.bot.spec) {
    if (versusLobbyState.bot.spec.result && tryApplySpec()) return;
    if (versusLobbyState.bot.spec) return;
  }
  startBotThink();
}

export function botPull() {
  if (!versusLobbyState.bot.alive) return;
  const t = consumeIdx(versusLobbyState.bot.idx);
  refreshQueuesAll();
  versusLobbyState.bot.holdUsed = false;
  botEnter(t);
  drawStHold(versusLobbyState.bot);
  drawStNexts(versusLobbyState.bot);
  if (versusLobbyState.vsActive && versusLobbyState.bot.alive) onSpawnIdx(versusLobbyState.bot.idx);
}

function botLockPiece() {
  const p = versusLobbyState.bot.piece;
  if (!p) return;
  swipeCancelSoft(versusLobbyState.bot);
  versusLobbyState.bot.paceCarry = paceCarry(
    versusLobbyState.vsTime,
    versusLobbyState.bot.deadline,
  );
  const spinInfo = versusLobbyState.bot.plan ? versusLobbyState.bot.plan.spin : null;
  versusLobbyState.bot.piece = null;
  versusLobbyState.bot.plan = null;
  let allHidden = true;
  const placed = [];
  for (const q of p.cells) {
    const X = p.x + q[0],
      Y = p.y + q[1];
    if (Y >= 0) versusLobbyState.bot.board[Y][X] = p.type + 1;
    if (Y >= HID) allHidden = false;
    placed.push([X, Y]);
  }
  versusLobbyState.bot.pieces++;
  versusLobbyState.bot.holdAge = (versusLobbyState.bot.holdAge || 0) + 1;
  const heavy = !!spinInfo;
  for (const pl of placed) {
    if (pl[1] >= HID)
      stBurstAt(
        versusLobbyState.bot,
        pl[0],
        pl[1],
        p.type,
        heavy ? 4 : 2,
        true,
        heavy ? 1.35 : 0.9,
      );
  }
  if (allHidden) {
    stTopOut(versusLobbyState.bot);
    return;
  }
  const rows = findFullRows(versusLobbyState.bot.board);
  const willPC = pcAfterClear(versusLobbyState.bot.board, rows);
  for (const r of rows) {
    for (let x = 0; x < configState.COLS; x++)
      stBurstAt(versusLobbyState.bot, x, r, versusLobbyState.bot.board[r][x] - 1, 4, true, 1.5);
  }
  spliceRows(versusLobbyState.bot.board, rows);
  const _ls3 = calcLockScore(
    rows.length,
    spinInfo,
    versusLobbyState.bot.level,
    versusLobbyState.bot.combo,
    versusLobbyState.bot.b2b,
    willPC,
  );
  const _ll3 = calcLockLabel(rows.length, spinInfo, p.type);
  versusLobbyState.bot.combo = _ls3.nc;
  versusLobbyState.bot.maxCombo = Math.max(
    versusLobbyState.bot.maxCombo,
    versusLobbyState.bot.combo,
  );
  versusLobbyState.bot.b2b = _ls3.nb;
  versusLobbyState.bot.score += _ls3.pts;
  versusLobbyState.bot.lines += rows.length;
  const pts = _ls3.pts;
  const comboPts = _ls3.comboPts;
  const difficult = _ls3.difficult;
  let atk = 0;
  if (vsGarbageMode())
    atk = Math.floor(
      calcAttack(
        rows.length,
        spinInfo,
        willPC,
        versusLobbyState.bot.b2b,
        versusLobbyState.bot.combo,
      ) * vsMult(),
    );
  versusLobbyState.bot.level = levelForLines("vsbot", versusLobbyState.bot.lines);
  if (rows.length) stFxKick(versusLobbyState.bot, 0, CLEARV0 + CLEARV_PER * rows.length, 0);
  const label = _ll3.label,
    cls = _ll3.cls,
    labelCol = _ll3.labelCol;
  if (spinInfo) {
    if (rows.length) SFX.spinClear();
    else SFX.spinMove();
  } else if (rows.length === 4) {
    SFX.tetris();
  } else if (rows.length) {
    SFX.chime();
  } else SFX.lock();
  if (rows.length && versusLobbyState.bot.combo >= 1) SFX.combo(versusLobbyState.bot.combo);
  if (willPC && rows.length) {
    SFX.pc();
    stBanner(versusLobbyState.bot, "PERFECT CLEAR", "#ffd23f", null);
  }
  if (label) {
    let sub = "";
    if (!vsGarbageMode()) {
      const _p = ["+" + pts];
      if (difficult && versusLobbyState.bot.b2b >= 2) _p.push("B2B ×" + versusLobbyState.bot.b2b);
      if (comboPts) _p.push("COMBO ×" + versusLobbyState.bot.combo);
      sub = _p.join(" · ");
    }
    showStAction(versusLobbyState.bot, label, sub, cls, labelCol);
  }
  if (vsGarbageMode() && atk > 0) sendAttack(versusLobbyState.bot.idx, atk);
  if (vsGarbageMode()) {
    if (!rows.length) {
      if (insertActiveIdx(versusLobbyState.bot.idx)) {
        stCheckDanger(versusLobbyState.bot);
        return;
      }
    }
  }
  if (!versusLobbyState.bot.alive) return;
  stUpdateChips(versusLobbyState.bot);
  botPull();
  stCheckDanger(versusLobbyState.bot);
}
