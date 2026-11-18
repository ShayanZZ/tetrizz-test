// @ts-nocheck
import { storage } from "../core/storage";
import { log } from "../core/logger";
import { HID, MOBILE, clamp, configState } from "../core/config";
import { emitEvent } from "../core/events";
import { bindingsState } from "../input/bindings";
import { game } from "../game/state";
import { $, layoutState } from "../ui/layout";
import { renderState } from "../render/render";
import { mpTouchOwner } from "../ui/controls";
import { MODE_MOD, PLAYER_COLORS, VS_DEFAULTS } from "../ui/brand";
import { mpWatchHud } from "./rounds";
import { onlineSessionState } from "../net/online-session";

export const versusLobbyState = {
  vs: undefined,
  vsActive: false,
  vsMatchOver: false,
  vsRoundOver: false,
  vsRound: 1,
  vsTime: 0,
  vsHudT: 0,
  vsRoundT: null,
  _vsPendingRound: null,
  vsBannerUntil: 0,
  vsCountdownStarted: false,
  mpErrSlot: -1,
  mpErrT: null,
  bot: null,
  botArenaEl: null,
  botCv: null,
  botCtx: null,
  botWrapEl: null,
  botHoldCv: null,
  botNextCvs: [],
  botNextItems: [],
  botBannerEl: null,
  sharedStream: [],
  playerPtr: 0,
};

export const TARGET_OPTS = ["random", "attacker", "least", "most", "lowest"];

const TARGET_LABEL = {
  random: "RANDOM",
  attacker: "LAST ATTACKER",
  least: "LEAST GARBAGE",
  most: "MOST GARBAGE",
  lowest: "LOWEST STACK",
};

const GARBAGE_TRAVEL = 500;

export const MP = {
  n: 0,
  stations: [],
  qs: [],
  ptrs: [],
  lastHole: [-1, -1, -1, -1],
  wins: [0, 0, 0, 0],
  cum: [],
  padPrev: {},
};

export function giOf(st) {
  return st && st.gi !== undefined ? st.gi : st.slot;
}

export function giOfSlot(slot) {
  const st = MP.stations.find((s) => s.slot === slot);
  return st ? giOf(st) : slot;
}

export const vnum = (v, d) => {
  const n = parseFloat(v);
  return isNaN(n) ? d : n;
};

const trimN = (n, d) => parseFloat((+n).toFixed(d)).toString();

/** Text a bot's LEVEL or BOT PPS stepper shows; used when the lobby is drawn and when a value changes in place. */
function botStepText(p, key) {
  if (key === "pps") return p.autoPps ? "AUTO" : trimN(p.pps || versusLobbyState.vs.pps, 2);
  return String(p.diff || versusLobbyState.vs.diff);
}

/**
 * Sets one bot's LEVEL (`diff`) or BOT PPS (`pps`), saves it, and rewrites only that number on
 * screen. The buttons stay where they are, so a held + or - keeps repeating.
 */
export function setBotStepValue(slot, key, value) {
  const p = versusLobbyState.vs.players[slot];
  if (!p || p.type !== "bot" || (key !== "diff" && key !== "pps")) return;
  p[key] =
    key === "diff"
      ? clamp(Math.round(vnum(value, p.diff)), 1, 10)
      : clamp(Math.round(vnum(value, p.pps) * 100) / 100, 0.25, 10);
  saveVs();
  document
    .querySelectorAll(`[data-bot-step][data-slot="${slot}"][data-key="${key}"] .val`)
    .forEach((el) => {
      if (!el.querySelector("input")) el.textContent = botStepText(p, key);
    });
}

/** Moves a bot's LEVEL or BOT PPS by `delta` from its current value. */
export function adjustBotStep(slot, key, delta) {
  const p = versusLobbyState.vs.players[slot];
  if (!p || p.type !== "bot") return;
  setBotStepValue(slot, key, vnum(p[key], VS_DEFAULTS[key]) + delta);
}

export function vsGarbageMode() {
  return versusLobbyState.vs.submode === "battle" || versusLobbyState.vs.submode === "wide";
}

function mpDevs() {
  const list = [];
  if (!MOBILE.matches) {
    list.push({ id: "key", label: "KEYBOARD" });
    if (bindingsState.mouseEnabled) list.push({ id: "mouse", label: "MOUSE" });
  }
  padList().forEach((pi, k) => list.push({ id: "pad" + k, label: "GP" + (k + 1) }));
  return list;
}

function padList() {
  try {
    const gs = navigator.getGamepads ? navigator.getGamepads() : [];
    const out = [];
    for (let i = 0; i < gs.length; i++) if (gs[i]) out.push(i);
    return out;
  } catch (_) {
    return [];
  }
}

export function sanitizePlayers() {
  if (!Array.isArray(versusLobbyState.vs.players)) versusLobbyState.vs.players = [];
  while (versusLobbyState.vs.players.length < 4)
    versusLobbyState.vs.players.push({ type: "off", dev: "key" });
  versusLobbyState.vs.players = versusLobbyState.vs.players.slice(0, 4).map((p) => {
    p = p && typeof p === "object" ? p : {};
    let type = p.type;
    if (type !== "user" && type !== "bot" && type !== "off") type = "off";
    let dev = typeof p.dev === "string" ? p.dev : "key";
    let touch = p.touch,
      swipe = p.swipe;
    if (MOBILE.matches) {
      if (dev === "touch") {
        touch = touch !== false;
        swipe = swipe !== false;
        dev = "";
      } else if (dev === "swipe") {
        swipe = true;
        touch = touch === true;
        dev = "";
      }
      if (dev === "key" || dev === "mouse") dev = "";
    }
    if (touch === undefined) touch = true;
    if (swipe === undefined) swipe = true;
    if (type === "bot") {
      p.diff =
        typeof p.diff === "number" ? clamp(Math.round(p.diff), 1, 10) : versusLobbyState.vs.diff;
      p.autoPps = typeof p.autoPps === "boolean" ? p.autoPps : versusLobbyState.vs.autoPps;
      p.pps = typeof p.pps === "number" ? clamp(vnum(p.pps, 1), 0.25, 10) : versusLobbyState.vs.pps;
    }
    return {
      type: type,
      dev: dev,
      touch: !!touch,
      swipe: !!swipe,
      diff: p.diff || 0,
      autoPps: p.autoPps,
      pps: p.pps,
    };
  });
  if (versusLobbyState.vs.players[0].type === "off") versusLobbyState.vs.players[0].type = "user";
  if (versusLobbyState.vs.players[1].type === "off") versusLobbyState.vs.players[1].type = "bot";
  const opts = ["pad0", "pad1", "pad2", "pad3"];
  const taken = new Set();
  for (let i = 0; i < 4; i++) {
    const p = versusLobbyState.vs.players[i];
    if (p.type !== "user") continue;
    const allOpts = MOBILE.matches ? opts : ["key", "mouse", "pad0", "pad1", "pad2", "pad3"];
    if (allOpts.indexOf(p.dev) < 0 || taken.has(p.dev)) {
      let free = null;
      for (const d of allOpts) {
        if (!taken.has(d)) {
          free = d;
          break;
        }
      }
      p.dev = free || (MOBILE.matches ? "" : "key");
    }
    if (p.dev) taken.add(p.dev);
  }
}

