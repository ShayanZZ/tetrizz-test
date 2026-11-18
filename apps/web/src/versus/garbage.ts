// @ts-nocheck
import { LINE_WORD, PIECES, fillBagStream } from "@tetrizz/core";
import { configState } from "../core/config";
import { isIntercepted } from "../core/events";
import { game } from "../game/state";
import { SFX, emptyRow } from "../engine/engine";
import { rndHole } from "../ui/screens";
import { MP, qCountIdx, versusLobbyState, vsGarbageMode } from "./lobby";
import { gameRandom } from "../core/random";
import { stFxKick } from "./stations";
import { onlineSessionState } from "../net/online-session";

export function consumeIdx(i) {
  ensureStream(MP.ptrs[i] + 1);
  const t = versusLobbyState.sharedStream[MP.ptrs[i]];
  MP.ptrs[i]++;
  return t;
}

export function consume(side) {
  if (versusLobbyState.vsActive)
    return consumeIdx(typeof side === "number" ? side : side === "P" ? 0 : 1);
  ensureStream(versusLobbyState.playerPtr + 1);
  const t = versusLobbyState.sharedStream[versusLobbyState.playerPtr];
  versusLobbyState.playerPtr++;
  return t;
}

function trimSharedStream() {
  if (versusLobbyState.sharedStream.length <= 200) return;
  let minPtr = versusLobbyState.playerPtr;
  if (MP.ptrs)
    for (let i = 0; i < MP.ptrs.length; i++) {
      if (MP.ptrs[i] < minPtr) minPtr = MP.ptrs[i];
    }
  if (minPtr > 100) {
    const cut = minPtr - 50;
    versusLobbyState.sharedStream.splice(0, cut);
    versusLobbyState.playerPtr -= cut;
    if (MP.ptrs) MP.ptrs = MP.ptrs.map((p) => p - cut);
  }
}

export function refreshQueuesAll() {
  if (!versusLobbyState.vsActive) return;
  let m = 0;
  for (let i = 0; i < MP.n; i++) m = Math.max(m, MP.ptrs[i]);
  ensureStream(m + 6);
  for (let i = 0; i < MP.n; i++) {
    if (MP.stations[i])
      MP.stations[i].queue = versusLobbyState.sharedStream.slice(MP.ptrs[i], MP.ptrs[i] + 5);
  }
  game.queue = versusLobbyState.sharedStream.slice(MP.ptrs[0] || 0, (MP.ptrs[0] || 0) + 5);
  trimSharedStream();
}

export function refreshQueues() {
  if (versusLobbyState.vsActive) {
    refreshQueuesAll();
    return;
  }
  ensureStream(versusLobbyState.playerPtr + 6);
  game.queue = versusLobbyState.sharedStream.slice(
    versusLobbyState.playerPtr,
    versusLobbyState.playerPtr + 5,
  );
  trimSharedStream();
}

export function sendAttack(from, A) {
  if (isIntercepted("sendAttack", from, A)) return;
  sendAttackBody(from, A);
}

function sendAttackBody(from, A) {
  if (!versusLobbyState.vsActive || !vsGarbageMode() || A <= 0) return;
  const q = MP.qs[from] || [];
  const hadPending = q.reduce((s, c) => s + c.holes.length, 0);
  let left = A;
  for (const ch of q) {
    if (left <= 0) break;
    const take = Math.min(ch.holes.length, left);
    ch.holes.splice(0, take);
    left -= take;
  }
  MP.qs[from] = q.filter((ch) => ch.holes.length > 0);
  const cancelled = hadPending - MP.qs[from].reduce((s, c) => s + c.holes.length, 0);
  if (cancelled > 0) {
    const st = MP.stations[from];
    if (st) {
      if (st.gaugeEl) {
        st.gaugeEl.classList.remove("cancel-flash");
        void st.gaugeEl.offsetWidth;
        st.gaugeEl.classList.add("cancel-flash");
      }
    }
  }
  const pushed = left;
  if (pushed > 0) {
    const cands = MP.stations.filter((s) => s.idx !== from && s.alive && !s.left);
    if (cands.length) {
      let t;
      const strat =
        versusLobbyState.vs !== undefined && versusLobbyState.vs.target
          ? versusLobbyState.vs.target
          : "random";
      if (strat === "attacker") {
        const src = MP.stations[from];
        t =
          cands.find((s) => s.idx === (src && src.lastAttacker)) ||
          cands[(gameRandom() * cands.length) | 0];
      } else if (strat === "least") {
        t = cands.reduce((a, b) =>
          qCountIdx(a.idx, ["travel", "pending", "active"]) <=
          qCountIdx(b.idx, ["travel", "pending", "active"])
            ? a
            : b,
        );
      } else if (strat === "most") {
        t = cands.reduce((a, b) =>
          qCountIdx(a.idx, ["travel", "pending", "active"]) >=
          qCountIdx(b.idx, ["travel", "pending", "active"])
            ? a
            : b,
        );
      } else if (strat === "lowest") {
        t = cands.reduce((a, b) => {
          const ha = a.board.reduce((s, r) => s + (r.some((v) => v) ? 1 : 0), 0);
          const hb = b.board.reduce((s, r) => s + (r.some((v) => v) ? 1 : 0), 0);
          return ha <= hb ? a : b;
        });
      } else {
        t = cands[(gameRandom() * cands.length) | 0];
      }
      t.lastAttacker = from;
      let pv = MP.lastHole[t.idx];
      const holes = [];
      for (let k = 0; k < pushed; k++) {
        const same = pv < 0 ? false : k === 0 ? gameRandom() < 0.1 : gameRandom() < 0.8;
        const h = same ? pv : rndHole(pv);
        holes.push(h);
        pv = h;
      }
      MP.lastHole[t.idx] = pv;
      MP.qs[t.idx].push({ holes: holes, state: "travel", t0: versusLobbyState.vsTime });
      SFX.send();
    }
  }
  if (MP.stations[from]) MP.stations[from].sent += pushed;
  setMpGauges();
}

