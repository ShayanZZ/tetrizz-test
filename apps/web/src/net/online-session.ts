// @ts-nocheck
import { clock } from "../core/clock";
import { gameRandom } from "../core/random";
import { PIECES } from "@tetrizz/core";
import { log } from "../core/logger";
import { storage } from "../core/storage";
import { configState } from "../core/config";
import { game } from "../game/state";
import { layout } from "../ui/layout";
import { bannerStay, clearAllBanners } from "../render/render";
import { CD_TOTAL, clearInput, syncCountdownPhase, syncPad } from "../game/game";
import { rndHole } from "../ui/screens";
import { MP, clampVs, versusLobbyState } from "../versus/lobby";
import { ensureStream, setMpGauges } from "../versus/garbage";
import {
  drawStHold,
  drawStNexts,
  renderStation,
  stCheckDanger,
  stUpdateChips,
  stUpdateStats,
} from "../versus/stations";
import { updatePings, vsUpdateHud } from "../versus/rounds";
import { activeTransport, netSend } from "./transport";
import { MQ } from "./relay";
import {
  clearRejoinWatchdog,
  onlineApplyRestore,
  onlineLobbyState,
  onlineStationFor,
  renderOnlineLists,
  showOnlineLobbyUI,
  startOnlineMatch,
  updateOnlinePlayerList,
} from "./online-lobby";
import type { SupabaseChannelLike } from "./transports/supabase-transport";
import { markOnlineLeft } from "./online-sync";
import { AUTO_REJOIN_MS } from "../replay/replay";

export const onlineSessionState = {
  sb: null as { removeChannel(channel: unknown): unknown } | null,
  onlineChannel: null as SupabaseChannelLike | null,
  onlineRoomId: null,
  onlineHostId: null,
  myPlayerId: null,
  isOnlineGame: false,
  isOnlineHost: false,
  isSpectator: false,
  onlineSeed: 0,
  onlineRng: null,
  onlineJoinedRoomAt: 0,
  onlineRemote: new Set(),
  onlineSlotMap: {},
  onlineSlotToPid: {},
  onlinePlayersList: [],
  onlineGoSent: false,
  onlineMyName: "PLAYER",
  leavingRoom: false,
  onlineRoomPwd: "",
  onlineRoomPwdH: "",
  onlineLocalOrder: [] as string[],
  onlineMatchOrder: [],
  /** The host's start stamp and the player order of the match being started, for the telemetry game id. */
  onlineMatchStamp: null as { ts: number; order: string[] } | null,
  onlineGlobalIdx: {},
  onlineGameActive: false,
  onlineLiveOrder: [] as string[],
  onlineDisconnected: false,
  _olSelfLockUntil: 0,
  _rjSuppress: false,
  onlinePing: {},
  onlineSeen: {},
  _olLastFull: {},
  _olLastFullAt: {},
  onlineReadyFlags: {},
  _schNetAcc: 0,
  _schKeepAliveAcc: 0,
  _schSessionAcc: 0,
  _schMqSweepAcc: 0,
  _schGraceAcc: 0,
  netMode: "supabase",
  isLanMode: false,
};

export function onNetPing(p) {
  if (!p || p.sender === onlineSessionState.myPlayerId) return;
  netSend("pong", { sender: onlineSessionState.myPlayerId, target: p.sender, ts: p.ts });
}

export function onNetPong(p) {
  if (!p || p.target !== onlineSessionState.myPlayerId) return;
  const rtt = clock.wall() - p.ts;
  if (rtt < 0 || rtt > 9999) return;
  const prev = onlineSessionState.onlinePing[p.sender];
  onlineSessionState.onlinePing[p.sender] = prev != null ? prev * 0.7 + rtt * 0.3 : rtt;
  updatePings();
}

export function onNetHb(p) {
  if (!p || p.sender === onlineSessionState.myPlayerId) return;
  onlineSessionState.onlineSeen[p.sender] = clock.wall();
  const pl = onlineSessionState.onlinePlayersList.find((q) => q.id === p.sender);
  if (pl && pl.state && pl.state.conn) {
    delete pl.state.conn;
    renderOnlineLists();
    const st = onlineStationFor(p.sender);
    if (st) {
      st.paused = false;
      st.leftByGone = false;
      if (st.bannerEl && st.bannerEl.textContent === "CONNECTION LOST…")
        st.bannerEl.textContent = "";
    }
  }
}