/** Copies a room's rules into the lobby, leaving out what is not a rule (seed, players, password). */
export function copyRoomRules(rules) {
  for (const key in rules || {}) {
    if (key !== "seed" && key !== "players" && key !== "pwd" && key !== "pwdH")
      versusLobbyState.vs[key] = rules[key];
  }
}

export function clampVs() {
  versusLobbyState.vs.diff = clamp(Math.round(vnum(versusLobbyState.vs.diff, 5)), 1, 10);
  versusLobbyState.vs.pps = clamp(
    Math.round(vnum(versusLobbyState.vs.pps, 1) * 100) / 100,
    0.25,
    10,
  );
  versusLobbyState.vs.rounds = clamp(Math.round(vnum(versusLobbyState.vs.rounds, 3)), 1, 9);
  if (!TARGET_OPTS.includes(versusLobbyState.vs.target)) versusLobbyState.vs.target = "random";
  versusLobbyState.vs.grav = clamp(vnum(versusLobbyState.vs.grav, 0.02), 0.001, 2);
  versusLobbyState.vs.gravInc = clamp(vnum(versusLobbyState.vs.gravInc, 0), 0, 0.05);
  versusLobbyState.vs.gravMargin = clamp(vnum(versusLobbyState.vs.gravMargin, 60000), 0, 600000);
  versusLobbyState.vs.gMult = clamp(vnum(versusLobbyState.vs.gMult, 1), 0, 10);
  versusLobbyState.vs.gMargin = clamp(vnum(versusLobbyState.vs.gMargin, 10800), 0, 600000);
  versusLobbyState.vs.gInc = clamp(vnum(versusLobbyState.vs.gInc, 0), 0, 0.1);
  versusLobbyState.vs.autoPps = !!versusLobbyState.vs.autoPps;
  versusLobbyState.vs.reverse = !!versusLobbyState.vs.reverse;
  if (!MODE_MOD[versusLobbyState.vs.submode]) versusLobbyState.vs.submode = "battle";
  sanitizePlayers();
}

export function saveVs() {
  try {
    storage.set("tetris_vsbot", JSON.stringify(versusLobbyState.vs));
  } catch (_) {
    log.debug("versus/lobby.saveVs", _);
  }
}

export function loadVs() {
  try {
    const o = JSON.parse(storage.get("tetris_vsbot"));
    if (o && typeof o === "object")
      versusLobbyState.vs = { ...JSON.parse(JSON.stringify(VS_DEFAULTS)), ...o };
  } catch (e) {
    log.debug("loadVs", e);
  }
  clampVs();
}

export function vsAdjust(k, d) {
  if (k === "gravMargin" || k === "gMargin") d *= 1000;
  versusLobbyState.vs[k] = +(vnum(versusLobbyState.vs[k], 0) + d).toFixed(4);
  clampVs();
  saveVs();
  refreshVs();
}

function mpOwnerOf(dev) {
  return versusLobbyState.vs.players.findIndex((p) => p.type === "user" && p.dev === dev);
}

function mpFlashError(slot) {
  versusLobbyState.mpErrSlot = slot;
  refreshVs();
  clearTimeout(versusLobbyState.mpErrT);
  versusLobbyState.mpErrT = setTimeout(() => {
    versusLobbyState.mpErrSlot = -1;
    refreshVs();
  }, 2400);
}

export function mpSetType(slot, type) {
  const p = versusLobbyState.vs.players[slot];
  if (!p) return;
  if (slot < 2 && type === "off") return;
  if (type === p.type) return;
  if (type === "user") {
    if (MOBILE.matches) {
      p.type = "user";
      p.touch = p.touch !== false;
      p.swipe = p.swipe !== false;
      if (!p.dev) p.dev = "";
    } else {
      let dev = null;
      const ownedBy = versusLobbyState.vs.players.findIndex(
        (q, i) => i !== slot && q.type === "user" && q.dev === p.dev,
      );
      if (p.dev && ownedBy < 0 && mpDevs().some((d) => d.id === p.dev)) dev = p.dev;
      if (!dev) {
        const free = mpDevs().find((d) => mpOwnerOf(d.id) < 0);
        if (free) dev = free.id;
      }
      if (!dev) {
        mpFlashError(slot);
        return;
      }
      p.type = "user";
      p.dev = dev;
    }
  } else p.type = type;
  saveVs();
  refreshVs();
}

export function mpAssignDev(slot, dev) {
  const p = versusLobbyState.vs.players[slot];
  if (!p || p.type !== "user") return;
  if (p.dev === dev) return;
  const owner = mpOwnerOf(dev);
  if (owner >= 0 && owner !== slot) {
    versusLobbyState.vs.players[owner].dev = p.dev;
  }
  p.dev = dev;
  saveVs();
  refreshVs();
}