export function stTopOut(st) {
  if (!st || !st.alive) return;
  st.alive = false;
  st.deathAt = versusLobbyState.vsTime;
  st.piece = null;
  st.plan = null;
  st.thinkGen = null;
  st.spec = null;
  st.in.left = st.in.right = st.in.down = false;
  st.in.dir = 0;
  if (st.wrapEl) {
    st.wrapEl.classList.remove("danger");
    st.wrapEl.classList.add("lost");
  }
}

export function insertActiveIdx(i) {
  if (!versusLobbyState.vsActive) return false;
  const st = MP.stations[i];
  if (!st) return false;
  const q = MP.qs[i];
  let cap = 8,
    ins = 0,
    overflow = false;
  while (cap > 0 && q.length && q[0].state === "active") {
    const p = q[0];
    const take = Math.min(cap, p.holes.length);
    const holes = p.holes.splice(0, take);
    cap -= take;
    ins += take;
    if (p.holes.length === 0) q.shift();
    for (const h of holes) {
      const removed = st.board.shift();
      if (!overflow && removed && removed.some((v) => v)) overflow = true;
      const row = emptyRow();
      for (let x = 0; x < configState.COLS; x++) if (x !== h) row[x] = 8;
      st.board.push(row);
    }
  }
  MP.qs[i] = q;
  setMpGauges();
  if (ins > 0) st.recv = (st.recv || 0) + ins;
  if (ins > 0) {
    stFxKick(st, 0, 280, 0);
    SFX.recv();
    if (st.wrapEl) {
      st.wrapEl.classList.remove("garbage-hit");
      st.wrapEl.getAnimations().forEach((a) => a.cancel());
      st.wrapEl.animate([{ transform: "scale(1.03)" }, { transform: "scale(1)" }], {
        duration: 250,
        easing: "ease-out",
      });
      st.wrapEl.classList.add("garbage-hit");
    }
  }
  if (overflow) {
    stTopOut(st);
    return true;
  }
  return false;
}

export function calcLockLabel(nRows, spin, type) {
  let label = "",
    cls = "",
    labelCol = null;
  if (spin) {
    const nm = PIECES[type].n;
    label =
      nm +
      "-SPIN" +
      (spin.mini && nRows <= 1 ? " MINI" : "") +
      (nRows >= 1 ? " " + LINE_WORD[Math.min(nRows, 3)] : "");
    cls = "spin";
    labelCol = PIECES[type].c;
  } else if (nRows === 4) {
    label = "TETRIS";
    cls = "gold";
    labelCol = PIECES[0].c;
  } else if (nRows) {
    label = LINE_WORD[nRows];
  }
  return { label: label, cls: cls, labelCol: labelCol };
}

export function vsMult() {
  return (
    versusLobbyState.vs.gMult +
    (versusLobbyState.vsTime > versusLobbyState.vs.gMargin
      ? (versusLobbyState.vs.gInc * (versusLobbyState.vsTime - versusLobbyState.vs.gMargin)) / 1000
      : 0)
  );
}

export function ensureStream(n) {
  const rng =
    onlineSessionState.onlineRng !== undefined &&
    onlineSessionState.onlineRng &&
    onlineSessionState.isOnlineGame !== undefined &&
    onlineSessionState.isOnlineGame
      ? onlineSessionState.onlineRng
      : gameRandom;
  fillBagStream(versusLobbyState.sharedStream, n, rng);
}

export function resetGaugeCache() {
  configState.gaugeWeak = new WeakMap();
}

export function setGaugeEl(el, travel, pending) {
  if (!el) return;
  let gc = configState.gaugeWeak.get(el);
  if (!gc) {
    gc = { h: 0, t: -1, p: -1, pB: -2 };
    configState.gaugeWeak.set(el, gc);
  }
  if (!gc.h) gc.h = el.clientHeight;
  const h = gc.h;
  if (h < 4) return;
  const lh = h / 18;
  const th = Math.min(h, travel * lh),
    ph = Math.min(h - th, pending * lh);
  if (th !== gc.t) {
    gc.t = th;
    const it = el.querySelector(".gv-t");
    if (it) it.style.height = th + "px";
  }
  if (ph !== gc.p || th !== gc.pB) {
    gc.p = ph;
    gc.pB = th;
    const ip = el.querySelector(".gv-p");
    if (ip) {
      ip.style.height = ph + "px";
      ip.style.bottom = th + "px";
    }
  }
}

export function setMpGauges() {
  if (!versusLobbyState.vsActive) return;
  for (let i = 0; i < MP.n; i++) {
    const st = MP.stations[i];
    if (!st || !st.gaugeEl) continue;
    if (onlineSessionState.onlineRemote !== undefined && onlineSessionState.onlineRemote.has(i)) {
      setGaugeEl(st.gaugeEl, st._olInc || 0, 0);
      continue;
    }
    setGaugeEl(st.gaugeEl, qCountIdx(i, ["travel"]), qCountIdx(i, ["pending", "active"]));
  }
}