export const CONN_LOST_MS = 15000,
  GONE_MS = 90000;

export function graceSweep() {
  if (!onlineSessionState.onlineRoomId) return;
  for (const _pid in onlineSessionState.onlineSeen) {
    if (!onlineSessionState.onlinePlayersList.some((p) => p.id === _pid))
      delete onlineSessionState.onlineSeen[_pid];
  }
  for (const _pid in onlineSessionState.onlinePing) {
    if (!onlineSessionState.onlinePlayersList.some((p) => p.id === _pid))
      delete onlineSessionState.onlinePing[_pid];
  }
  for (const _pid in onlineSessionState._olLastFull) {
    const _pl = onlineSessionState.onlinePlayersList.find((p) => p.id === _pid);
    if (!_pl || (_pl.state && _pl.state.conn === "gone")) {
      delete onlineSessionState._olLastFull[_pid];
      delete onlineSessionState._olLastFullAt[_pid];
    }
  }
  const inGame =
    versusLobbyState.vsActive !== undefined &&
    versusLobbyState.vsActive &&
    !versusLobbyState.vsMatchOver &&
    ((onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame) ||
      (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator));
  const now = clock.wall();

  if (inGame && !onlineSessionState.isOnlineHost && !onlineSessionState.isSpectator) {
    let connected = true;
    if (onlineSessionState.netMode === "p2p") {
      if (MQ.client && !MQ.connected && MQ.downSince && now - MQ.downSince > 3000)
        connected = false;
      if (MQ.lastHostMsg && now - MQ.lastHostMsg > 5000) connected = false;
    } else if (onlineSessionState.netMode === "supabase") {
      if (onlineSessionState.onlineChannel && onlineSessionState.onlineChannel.state !== "joined")
        connected = false;
    } else if (onlineSessionState.netMode === "server") {
      if (!activeTransport().isOpen()) connected = false;
    }
    if (onlineSessionState.onlineDisconnected !== !connected) {
      onlineSessionState.onlineDisconnected = !connected;
      if (onlineSessionState.onlineDisconnected) {
        if (MP.stations[0]) {
          MP.stations[0].in.left = MP.stations[0].in.right = MP.stations[0].in.down = false;
          MP.stations[0].in.dir = 0;
        }
        clearInput();
        if (MP.stations[0] && MP.stations[0].bannerEl && MP.stations[0].alive)
          bannerStay(MP.stations[0].bannerEl, "RECONNECTING...", "#ff9f43", "round");
      } else {
        if (
          MP.stations[0] &&
          MP.stations[0].bannerEl &&
          MP.stations[0].bannerEl.textContent === "RECONNECTING..."
        )
          MP.stations[0].bannerEl.textContent = "";
      }
    }
  } else {
    onlineSessionState.onlineDisconnected = false;
  }
  for (const p of onlineSessionState.onlinePlayersList.slice()) {
    if (p.id === onlineSessionState.myPlayerId || !p.state) continue;
    const stale = now - (onlineSessionState.onlineSeen[p.id] || p.state.joined || now);
    if (stale < CONN_LOST_MS) {
      if (p.state.conn === "lost" || p.state.conn === "gone") {
        delete p.state.conn;
        delete p.state.connLostAt;
        renderOnlineLists();
        const st = onlineStationFor(p.id);
        if (st) {
          st.paused = false;
          if (
            st.bannerEl &&
            (st.bannerEl.textContent.indexOf("CONNECTION") >= 0 ||
              st.bannerEl.textContent.indexOf("RECONNECTING") >= 0)
          )
            st.bannerEl.textContent = "";
        }
      }
      continue;
    }
    if (!inGame) continue;
    if (stale >= GONE_MS) {
      if (p.state.conn !== "gone") {
        p.state.conn = "gone";
        p.state.goneAt = now;
        delete p.state.connLostAt;
        renderOnlineLists();
        const _gst = onlineStationFor(p.id);
        if (_gst) _gst.leftByGone = true;
        markOnlineLeft(p.id, (p.username || "PLAYER") + " LEFT");
      } else if (p.state.goneAt && now - p.state.goneAt > 240000) {
        const _gst2 = onlineStationFor(p.id);
        if (_gst2) _gst2.leftByGone = false;
      }
      continue;
    }
    if (p.state.conn !== "lost") {
      p.state.conn = "lost";
      p.state.connLostAt = now;
      renderOnlineLists();
      const st = onlineStationFor(p.id);
      if (st && st.bannerEl && st.alive)
        bannerStay(
          st.bannerEl,
          "RECONNECTING... " + Math.max(0, Math.ceil((GONE_MS - stale) / 1000)) + "s",
          "#ff9f43",
          "round",
        );
    } else if (p.state.conn === "lost") {
      if (!p.state.connLostAt) p.state.connLostAt = now;
      const remaining = Math.max(0, Math.ceil((GONE_MS - stale) / 1000));
      const st = onlineStationFor(p.id);
      if (st && st.bannerEl && st.alive)
        bannerStay(st.bannerEl, "RECONNECTING... " + remaining + "s", "#ff9f43", "round");
      renderOnlineLists();
    }
  }
}