function renderLobby(container) {
  const maxSlots = MOBILE.matches ? 2 : 4;
  const first = !container._mpDone;
  container._mpDone = true;
  let html = "";
  for (let i = 0; i < maxSlots; i++) {
    const p = versusLobbyState.vs.players[i];
    const color = PLAYER_COLORS[i];
    const canOff = i >= 2;
    const types = (canOff ? ["user", "bot", "off"] : ["user", "bot"])
      .map(
        (t) =>
          `<button type="button" class="mp-type-btn${p.type === t ? " on" : ""}" data-slot="${i}" data-type="${t}">${t.toUpperCase()}</button>`,
      )
      .join("");
    let devs = "";
    if (p.type === "user") {
      let inner = "";
      if (MOBILE.matches) {
        inner += `<button type="button" class="mp-dev-btn${p.touch ? " on" : ""}" data-slot="${i}" data-toggle="touch">TOUCH</button><button type="button" class="mp-dev-btn${p.swipe ? " on" : ""}" data-slot="${i}" data-toggle="swipe">SWIPE</button>`;
      }
      const list = mpDevs();
      inner += list
        .map(
          (d) =>
            `<button type="button" class="mp-dev-btn${p.dev === d.id ? " on" : ""}" data-slot="${i}" data-dev="${d.id}">${d.label}</button>`,
        )
        .join("");
      devs = inner || '<span class="mp-dev-none">NO CONTROLLER AVAILABLE</span>';
    } else if (versusLobbyState.mpErrSlot === i)
      devs = '<span class="mp-dev-none mp-err">NO FREE CONTROLLER<br>REASSIGN ONE FIRST</span>';
    else
      devs = '<span class="mp-dev-none">' + (p.type === "bot" ? "CPU CONTROLLED" : "—") + "</span>";
    html += `<div class="mp-card${p.type === "off" ? " off" : ""}" style="--pc:${color}"><div class="mp-head"><span class="mp-tile">${p.type === "bot" ? "B" : "P"}${i + 1}</span><span class="mp-name">${p.type === "bot" ? "CPU" : p.type === "off" ? "EMPTY" : "HUMAN"}</span></div><div class="mp-types">${types}</div><div class="mp-devs">${devs}</div></div>`;
  }
  container.innerHTML = html;
  if (!first) {
    container.querySelectorAll(".mp-card").forEach((c) => {
      c.style.animation = "none";
    });
  }
}

export function mpLobbySummary() {
  const maxSlots = MOBILE.matches ? 2 : 4;
  let n = 0,
    u = 0;
  for (let i = 0; i < maxSlots; i++) {
    if (versusLobbyState.vs.players[i] && versusLobbyState.vs.players[i].type !== "off") {
      n++;
      if (versusLobbyState.vs.players[i].type === "user") u++;
    }
  }
  return n + "P · " + u + " HUMAN";
}

export function refreshVs() {
  refreshVsBody();
  emitEvent("refreshVs");
}

export function refreshVsBody() {
  document
    .querySelectorAll(".vsm-card")
    .forEach((c) => c.classList.toggle("active", c.dataset.vsm === versusLobbyState.vs.submode));
  document.querySelectorAll(".step[data-v]").forEach((st) => {
    const k = st.dataset.v;
    const val = st.querySelector(".val");
    if (!val || val.querySelector("input")) return;
    let txt;
    if (k === "diff" || k === "rounds") txt = versusLobbyState.vs[k];
    else if (k === "pps")
      txt = versusLobbyState.vs.autoPps ? "AUTO" : trimN(versusLobbyState.vs.pps, 2);
    else if (k === "grav") txt = trimN(versusLobbyState.vs.grav, 3);
    else if (k === "gravInc") txt = trimN(versusLobbyState.vs.gravInc, 4);
    else if (k === "gravMargin") txt = trimN(versusLobbyState.vs.gravMargin / 1000, 1);
    else if (k === "gMult") txt = trimN(versusLobbyState.vs.gMult, 2);
    else if (k === "gMargin") txt = trimN(versusLobbyState.vs.gMargin / 1000, 1);
    else if (k === "gInc") txt = trimN(versusLobbyState.vs.gInc, 3);
    val.textContent = txt;
  });
  document.querySelectorAll("[data-vtgl]").forEach((b) => {
    const k = b.dataset.vtgl;
    if (k === "target") {
      b.textContent = TARGET_LABEL[versusLobbyState.vs.target] || "RANDOM";
      b.classList.remove("off");
    } else {
      b.textContent = versusLobbyState.vs[k] ? "ON" : "OFF";
      b.classList.toggle("off", !versusLobbyState.vs[k]);
    }
  });
  const bots = versusLobbyState.vs.players.filter((p) => p.type === "bot");
  const _botBlocks = [...document.querySelectorAll("#botSettingsBlock")];
  const _botSteps = [...document.querySelectorAll("#botSettingsSteps")];
  let html = "";
  if (!bots.length) {
    _botBlocks.forEach((b) => {
      b.style.display = "none";
    });
  } else {
    _botBlocks.forEach((b) => {
      b.style.display = "";
    });
    bots.forEach((p) => {
      const slot = versusLobbyState.vs.players.indexOf(p);
      const pc = PLAYER_COLORS[slot] || "var(--mut)";
      html += `<div class="grp-title grp-title-cpu" style="font-size:12px;margin-top:12px;color:${pc}"><span style="display:inline-block;width:6px;height:6px;border-radius:2px;background:${pc};box-shadow:0 0 8px ${pc}"></span>CPU ${slot + 1}</div>`;
      html += `<div class="step" data-bot-step data-slot="${slot}" data-key="diff" data-min="1" data-max="10"><span class="lb">LEVEL</span><span class="ctl"><button data-d="-1">−</button><b class="val editable">${botStepText(p, "diff")}</b><button data-d="1">+</button><span class="u"></span><button class="rst" data-rst title="Reset">↺</button></span></div>`;
      html += `<div class="step" data-bot-step data-slot="${slot}" data-key="autoPps"><span class="lb">AUTO PPS</span><span class="ctl"><button class="tgl ${p.autoPps ? "" : "off"}">${p.autoPps ? "ON" : "OFF"}</button></span></div>`;
      const ppsDisabled = p.autoPps ? ' style="opacity:0.4;pointer-events:none"' : "";
      html += `<div class="step" data-bot-step data-slot="${slot}" data-key="pps" data-min="0.25" data-max="10" data-float ${ppsDisabled}><span class="lb">BOT PPS</span><span class="ctl"><button data-d="-0.25">−</button><b class="val editable">${botStepText(p, "pps")}</b><button data-d="0.25">+</button><span class="u"></span><button class="rst" data-rst title="Reset">↺</button></span></div>`;
    });
    _botSteps.forEach((s) => {
      s.innerHTML = html;
    });
  }
  document
    .querySelectorAll(".mp-rules")
    .forEach((el) => el.classList.toggle("closed", !vsGarbageMode()));
  document.querySelectorAll(".mp-lobby").forEach(renderLobby);
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) buildMpChips();
}