export function onNetRejoin(p) {
  if (!p || p.target !== onlineSessionState.myPlayerId) return;
  if (
    onlineSessionState.isOnlineGame &&
    clock.wall() - onlineSessionState.onlineJoinedRoomAt < 2500
  )
    return;
  onlineLobbyState._autoReconnecting = false;
  clearRejoinWatchdog();
  onlineSessionState.onlineJoinedRoomAt = clock.wall();
  onlineSessionState.onlineDisconnected = false;
  if (
    MP.stations[0] &&
    MP.stations[0].bannerEl &&
    MP.stations[0].bannerEl.textContent === "RECONNECTING..."
  )
    MP.stations[0].bannerEl.textContent = "";
  const _rc = document.getElementById("onlineReconnecting");
  if (_rc) _rc.style.display = "none";
  updateOnlinePlayerList();
  const myRole = onlineSessionState.onlinePlayersList.find(
    (q) => q.id === onlineSessionState.myPlayerId,
  )?.state?.role;
  onlineSessionState.isSpectator = myRole === "spec";
  if (p.seed) onlineSessionState.onlineSeed = p.seed;
  if (p.settings) {
    for (const k in p.settings) {
      if (k !== "seed" && k !== "players" && k !== "pwd" && k !== "pwdH")
        versusLobbyState.vs[k] = p.settings[k];
    }
    clampVs();
  }
  versusLobbyState._vsPendingRound = p.round || 1;
  let _rjOrder = Array.isArray(p.order)
    ? p.order.filter(function (id) {
        return typeof id === "string" && id;
      })
    : [];
  if (
    !_rjOrder.length &&
    onlineSessionState.onlinePlayersList !== undefined &&
    onlineSessionState.onlinePlayersList &&
    onlineSessionState.onlinePlayersList.length
  ) {
    _rjOrder = onlineSessionState.onlinePlayersList
      .filter(function (pl) {
        return pl && pl.id && !(pl.state && pl.state.role === "spec");
      })
      .map(function (pl) {
        return pl.id;
      });
  }
  if (!_rjOrder.length) {
    onlineSessionState.onlineGameActive = false;
    onlineSessionState.isOnlineGame = false;
    onlineSessionState.isSpectator = false;
    document.body.classList.remove("vsplay", "online-play");
    showOnlineLobbyUI();
    return;
  }
  document.body.classList.add("vsplay");
  startOnlineMatch(_rjOrder);
  if (Array.isArray(p.wins)) MP.wins = p.wins.slice(0, 4);
  if (p.cumByPid && typeof p.cumByPid === "object") {
    const _rjCum = [null, null, null, null];
    for (let _rsi = 0; _rsi < MP.stations.length; _rsi++) {
      const _rst = MP.stations[_rsi];
      const _rpid =
        onlineSessionState.onlineSlotToPid !== undefined && onlineSessionState.onlineSlotToPid
          ? onlineSessionState.onlineSlotToPid[_rst.slot]
          : null;
      const _rsrc = _rpid ? p.cumByPid[_rpid] : null;
      if (_rsrc)
        _rjCum[_rst.slot] = {
          lines: _rsrc.lines || 0,
          pieces: _rsrc.pieces || 0,
          ms: _rsrc.ms || 0,
          combo: _rsrc.combo || 0,
          score: _rsrc.score || 0,
          atk: _rsrc.atk || 0,
          recv: _rsrc.recv || 0,
          lvl: _rsrc.lvl || 1,
        };
    }
    for (let _rzi = 0; _rzi < 4; _rzi++) {
      if (!_rjCum[_rzi])
        _rjCum[_rzi] = {
          lines: 0,
          pieces: 0,
          ms: 0,
          combo: 0,
          score: 0,
          atk: 0,
          recv: 0,
          lvl: 1,
        };
    }
    MP.cum = _rjCum;
  } else if (Array.isArray(p.cum)) {
    const _rjCum2 = p.cum.slice(0, 4).map(function (c) {
      return {
        lines: c.lines || 0,
        pieces: c.pieces || 0,
        ms: c.ms || 0,
        combo: c.combo || 0,
        score: c.score || 0,
        atk: c.atk || 0,
        recv: c.recv || 0,
        lvl: c.lvl || 1,
      };
    });
    while (_rjCum2.length < 4)
      _rjCum2.push({
        lines: 0,
        pieces: 0,
        ms: 0,
        combo: 0,
        score: 0,
        atk: 0,
        recv: 0,
        lvl: 1,
      });
    MP.cum = _rjCum2;
  }
  const _rjLag = typeof p.ts === "number" ? Math.max(0, Math.min(1500, clock.wall() - p.ts)) : 0;
  onlineSessionState._rjSuppress = true;
  if (p.restore && p.restore.round === versusLobbyState.vsRound) {
    onlineRestoreSelf(p.restore);
  }
  let _selfSnap = null;
  try {
    _selfSnap = JSON.parse(storage.get("tetris_olself") || "null");
  } catch (_) {
    _selfSnap = null;
  }
  if (
    _selfSnap &&
    _selfSnap.pid === onlineSessionState.myPlayerId &&
    _selfSnap.room === onlineSessionState.onlineRoomId &&
    _selfSnap.seed === onlineSessionState.onlineSeed &&
    _selfSnap.round === versusLobbyState.vsRound &&
    clock.wall() - (_selfSnap.ts || 0) < AUTO_REJOIN_MS &&
    MP.stations[0]
  ) {
    let _rbEmpty = true;
    for (let _ry = 0; _ry < MP.stations[0].board.length && _rbEmpty; _ry++) {
      for (let _rx = 0; _rx < configState.COLS; _rx++) {
        if (MP.stations[0].board[_ry][_rx]) {
          _rbEmpty = false;
          break;
        }
      }
    }
    let _sbEmpty = true;
    for (let _sy = 0; _sy < _selfSnap.board.length && _sbEmpty; _sy++) {
      for (let _sx = 0; _sx < configState.COLS; _sx++) {
        if (_selfSnap.board[_sy][_sx]) {
          _sbEmpty = false;
          break;
        }
      }
    }
    if (_rbEmpty && !_sbEmpty) {
      onlineRestoreSelf({
        board: _selfSnap.board,
        piece: _selfSnap.piece,
        q: _selfSnap.q,
        ptr: _selfSnap.ptr,
        hold: _selfSnap.hold,
        holdUsed: _selfSnap.holdUsed,
        sent: _selfSnap.sent,
        recv: _selfSnap.recv,
        lines: _selfSnap.lines,
        score: _selfSnap.score,
        level: _selfSnap.level,
        pieces: _selfSnap.pieces,
        combo: _selfSnap.combo,
        b2b: _selfSnap.b2b,
        alive: 1,
        time: _selfSnap.t,
        round: _selfSnap.round,
      });
      versusLobbyState.vsTime = _selfSnap.t;
    }
  }
  onlineSessionState._rjSuppress = false;

  onlineSessionState._olSelfLockUntil = clock.wall() + 4000;
  setTimeout(function () {
    if (!onlineSessionState.isOnlineGame || versusLobbyState.vsMatchOver || !MP.stations[0]) return;
    let _b = MP.stations[0].board,
      _empty = true;
    for (let _y = 0; _y < _b.length && _empty; _y++) {
      for (let _x = 0; _x < configState.COLS; _x++) {
        if (_b[_y][_x]) {
          _empty = false;
          break;
        }
      }
    }
    if (!_empty) return;
    let _s2 = null;
    try {
      _s2 = JSON.parse(storage.get("tetris_olself") || "null");
    } catch (_) {
      _s2 = null;
    }
    if (
      !_s2 ||
      _s2.pid !== onlineSessionState.myPlayerId ||
      _s2.room !== onlineSessionState.onlineRoomId ||
      _s2.round !== versusLobbyState.vsRound
    )
      return;
    let _s2Empty = true;
    for (let _y2 = 0; _y2 < _s2.board.length && _s2Empty; _y2++) {
      for (let _x2 = 0; _x2 < configState.COLS; _x2++) {
        if (_s2.board[_y2][_x2]) {
          _s2Empty = false;
          break;
        }
      }
    }
    if (_s2Empty) return;
    onlineRestoreSelf({
      board: _s2.board,
      piece: _s2.piece,
      q: _s2.q,
      ptr: _s2.ptr,
      hold: _s2.hold,
      holdUsed: _s2.holdUsed,
      sent: _s2.sent,
      recv: _s2.recv,
      lines: _s2.lines,
      score: _s2.score,
      level: _s2.level,
      pieces: _s2.pieces,
      combo: _s2.combo,
      b2b: _s2.b2b,
      alive: 1,
      time: _s2.t,
      round: _s2.round,
    });
    onlineSessionState._olSelfLockUntil = clock.wall() + 4000;
  }, 2000);
  if (typeof p.vsTime === "number") versusLobbyState.vsTime = p.vsTime + _rjLag;
  else if (p.restore && typeof p.restore.time === "number")
    versusLobbyState.vsTime = p.restore.time + _rjLag;
  if (p.others && typeof p.others === "object") {
    for (const _roid in p.others) {
      const _ros = p.others[_roid];
      if (!_ros) continue;
      const _rost = onlineStationFor(_roid);
      if (_rost) onlineApplyRestore(_rost, _ros);
    }
  }
  for (let _ti = 0; _ti < MP.stations.length; _ti++) {
    MP.stations[_ti].timeMs = versusLobbyState.vsTime;
  }
  game.pausedFrom = null;
  game.lastTs = clock.now();
  if (p.phase === "countdown") {
    versusLobbyState.vsBannerUntil = 0;
    game.state = "countdown";
    versusLobbyState.vsCountdownStarted = true;
    game.countdownRemaining = Math.max(
      0,
      (typeof p.cd === "number" && p.cd > 0 ? p.cd : CD_TOTAL) - _rjLag,
    );
    game.countdownPhase = "";
    clearAllBanners();
    syncCountdownPhase();
  } else if (p.phase === "vsround") {
    versusLobbyState.vsBannerUntil = 0;
    game.state = "vsround";
    versusLobbyState.vsRoundOver = true;
    game.countdownRemaining = 0;
    game.countdownPhase = "";
    clearAllBanners();
  } else {
    versusLobbyState.vsBannerUntil = 0;
    game.state = "playing";
    game.countdownRemaining = 0;
    game.countdownPhase = "";
    versusLobbyState.vsCountdownStarted = true;
    clearAllBanners();
  }
  netSend("unleft", { sender: onlineSessionState.myPlayerId });
  vsUpdateHud();
  syncPad();
  layout();
}

function onlineRestoreSelf(r) {
  const st = MP.stations[0];
  if (!st) return;
  if (Array.isArray(r.board) && r.board.length === configState.ROWS)
    st.board = r.board.map((row) => row.slice());
  if (r.piece && typeof r.piece === "object")
    st.piece = {
      type: r.piece.t,
      rot: r.piece.r,
      x: r.piece.x,
      y: r.piece.y,
      cells: PIECES[r.piece.t].cells[r.piece.r],
      lockT: 0,
      lockResets: 0,
    };
  else st.piece = null;
  if (st.piece) {
    let _already = true;
    for (const q of st.piece.cells) {
      const X = st.piece.x + q[0],
        Y = st.piece.y + q[1];
      if (!(
        Y >= 0 &&
        Y < configState.ROWS &&
        X >= 0 &&
        X < configState.COLS &&
        st.board[Y][X] === st.piece.type + 1
      )) {
        _already = false;
        break;
      }
    }
    if (_already) st.piece = null;
  }
  st.gravT = 0;
  if (Array.isArray(r.q) && r.q.length > 0) {
    st.queue = r.q.slice();
    ensureStream(400);
    let _rsFound = -1;
    if (
      typeof r.ptr === "number" &&
      r.ptr >= 0 &&
      r.ptr + r.q.length <= versusLobbyState.sharedStream.length
    ) {
      let _rsOk = true;
      for (let _rsj = 0; _rsj < r.q.length; _rsj++) {
        if (versusLobbyState.sharedStream[r.ptr + _rsj] !== r.q[_rsj]) {
          _rsOk = false;
          break;
        }
      }
      if (_rsOk) _rsFound = r.ptr;
    }
    if (_rsFound < 0) {
      ensureStream(MP.ptrs[0] + r.q.length + 500);
      for (let _rsk = 0; _rsk < versusLobbyState.sharedStream.length - r.q.length; _rsk++) {
        let _rsOk2 = true;
        for (let _rsj2 = 0; _rsj2 < r.q.length; _rsj2++) {
          if (versusLobbyState.sharedStream[_rsk + _rsj2] !== r.q[_rsj2]) {
            _rsOk2 = false;
            break;
          }
        }
        if (_rsOk2) {
          _rsFound = _rsk;
          break;
        }
      }
    }
    if (_rsFound >= 0) {
      MP.ptrs[0] = _rsFound;
    } else if (typeof r.ptr === "number") {
      MP.ptrs[0] = r.ptr;
      ensureStream(r.ptr + 10);
    } else {
      MP.ptrs[0] = 0;
    }
  } else if (Array.isArray(r.q)) {
    st.queue = r.q.slice();
  }
  ensureStream(MP.ptrs[0] + 8);
  if (
    st.queue.length < 5 ||
    st.queue.some(function (t2, i2) {
      return versusLobbyState.sharedStream[MP.ptrs[0] + i2] !== t2;
    })
  ) {
    st.queue = versusLobbyState.sharedStream.slice(MP.ptrs[0], MP.ptrs[0] + 5);
  }
  st.hold = r.hold != null ? r.hold : null;
  st.holdUsed = !!r.holdUsed;
  st.sent = r.sent || 0;
  st.recv = r.recv || 0;
  st.lines = r.lines || 0;
  st.score = r.score || 0;
  st.level = r.level || 1;
  const _rpCalc = Math.max(0, MP.ptrs[0] - 1 - (st.hold != null ? 1 : 0));
  st.pieces = Math.max(r.pieces || 0, _rpCalc);
  st.combo = typeof r.combo === "number" ? r.combo : -1;
  st.b2b = r.b2b || 0;
  st.alive = r.alive !== 0;
  if (typeof r.time === "number") versusLobbyState.vsTime = r.time;
  st.timeMs = versusLobbyState.vsTime;

  if (typeof r.time === "number") versusLobbyState.vsTime = r.time;
  st.timeMs = versusLobbyState.vsTime;
  if (r.inc > 0) {
    let pv = MP.lastHole[0];
    for (let k = 0; k < r.inc; k++) {
      const same = pv < 0 ? false : gameRandom() < 0.8;
      const h = same ? pv : rndHole(pv);
      pv = h;
      MP.qs[0].push({ holes: [h], state: "pending", t0: 0 });
    }
    MP.lastHole[0] = pv;
    setMpGauges();
  }
  stUpdateStats(st);
  stUpdateChips(st);
  drawStHold(st);
  drawStNexts(st);
  stCheckDanger(st);
  renderStation(st);
}

export function saveLastRoom() {
  try {
    if (!onlineSessionState.onlineRoomId || onlineSessionState.leavingRoom) return;
    if (onlineSessionState.netMode === "lan") return;
    const lr = {
      room: onlineSessionState.onlineRoomId,
      name: onlineSessionState.onlineMyName,
      pid: onlineSessionState.myPlayerId,
      ts: clock.wall(),
      mode: onlineSessionState.netMode,
      host: onlineSessionState.isOnlineHost ? 1 : 0,
    };
    if (onlineSessionState.isOnlineHost) {
      lr.seed = onlineSessionState.onlineSeed;
      const s = Object.assign({}, versusLobbyState.vs);
      delete s.players;
      lr.settings = s;
    }
    storage.set("tetris_lastroom", JSON.stringify(lr));
  } catch (_) {
    log.debug("net/online-session.saveLastRoom", _);
  }
}

export function clearLastRoom() {
  try {
    storage.remove("tetris_lastroom");
  } catch (_) {
    log.debug("net/online-session.clearLastRoom", _);
  }
}