export function botInitDom() {
  versusLobbyState.botCv = $("botBoard");
  if (versusLobbyState.botCv) versusLobbyState.botCtx = versusLobbyState.botCv.getContext("2d");
  versusLobbyState.botWrapEl = $("botWrap");
  versusLobbyState.botArenaEl = $("botArena");
  versusLobbyState.botHoldCv = $("botHold");
  versusLobbyState.botNextCvs = [0, 1, 2, 3, 4].map((i) => $("botNext" + i));
  versusLobbyState.botNextItems = [
    ...document.querySelectorAll("#botArena .bot-col-right .nextItem"),
  ];
  versusLobbyState.botBannerEl = $("botBanner");
}

function mpArenaTemplate(k) {
  const p = "st" + k;
  return `<aside class="col bot-col-left">
<div class="panel"><h3>Hold</h3><canvas id="${p}Hold"></canvas></div>
<div class="spacer"></div>
<div class="actionWrap"><div class="action" id="${p}Action"></div></div>
<div class="chips"><div class="chip comboChipX" id="${p}Combo"></div><div class="chip b2bChipX" id="${p}B2b">B2B</div></div>
<div class="panel score-panel"><h3 id="${p}ScoreH3">Score</h3><div class="score" id="${p}Score">0</div><div class="duo" style="margin-top:calc(var(--u)*.36)"><div class="mini"><div class="v" id="${p}Level">1</div><div class="k" id="${p}LvlK">LEVEL</div></div><div class="mini"><div class="v" id="${p}Lines">0</div><div class="k" id="${p}LnK">LINES</div></div></div></div>
<div class="panel trio-panel"><div class="trio"><div><div class="v" id="${p}Time">0:00</div><div class="k">TIME</div></div><div><div class="v" id="${p}Pieces">0</div><div class="k">PIECES</div></div><div><div class="v" id="${p}Pps">0.00</div><div class="k">PPS</div></div></div></div>
</aside>
<section class="stage bot-stage"><div class="mpWrap" id="${p}Wrap"><canvas class="mpBoardCv" id="${p}Board"></canvas><div class="mpBanner" id="${p}Banner"></div><div class="vgauge vgs" id="${p}G"><i class="gv-t"></i><i class="gv-p"></i></div></div></section>
<aside class="col bot-col-right"><div class="panel next-panel"><h3>Next</h3><div class="nextList">${[0, 1, 2, 3, 4].map((j) => `<div class="nextItem"><canvas id="${p}Next${j}"></canvas></div>`).join("")}</div></div><div class="panel ping-panel"><h3>PING</h3><div class="ping-val" id="st${k}Ping">--</div></div><div class="panel bot-level" id="${p}LvlP" style="display:none"><h3>CPU LEVEL</h3><div class="blv-v" id="${p}LvlV">1</div></div></aside>`;
}

function mpCreateArena(k) {
  const old = $("arena" + k);
  if (old) old.remove();
  const el = document.createElement("div");
  el.className = "arenaBot arenaExtra";
  el.id = "arena" + k;
  el.innerHTML = mpArenaTemplate(k);
  document.body.appendChild(el);
  return el;
}

function bindStationDom(st, i) {
  if (i === 0) {
    st.arenaEl = layoutState.mainEl;
    st.wrapEl = layoutState.wrap;
    st.cvEl = layoutState.bcv;
    st.ctx = layoutState.g;
    st.bannerEl = layoutState.bannerEl;
    st.gaugeEl = $("gP");
    st.holdCv = layoutState.holdCv;
    st.nextCvs = layoutState.nextCvs;
    st.nextItems = layoutState.nextItems;
    st.actionEl = layoutState.actionLine;
    st.comboEl = layoutState.comboChip;
    st.b2bEl = layoutState.b2bChip;
    st.scoreH3El = layoutState.pScoreH3;
    st.scoreEl = layoutState.elScore;
    st.levelEl = layoutState.elLevel;
    st.lvlKEl = layoutState.lvlK;
    st.linesEl = layoutState.elLines;
    st.lnKEl = layoutState.lnK;
    st.timeEl = layoutState.elTime;
    st.piecesEl = layoutState.elPieces;
    st.ppsEl = layoutState.elPps;
    st.lvlPanelEl = $("st0LvlP");
    st.lvlValEl = $("st0LvlV");
  } else if (i === 1) {
    st.arenaEl = versusLobbyState.botArenaEl;
    st.wrapEl = versusLobbyState.botWrapEl;
    st.cvEl = versusLobbyState.botCv;
    st.ctx = versusLobbyState.botCtx;
    st.bannerEl = versusLobbyState.botBannerEl;
    st.gaugeEl = $("gB");
    st.holdCv = versusLobbyState.botHoldCv;
    st.nextCvs = versusLobbyState.botNextCvs;
    st.nextItems = versusLobbyState.botNextItems;
    st.actionEl = $("botActionLine");
    st.comboEl = renderState.botComboChip;
    st.b2bEl = renderState.botB2bChip;
    st.scoreH3El = $("botScoreH3");
    st.scoreEl = $("botScore");
    st.levelEl = $("botLevel");
    st.lvlKEl = $("bLvlK");
    st.linesEl = $("botLines");
    st.lnKEl = $("bLnK");
    st.timeEl = $("botTime");
    st.piecesEl = $("botPieces");
    st.ppsEl = $("botPps");
    st.lvlPanelEl = $("st1LvlP");
    st.lvlValEl = $("st1LvlV");
  } else {
    const p = "st" + i;
    st.arenaEl = $("arena" + i);
    st.wrapEl = $(p + "Wrap");
    st.cvEl = $(p + "Board");
    st.ctx = st.cvEl.getContext("2d");
    st.bannerEl = $(p + "Banner");
    st.gaugeEl = $(p + "G");
    st.holdCv = $(p + "Hold");
    st.nextCvs = [0, 1, 2, 3, 4].map((j) => $(p + "Next" + j));
    st.nextItems = [...st.arenaEl.querySelectorAll(".nextItem")];
    st.actionEl = $(p + "Action");
    st.comboEl = $(p + "Combo");
    st.b2bEl = $(p + "B2b");
    st.scoreH3El = $(p + "ScoreH3");
    st.scoreEl = $(p + "Score");
    st.levelEl = $(p + "Level");
    st.lvlKEl = $(p + "LvlK");
    st.linesEl = $(p + "Lines");
    st.lnKEl = $(p + "LnK");
    st.timeEl = $(p + "Time");
    st.piecesEl = $(p + "Pieces");
    st.ppsEl = $(p + "Pps");
    st.lvlPanelEl = $(p + "LvlP");
    st.lvlValEl = $(p + "LvlV");
  }
  if (st.scoreH3El) st.scoreH3El.style.setProperty("--acchi", st.color);
  const _hp = st.holdCv ? st.holdCv.closest(".panel") : null;
  if (_hp) {
    const h = _hp.querySelector("h3");
    if (h) h.style.setProperty("--acchi", st.color);
  }
  const _np = st.nextCvs && st.nextCvs[0] ? st.nextCvs[0].closest(".panel") : null;
  if (_np) {
    const h = _np.querySelector("h3");
    if (h) h.style.setProperty("--acchi", st.color);
  }
  const _lp = st.lvlPanelEl ? st.lvlPanelEl.querySelector("h3") : null;
  if (_lp) _lp.style.setProperty("--acchi", st.color);
}

export function mpBuildStations(act) {
  ["arena2", "arena3"].forEach((id) => {
    const e = $(id);
    if (e) e.remove();
  });
  MP.stations = [];
  MP.qs = [];
  MP.ptrs = [];
  MP.n = act.length;
  for (let i = 0; i < act.length; i++) {
    if (i >= 2) mpCreateArena(i);
    const slot = act[i].i,
      cfg = act[i].p;
    const st = {
      idx: i,
      slot: slot,
      gi: slot,
      isBot: cfg.type === "bot",
      dev: cfg.type === "user" ? cfg.dev || "key" : "key",
      color: PLAYER_COLORS[slot],
      label: (cfg.type === "bot" ? "B" : "P") + (slot + 1),
      board: [],
      queue: [],
      hold: null,
      holdUsed: false,
      piece: null,
      score: 0,
      lines: 0,
      level: 1,
      combo: -1,
      maxCombo: 0,
      b2b: 0,
      pieces: 0,
      sent: 0,
      gravT: 0,
      gravMs: 833,
      plan: null,
      topActions: [],
      execIdx: 0,
      topAcc: 0,
      deadline: 0,
      pieceStart: 0,
      budgetMs: 0,
      paceCarry: 0,
      spinDone: false,
      spinAt: 0,
      bottomFail: 0,
      stallDir: 1,
      skill: null,
      thinkGen: null,
      spec: null,
      alive: true,
      paused: false,
      deathAt: 0,
      timeMs: 0,
      particles: [],
      fx: { x: 0, y: 0, rot: 0, vx: 0, vy: 0, vr: 0, tx: 0, lx: 0, lvx: 0 },
      in: { left: false, right: false, down: false, dir: 0, dasT: 0, arrT: 0 },
      lastSpin: null,
      cellPx: 16,
      actionT: null,
      _ft: "",
      chipEl: null,
      chipEl2: null,
      softMs: 0,
      sdf: Infinity,
      lastAttacker: -1,
    };
    bindStationDom(st, i);
    if (st.arenaEl) st.arenaEl.style.setProperty("--acchi", st.color);
    MP.stations.push(st);
    MP.qs.push([]);
    MP.ptrs.push(0);
  }
}

export function buildMpChips() {
  const el = $("mpChips"),
    el2 = $("mpChips2");
  if (!el) return;
  const order = MP.stations.slice().sort((a, b) => giOf(a) - giOf(b));
  const mk = (prefix) =>
    order
      .map(
        (st, i) =>
          `<span class="mpc" id="${prefix}${giOf(st)}" style="--pc:${st.color};animation-delay:${(i * 0.06).toFixed(2)}s"><b>${st.label}</b><span class="mpc-v">0</span></span>`,
      )
      .join("");
  el.innerHTML = mk("mpcg");
  if (el2) el2.innerHTML = mk("mpcg2_");
  order.forEach((st) => {
    st.chipEl = $("mpcg" + giOf(st));
    st.chipEl2 = el2 ? $("mpcg2_" + giOf(st)) : null;
  });
}

export function mpClearInputs() {
  for (const st of MP.stations) {
    st.in.left = st.in.right = st.in.down = false;
    st.in.dir = 0;
    st.in.dasT = st.in.arrT = 0;
    st.fx.tx = 0;
  }
}

export function mpSplitMob() {
  if (!MOBILE.matches || !versusLobbyState.vsActive || !MP.stations.length) return false;
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator)
    return MP.stations.length === 2;
  return (
    MP.stations.filter((s) => {
      const c = versusLobbyState.vs.players[s.slot];
      return c && c.type === "user";
    }).length >= 2
  );
}

export function mpComputeU() {
  if (
    versusLobbyState.vsActive === undefined ||
    !versusLobbyState.vsActive ||
    !MP.stations.length
  ) {
    return;
  }
  const split = mpSplitMob();
  document.body.classList.toggle("splitMob", split);
  if (!split) document.body.classList.remove("revsplit");
  const humansMp = MP.stations.filter((s) => {
    const c = versusLobbyState.vs.players[s.slot];
    return c && c.type === "user";
  }).length;
  const _specView = onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator;
  const mobOnMulti = MOBILE.matches && MP.n >= 2 && (humansMp === 1 || (_specView && MP.n >= 3));
  document.body.classList.toggle("mobOnMulti", mobOnMulti);
  const touchEl = $("touch"),
    touch2El = $("touch2");
  const hudEl = $("vsHud"),
    hud2El = $("vsHud2");
  const owner = mpTouchOwner();
  const hdrH = layoutState.headerEl ? layoutState.headerEl.getBoundingClientRect().height : 60;
  const centerHud = (el) => {
    if (!el) return;
    el.style.left = "0";
    el.style.right = "0";
    el.style.marginLeft = "auto";
    el.style.marginRight = "auto";
    el.style.width = "max-content";
    el.style.maxWidth = "96vw";
  };
  const sideHud = (el) => {
    if (!el) return;
    el.style.marginLeft = "0";
    el.style.marginRight = "0";
    el.style.width = "";
  };
  if (!mobOnMulti) {
    for (let i = 1; i < MP.stations.length; i++) {
      const ae = MP.stations[i] && MP.stations[i].arenaEl;
      if (ae) {
        ae.style.position = "";
        ae.style.left = "";
        ae.style.top = "";
        ae.style.right = "";
        ae.style.bottom = "";
        ae.style.width = "";
        ae.style.height = "";
        ae.style.zoom = "";
        ae.style.removeProperty("--bu");
        ae.style.removeProperty("--boardW");
        ae.style.removeProperty("--boardH");
        ae.style.removeProperty("--side");
        ae.style.removeProperty("--gap");
        ae.style.removeProperty("--u");
      }
    }
    layoutState.mainEl.style.paddingTop = "";
    layoutState.mainEl.style.height = "";
    document.body.style.removeProperty("--mobTop");
    document.body.style.removeProperty("--sideU");
    document.body.style.removeProperty("--side");
    document.body.classList.remove("mobOppNext");
    document.body.classList.remove("mobHudLeft");
  }
  let u;
  if (!MOBILE.matches) {
    const onlineMp =
      onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame && MP.n > 2;
    const n = onlineMp ? 2 : Math.max(1, MP.n);
    const units = 8 + configState.COLS + 3;
    if (onlineMp) {
      const spare = hdrH + 34;
      u = Math.min(
        40,
        (innerWidth - 24) / n / units,
        (innerHeight - 2 * hdrH - 18) / (configState.VIS + 4.2),
      );
      const mainH = hdrH + 24 + (configState.VIS + 3) * u;
      const avail = innerHeight - spare;
      const zStack = clamp((avail - 1.2 * u) / (2 * mainH), 0.45, 1.0);
      const zSingle = clamp((avail - 1.2 * u) / mainH, 0.45, 1.0);
      document.body.style.setProperty("--ozS", zStack.toFixed(3));
      document.body.style.setProperty("--oz1", zSingle.toFixed(3));
    } else {
      u = Math.min(
        30,
        (innerHeight - 36) / (configState.VIS + 4.3),
        (innerWidth - 64) / (n * units + (n - 1) * 2.2),
      );
      document.body.style.setProperty("--ozS", ".62");
      document.body.style.setProperty("--oz1", ".62");
    }
    layoutState.mainEl.style.paddingBottom = "";
    if (versusLobbyState.botArenaEl) {
      versusLobbyState.botArenaEl.style.paddingTop = "";
      versusLobbyState.botArenaEl.style.paddingBottom = "";
    }
    if (touchEl) touchEl.classList.remove("touchTop");
    if (touch2El) touch2El.style.display = "none";
    if (hudEl) {
      hudEl.style.left = "";
      hudEl.style.right = "";
      hudEl.style.marginLeft = "";
      hudEl.style.marginRight = "";
      hudEl.style.width = "";
      hudEl.style.maxWidth = "";
      hudEl.style.top = "";
      hudEl.style.bottom = "";
      hudEl.style.transform = "";
      mpWatchHud(u);
    }
    if (hud2El) hud2El.style.display = "none";
  } else if (mobOnMulti) {
    const btnH = parseFloat(getComputedStyle(document.body).getPropertyValue("--btnH")) || 64;
    const active = game.state === "playing" || game.state === "countdown";
    const showTouch = !!(owner && active);
    const barH = owner ? btnH * 2 + 26 : 0;
    const availW = innerWidth;
    const nOpp = MP.n - 1;
    const showOppNext = nOpp <= 2;
    document.body.classList.toggle("mobOppNext", showOppNext);
    const hudLeft = nOpp === 1;
    document.body.classList.toggle("mobHudLeft", hudLeft);
    const hudStrip = hudLeft ? 34 : 56;
    const oppTop = hdrH + hudStrip + 4;
    const rowFrac = nOpp === 1 ? 0.26 : nOpp === 2 ? 0.27 : 0.25;
    const oppRowH = Math.round((innerHeight - oppTop) * rowFrac);
    const oppBottom = oppTop + oppRowH;
    const sideU = 5;
    document.body.style.setProperty("--sideU", sideU);
    document.body.style.setProperty("--side", "calc(var(--u)*" + sideU + ")");
    const oppCellPre = clamp(
      Math.min(
        (availW - 6 * (nOpp + 1)) /
          (nOpp * (configState.COLS + (showOppNext ? 8 : 4) + (showOppNext ? 1.4 : 0.7))),
        (oppRowH - 8) / configState.VIS,
      ),
      5,
      40,
    );
    const oppLift = nOpp === 1 ? 1 * oppCellPre : 0;
    const availForUser = innerHeight - (oppBottom - oppLift) - barH - 4;
    u = Math.min(
      32,
      (availW - 12) / (configState.COLS + 2 * sideU + 1.4),
      (availForUser - 14) / (configState.VIS + 3),
    );
    const userTop = oppBottom - oppLift + 3 * u + 12;
    document.body.style.setProperty("--mobTop", userTop + "px");
    layoutState.mainEl.style.paddingTop = "";
    layoutState.mainEl.style.height = "";
    layoutState.mainEl.style.alignContent = "";
    if (versusLobbyState.botArenaEl) {
      versusLobbyState.botArenaEl.style.paddingTop = "";
      versusLobbyState.botArenaEl.style.paddingBottom = "";
      versusLobbyState.botArenaEl.style.alignContent = "";
    }
    layoutState.mainEl.style.paddingBottom = (barH ? barH + 4 : 4) + "px";
    if (touchEl) {
      touchEl.classList.remove("touchTop");
      touchEl.style.display = showTouch ? "grid" : "none";
    }
    if (touch2El) touch2El.style.display = "none";

    const OPP_SIDE_U = 4.0;

    const OPP_GAUGE_U = 0.7;
    const oppGapBetween = 6;
    const totalGapW = oppGapBetween * (nOpp + 1);
    const sideUnits = showOppNext ? 2 * OPP_SIDE_U : OPP_SIDE_U;
    const gapUnits = showOppNext ? 2 * OPP_GAUGE_U : OPP_GAUGE_U;
    const oppCellW = (availW - totalGapW) / (nOpp * (configState.COLS + sideUnits + gapUnits));
    const oppCellH = (oppRowH - 8) / configState.VIS;
    const oppCell = clamp(Math.min(oppCellW, oppCellH, u * (nOpp === 1 ? 0.6 : 0.7)), 5, 40);
    const bwN = oppCell * configState.COLS;
    const oppSideW = oppCell * OPP_SIDE_U;
    const oppGapIn = oppCell * OPP_GAUGE_U;
    const perOppW = bwN + oppCell * sideUnits + oppCell * gapUnits;
    const g = clamp((availW - nOpp * perOppW) / (nOpp + 1), 4, 28);
    let x0 = Math.max(4, (availW - nOpp * perOppW - (nOpp - 1) * g) / 2);
    for (let i = 1; i < MP.n; i++) {
      const st = MP.stations[i];
      if (!st || !st.arenaEl) continue;
      const ae = st.arenaEl;
      ae.style.position = "fixed";
      ae.style.top = oppTop - oppLift + "px";
      ae.style.left = x0 + "px";
      ae.style.right = "auto";
      ae.style.bottom = "auto";
      ae.style.width = perOppW + "px";
      ae.style.height = "auto";
      ae.style.zoom = "";
      ae.style.setProperty("--u", oppCell + "px");
      ae.style.setProperty("--bu", oppCell + "px");
      ae.style.setProperty("--side", oppSideW + "px");
      ae.style.setProperty("--boardW", bwN + "px");
      ae.style.setProperty("--boardH", oppCell * configState.VIS + "px");
      ae.style.setProperty("--gap", oppGapIn + "px");
      x0 += perOppW + g;
    }
    if (hudEl) {
      if (hudLeft) {
        hudEl.style.left = "6px";
        hudEl.style.right = "auto";
        hudEl.style.marginLeft = "0";
        hudEl.style.marginRight = "0";
        hudEl.style.width = "";
        hudEl.style.maxWidth = "42vw";
        hudEl.style.top = hdrH + 2 + "px";
        hudEl.style.bottom = "auto";
        hudEl.style.transform = "none";
      } else {
        centerHud(hudEl);
        hudEl.style.top = hdrH + 1 + "px";
        hudEl.style.bottom = "auto";
        hudEl.style.transform = "none";
        hudEl.style.maxWidth = "96vw";
      }
    }
    if (hud2El) hud2El.style.display = "none";
  } else if (!split) {
    document.body.style.removeProperty("--btnH");
    const btnH = parseFloat(getComputedStyle(document.body).getPropertyValue("--btnH")) || 64;
    const activeB = !!((game.state === "playing" || game.state === "countdown") && owner);
    const barH = owner ? btnH * 2 + 30 : 0;
    const sideU = versusLobbyState.vs.submode === "wide" ? 4 : 3.2;
    u = Math.min(
      37,
      (innerHeight - 18 - barH) / (configState.VIS + 4.3),
      (innerWidth - 16) / (configState.COLS + 2 * sideU + 1.4),
    );
    layoutState.mainEl.style.paddingBottom = "";
    if (versusLobbyState.botArenaEl) {
      versusLobbyState.botArenaEl.style.paddingTop = "";
      versusLobbyState.botArenaEl.style.paddingBottom = "";
    }
    if (touchEl) {
      touchEl.classList.remove("touchTop");
      touchEl.style.display = activeB ? "grid" : "none";
    }
    if (touch2El) touch2El.style.display = "none";
    if (hudEl) {
      sideHud(hudEl);
      hudEl.style.left = "auto";
      hudEl.style.right = "6px";
      hudEl.style.maxWidth = "calc(100vw - var(--side) - 16px)";
      hudEl.style.transform = "none";
      hudEl.style.top = hdrH + 6 + "px";
      hudEl.style.bottom = "auto";
    }
    if (hud2El) hud2El.style.display = "none";
  } else {
    const rev =
      !!versusLobbyState.vs.reverse &&
      (onlineSessionState.isSpectator === undefined || !onlineSessionState.isSpectator);
    const btnH = parseFloat(getComputedStyle(document.body).getPropertyValue("--btnH")) || 64;
    const st0 = MP.stations[0],
      st1 = MP.stations[1];
    const c0 = versusLobbyState.vs.players[st0 ? st0.slot : 0] || {},
      c1 = versusLobbyState.vs.players[st1 ? st1.slot : 1] || {};
    const active = game.state === "playing" || game.state === "countdown";
    const b0 = !!(c0.type === "user" && c0.touch),
      b1 = !!(c1.type === "user" && c1.touch);
    const barFull = 2 * btnH + 26;
    const bar0 = b0 ? barFull : 0,
      bar1 = b1 ? barFull : 0;
    const GAP = 6;
    const half = (innerHeight - hdrH) / 2;
    u = Math.min(
      40,
      (half - bar0 - 2 * GAP - 6) / (configState.VIS + 3),
      (half - bar1 - 2 * GAP - 6) / (configState.VIS + 3),
      (innerWidth - 16) / (configState.COLS + 10 + 1.4),
    );
    const spw = 3 * u + 6;
    let topH = hdrH + half;
    let botH = half;
    if (touchEl) touchEl.style.display = b0 && active ? "grid" : "none";
    if (touch2El) touch2El.style.display = b1 && active ? "grid" : "none";
    layoutState.mainEl.style.height = botH + "px";
    layoutState.mainEl.style.alignContent = "start";
    if (versusLobbyState.botArenaEl) {
      versusLobbyState.botArenaEl.style.height = topH + "px";
      versusLobbyState.botArenaEl.style.alignContent = "start";
    }
    if (rev) {
      layoutState.mainEl.style.paddingTop = spw + GAP + "px";
      layoutState.mainEl.style.paddingBottom = bar0 + GAP + "px";
      if (versusLobbyState.botArenaEl) {
        versusLobbyState.botArenaEl.style.paddingTop = spw + GAP + "px";
        versusLobbyState.botArenaEl.style.paddingBottom = hdrH + bar1 + GAP + "px";
      }
    } else {
      layoutState.mainEl.style.paddingTop = spw + GAP + "px";
      layoutState.mainEl.style.paddingBottom = bar0 + GAP + "px";
      if (versusLobbyState.botArenaEl) {
        versusLobbyState.botArenaEl.style.paddingTop = hdrH + spw + GAP + "px";
        versusLobbyState.botArenaEl.style.paddingBottom = bar1 + GAP + "px";
      }
    }
    if (touch2El) {
      touch2El.style.top = rev ? hdrH + "px" : topH - barFull + "px";
    }
    if (!rev) {
      const sh = Math.min(hdrH, spw + GAP);
      topH += sh;
      botH -= sh;
      layoutState.mainEl.style.height = botH + "px";
      layoutState.mainEl.style.paddingTop = Math.max(0, spw + GAP - sh) + "px";
      if (versusLobbyState.botArenaEl) {
        versusLobbyState.botArenaEl.style.height = topH + "px";
        versusLobbyState.botArenaEl.style.paddingTop =
          hdrH + (bar1 ? (spw + GAP + sh + GAP) / 2 : spw + GAP + sh) + "px";
      }
      if (touch2El) touch2El.style.top = topH - barFull + "px";
      document.body.style.setProperty("--u", u.toFixed(2) + "px");
      const stT = versusLobbyState.botArenaEl
          ? versusLobbyState.botArenaEl.querySelector(".stage")
          : null,
        stB = layoutState.mainEl.querySelector(".stage");
      if (stT && stB) {
        const rT = stT.getBoundingClientRect(),
          rB = stB.getBoundingClientRect();
        const t2 = touch2El ? touch2El.getBoundingClientRect() : null,
          t0 = touchEl ? touchEl.getBoundingClientRect() : null;
        const freeT = (t2 && t2.height > 4 ? t2.top : topH - barFull) - rT.bottom;
        const freeB = (t0 && t0.height > 4 ? t0.top : innerHeight) - rB.bottom;
        const uW = (innerWidth - 16) / (configState.COLS + 10 + 1.4);
        const du = Math.max(
          0,
          Math.min(2, uW - u, (Math.min(freeT, freeB) - 8) / (configState.VIS + HID)),
        );
        if (du > 0.1) {
          u += du;
          document.body.style.setProperty("--u", u.toFixed(2) + "px");
          layoutState.mainEl.style.paddingTop =
            (parseFloat(layoutState.mainEl.style.paddingTop) || 0) + HID * du + "px";
          if (versusLobbyState.botArenaEl)
            versusLobbyState.botArenaEl.style.paddingTop =
              (parseFloat(versusLobbyState.botArenaEl.style.paddingTop) || 0) + HID * du + "px";
        }
      }
    }
    if (rev) {
      document.body.style.setProperty("--u", u.toFixed(2) + "px");
      const stT = versusLobbyState.botArenaEl
          ? versusLobbyState.botArenaEl.querySelector(".stage")
          : null,
        stB = layoutState.mainEl.querySelector(".stage");
      if (stT && stB) {
        const rT = stT.getBoundingClientRect(),
          rB = stB.getBoundingClientRect();
        const t2 = touch2El ? touch2El.getBoundingClientRect() : null,
          t0 = touchEl ? touchEl.getBoundingClientRect() : null;
        const freeT = rT.top - (t2 && t2.height > 4 ? t2.bottom : hdrH);
        const freeB = (t0 && t0.height > 4 ? t0.top : innerHeight) - rB.bottom;
        const uW = (innerWidth - 16) / (configState.COLS + 10 + 1.4);
        const du = Math.max(
          0,
          Math.min(2, uW - u, (Math.min(freeT, freeB) - 8) / (configState.VIS + HID)),
        );
        if (du > 0.1) {
          u += du;
          document.body.style.setProperty("--u", u.toFixed(2) + "px");
          layoutState.mainEl.style.paddingTop =
            (parseFloat(layoutState.mainEl.style.paddingTop) || 0) + HID * du + "px";
          if (versusLobbyState.botArenaEl)
            versusLobbyState.botArenaEl.style.paddingTop =
              (parseFloat(versusLobbyState.botArenaEl.style.paddingTop) || 0) + HID * du + "px";
        }
      }
    }
    document.body.classList.toggle("revsplit", rev);
    if (hud2El) hud2El.style.display = rev ? "flex" : "none";
    if (rev) {
      if (hudEl) {
        sideHud(hudEl);
        hudEl.style.left = "6px";
        hudEl.style.right = "auto";
        hudEl.style.maxWidth = "46vw";
        hudEl.style.bottom = "auto";
        hudEl.style.top = "";
        hudEl.style.transform = "";
      }
      if (hud2El) {
        sideHud(hud2El);
        hud2El.style.left = "auto";
        hud2El.style.right = "6px";
        hud2El.style.maxWidth = "46vw";
        hud2El.style.bottom = "auto";
        hud2El.style.top = "";
        hud2El.style.transform = "";
      }
    } else {
      if (hudEl) {
        sideHud(hudEl);
        hudEl.style.left = "6px";
        hudEl.style.right = "auto";
        hudEl.style.maxWidth = "70vw";
        hudEl.style.transform = "none";
        hudEl.style.top = hdrH + 2 + "px";
        hudEl.style.bottom = "auto";
      }
    }
  }
  if (!isFinite(u) || isNaN(u)) u = 16;
  u = Math.max(4, u);
  document.body.style.setProperty("--u", u.toFixed(2) + "px");
  if (
    split &&
    MOBILE.matches &&
    versusLobbyState.vs.reverse &&
    hudEl &&
    hud2El &&
    versusLobbyState.botArenaEl
  ) {
    const stT = versusLobbyState.botArenaEl.querySelector(".stage"),
      stB = layoutState.mainEl.querySelector(".stage");
    if (stT && stB) {
      const rT = stT.getBoundingClientRect(),
        rB = stB.getBoundingClientRect();
      if (rT.height > 4 && rB.height > 4) {
        const gc = (rT.bottom + rB.top) / 2;
        hudEl.style.top = gc + "px";
        hudEl.style.transform = "translateY(-50%)";
        hud2El.style.top = gc + "px";
        hud2El.style.transform = "translateY(-50%) rotate(180deg)";
      }
    }
  }
}

export function qCountIdx(i, states) {
  let n = 0;
  const q = MP.qs[i] || [];
  for (const p of q) if (states.indexOf(p.state) >= 0) n += p.holes.length;
  return n;
}

export function tickGarbage() {
  if (!versusLobbyState.vsActive) return;
  if (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) return;
  for (let i = 0; i < MP.n; i++) {
    for (const p of MP.qs[i]) {
      if (p.state === "travel" && versusLobbyState.vsTime - p.t0 >= GARBAGE_TRAVEL)
        p.state = "pending";
    }
  }
}

export function onSpawnIdx(i) {
  const q = MP.qs[i];
  if (!q) return;
  for (const p of q) if (p.state === "pending") p.state = "active";
}

export function onSpawn(s) {
  if (versusLobbyState.vsActive) onSpawnIdx(typeof s === "number" ? s : s === "P" ? 0 : 1);
}
