// @ts-nocheck
import { checkPeerVersion, PROTOCOL_VERSION, type JoinRoomResult } from "@tetrizz/protocol";
import { clock } from "../core/clock";
import { fxRandom } from "../core/random";
import { log } from "../core/logger";
import { game } from "../game/state";
import { showEditNote } from "../ui/settings";
import { MP, clampVs, copyRoomRules, refreshVs, versusLobbyState } from "../versus/lobby";
import { setMpGauges, stTopOut } from "../versus/garbage";
import { vsBeginRound, vsMatchEnd } from "../versus/rounds";
import { onNetRejoin, onlineSessionState } from "./online-session";
import { RELAY, lanEnterOnlineLobby, relaySettings } from "./lan";
import { netSend, receiveEnvelope } from "./transport";
import {
  applyServerRoster,
  buildRejoinPayload,
  ensureMqttLoaded,
  forcedLeave,
  onlineApplyState,
  onlineFullStateFor,
  onlineLobbyState,
  onlinePushGarbage,
  onlineStationFor,
  pwdOkFor,
  renderOnlineLists,
  showOnlineLobbyUI,
  startOnlineMatch,
  updateOnlinePlayerList,
} from "./online-lobby";
import { handleHostDeparture, hostProgressDecision, markOnlineLeft } from "./online-sync";
import { netConfig } from "./net-config";

export function relaySend(event, payload) {
  const msg = { event: event, payload: payload };
  if (onlineSessionState.isOnlineHost) {
    for (const c of RELAY.conns.values()) {
      try {
        c.send(msg);
      } catch (_) {
        log.debug("net/relay.relaySend", _);
      }
    }
  } else if (RELAY.hostConn) {
    try {
      RELAY.hostConn.send(msg);
    } catch (_) {
      log.debug("net/relay.relaySend#2", _);
    }
  }
}

export function relayPushRoster() {
  renderOnlineLists();
  netSend("roster", { players: onlineSessionState.onlinePlayersList });
  mqSend("roster", { players: onlineSessionState.onlinePlayersList });
}

export function relayTeardown() {
  if (RELAY.joinTimer) {
    clearTimeout(RELAY.joinTimer);
    RELAY.joinTimer = null;
  }
  RELAY.hostConn = null;
  RELAY.joined = false;
  RELAY.joiningRoom = "";
  RELAY.pendingPwd = "";
  RELAY.peer = null;
  RELAY.conns.clear();
}

export function relayDestroyConnFor(pid) {
  RELAY.conns.delete(pid);
}

function relayPlayerName(pid) {
  const r = onlineSessionState.onlinePlayersList.find((p) => p.id === pid);
  return r ? r.username : "PLAYER";
}

export function onNetAttack(p) {
  if (!p || p.sender === onlineSessionState.myPlayerId) return;
  if (p.target === onlineSessionState.myPlayerId) {
    onlinePushGarbage(p.amount, typeof p.t === "number" ? clock.wall() - p.t : 0);
  } else {
    const ts = onlineStationFor(p.target);
    if (ts) ts._olInc = (ts._olInc || 0) + p.amount;
    setMpGauges();
  }
}

export function onNetState(p) {
  if (p && p.sender !== onlineSessionState.myPlayerId) {
    if (p.board) {
      onlineSessionState._olLastFull[p.sender] = {
        round: p.round,
        phase: p.phase,
        ptr: (function () {
          const _s = onlineStationFor(p.sender);
          return _s ? MP.ptrs[_s.idx] : undefined;
        })(),
        t: p.t,
        time: p.t,
        board: p.board.map(function (r) {
          return r.slice();
        }),
        piece:
          p.piece && typeof p.piece === "object"
            ? { t: p.piece.t, r: p.piece.r, x: p.piece.x, y: p.piece.y }
            : null,
        q: Array.isArray(p.q) ? p.q.slice() : [],
        hold: p.hold,
        holdUsed: p.holdUsed,
        sent: p.sent,
        recv: p.recv,
        lines: p.lines,
        score: p.score,
        level: p.level,
        pieces: p.pieces,
        combo: p.combo,
        b2b: p.b2b,
        alive: p.alive,
        inc: p.inc,
      };
      onlineSessionState._olLastFullAt[p.sender] = clock.wall();
    }
    onlineApplyState(p);
  }
}

export function onNetGameOver(p) {
  p = p || {};
  if (typeof p.rnd === "number" && p.rnd !== versusLobbyState.vsRound) return;
  const st = onlineStationFor(p.sender);
  if (st && st.alive) stTopOut(st);
}

export function onNetLeft(p) {
  p = p || {};
  if (p.sender === onlineSessionState.myPlayerId) return;
  markOnlineLeft(p.sender, (p.name || "PLAYER") + " LEFT");
}

export function onNetKick(p) {
  p = p || {};
  if (!p.target) return;
  if (p.target === onlineSessionState.myPlayerId) {
    forcedLeave("You were kicked from the room.");
    return;
  }
  markOnlineLeft(p.target, "KICKED");
}

export function onNetStart(p) {
  if (!p) return;
  const _rc2 = document.getElementById("onlineReconnecting");
  if (_rc2) _rc2.style.display = "none";
  if (p.seed) onlineSessionState.onlineSeed = p.seed;
  if (p.settings) {
    for (const k in p.settings) {
      if (k !== "seed" && k !== "players" && k !== "pwd" && k !== "pwdH")
        versusLobbyState.vs[k] = p.settings[k];
    }
    clampVs();
  }
  const _nsMe = onlineSessionState.onlinePlayersList.find(function (q) {
    return q.id === onlineSessionState.myPlayerId;
  });
  const _nsAmSpec = !!(_nsMe && _nsMe.state && _nsMe.state.role === "spec");
  if (
    !onlineSessionState.isOnlineGame &&
    !(onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator) &&
    !_nsAmSpec &&
    Array.isArray(p.order) &&
    p.order.indexOf(onlineSessionState.myPlayerId) < 0
  ) {
    onlineSessionState.onlineGameActive = true;
    renderOnlineLists();
    return;
  }
  const _nsSt = p.settings ? p.settings.st : null;
  onlineSessionState.onlineMatchStamp =
    _nsSt && typeof _nsSt.ts === "number" && Array.isArray(p.order)
      ? { ts: _nsSt.ts, order: p.order.slice() }
      : null;
  startOnlineMatch(p.order || []);
}

export function onNetProgress(p) {
  if (!p) return;
  if (
    !onlineSessionState.isOnlineGame &&
    !(onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator)
  ) {
    if (p.kind === "round") {
      onlineSessionState.onlineGameActive = true;
      versusLobbyState.vsRound = p.round;
      renderOnlineLists();
    } else if (p.kind === "match") {
      onlineSessionState.onlineGameActive = false;
      renderOnlineLists();
    }
    return;
  }
  if (p.kind === "round") {
    versusLobbyState.vsRound = p.round;
    vsBeginRound();
  } else if (p.kind === "match") {
    vsMatchEnd(p.winner);
  }
}

export function onNetRoster(p) {
  if (p && onlineSessionState.netMode === "server") {
    applyServerRoster(p);
    return;
  }
  if (!p || onlineSessionState.isOnlineHost) return;
  if (Array.isArray(p.players)) {
    onlineSessionState.onlinePlayersList = p.players;
    log.debug(
      "lan",
      "[LAN] Received roster with",
      onlineSessionState.onlinePlayersList.length,
      "players",
    );
    renderOnlineLists();
    updateOnlinePlayerList();

    if (
      onlineSessionState.netMode === "lan" &&
      !onlineSessionState.isOnlineHost &&
      onlineSessionState.onlineRoomId
    ) {
      setTimeout(function () {
        lanEnterOnlineLobby();
      }, 100);
    }
  }
}

export function onNetSettings(p) {
  if (!p || onlineSessionState.isOnlineHost) return;
  if (p.hostId) onlineSessionState.onlineHostId = p.hostId;
  if (p.roomId) onlineSessionState.onlineRoomId = p.roomId;
  for (const k in p) {
    if (k !== "seed" && k !== "players" && k !== "pwd" && k !== "pwdH" && k !== "st")
      versusLobbyState.vs[k] = p[k];
  }
  if (p.seed) onlineSessionState.onlineSeed = p.seed;
  if (typeof p.pwdH === "string") onlineSessionState.onlineRoomPwdH = p.pwdH;
  clampVs();
  refreshVs();
  renderOnlineLists();

  if (
    onlineSessionState.netMode === "lan" &&
    !onlineSessionState.isOnlineHost &&
    onlineSessionState.onlineRoomId
  ) {
    log.debug("lan", "[LAN] Received settings, transitioning to lobby");
    setTimeout(function () {
      lanEnterOnlineLobby();
    }, 100);
  }
}

/** Hosts `roomId` on the broker. The lobby has already chosen the code and records the room itself. */
export function relayStartHost(roomId) {
  onlineSessionState.netMode = "p2p";
  console.info("[TetriZZ net] backend: MQTT public relay");
  mqHostStart(roomId);
}

/**
 * Joins `roomId` as a guest. Settles with the room's answer: accepted (the host's settings come with
 * it), or a reason for the lobby to show. At most one join is waited for; a newer one replaces it.
 */
export function relayJoin(roomId, pwd): Promise<JoinRoomResult> {
  return new Promise((resolve) => {
    MQ.joinWaiter = resolve;
    relayTeardown();
    onlineSessionState.netMode = "p2p";
    mqJoin(roomId, pwd || "").catch((error) => {
      log.debug("net/relay.relayJoin", error);
      settleJoin({ ok: false, reason: "failed" });
    });
  });
}

function settleJoin(result: JoinRoomResult): void {
  const waiter = MQ.joinWaiter;
  MQ.joinWaiter = null;
  if (waiter) waiter(result);
}

export function relayResumeRoom(lr) {
  if (!lr || !lr.room) return;
  onlineSessionState.netMode = "p2p";
  onlineSessionState.onlineRoomId = lr.room;
  onlineSessionState.onlineHostId = onlineSessionState.myPlayerId;
  onlineSessionState.isOnlineHost = true;
  onlineSessionState.isSpectator = false;
  if (typeof lr.seed === "number") onlineSessionState.onlineSeed = lr.seed;
  if (lr.settings && typeof lr.settings === "object") {
    copyRoomRules(lr.settings);
    clampVs();
  }
  onlineSessionState.onlinePlayersList = [
    {
      id: onlineSessionState.myPlayerId,
      username: onlineSessionState.onlineMyName.toUpperCase(),
      state: { role: "player", joined: clock.wall() },
    },
  ];
  MQ.isHost = true;
  MQ.room = onlineSessionState.onlineRoomId;
  MQ.tryIdx = 0;
  MQ.resumeGen = clock.wall();
  showOnlineLobbyUI();
  mqHostStart(onlineSessionState.onlineRoomId);
  setTimeout(function () {
    if (onlineLobbyState._autoReconnecting && MQ.client && MQ.connected)
      netSend("rejoin-req", { sender: onlineSessionState.myPlayerId });
  }, 1500);
}

export const MQ = {
  client: null,
  connected: false,
  downSince: 0,
  tryIdx: 0,
  room: "",
  isHost: false,
  joined: false,
  joinTimer: null,
  joinWaiter: null,
  pingT: null,
  pendingPwd: "",
  lastHostMsg: 0,
  seen: new Map(),
  dead: new Set(),
};

export function mqTopicBase() {
  return "tzz/" + (MQ.room || onlineSessionState.onlineRoomId || "");
}

export function mqPub(obj) {
  if (MQ.client && MQ.connected && MQ.room) {
    try {
      MQ.client.publish(mqTopicBase() + "/all", JSON.stringify(obj));
    } catch (_) {
      log.debug("net/relay.mqPub", _);
    }
  }
}

export function mqSend(event, payload) {
  if (!MQ.client || !MQ.connected || !MQ.room) return;
  const topic = mqTopicBase() + (onlineSessionState.isOnlineHost ? "/all" : "/host");
  try {
    MQ.client.publish(
      topic,
      JSON.stringify({
        t: "ev",
        from: onlineSessionState.myPlayerId,
        event: event,
        payload: payload,
      }),
    );
  } catch (_) {
    log.debug("net/relay.mqSend", _);
  }
}

export function mqTeardown() {
  if (MQ.pingT) {
    clearInterval(MQ.pingT);
    MQ.pingT = null;
  }
  if (MQ.joinTimer) {
    clearTimeout(MQ.joinTimer);
    MQ.joinTimer = null;
  }
  const wasHost = MQ.isHost;
  const client = MQ.client;
  const room = MQ.room;
  MQ.joined = false;
  MQ.connected = false;
  MQ.room = "";
  MQ.isHost = false;
  MQ.client = null;
  if (wasHost && client && room) {
    try {
      if (onlineSessionState.onlinePlayersList.length) {
        let nxt = null;
        for (let i = 0; i < onlineSessionState.onlinePlayersList.length; i++) {
          const pp = onlineSessionState.onlinePlayersList[i];
          if (pp.id !== onlineSessionState.myPlayerId && !(pp.state && pp.state.role === "spec")) {
            nxt = pp;
            break;
          }
        }
        if (nxt)
          client.publish(
            "tzz/" + room + "/all",
            JSON.stringify({
              t: "host-transfer",
              newHost: nxt.id,
              from: onlineSessionState.myPlayerId,
            }),
          );
        else
          client.publish(
            "tzz/" + room + "/all",
            JSON.stringify({ t: "host-left", from: onlineSessionState.myPlayerId }),
          );
      }
      setTimeout(function () {
        try {
          client.end(false);
        } catch (_) {
          log.debug("net/relay.mqTeardown", _);
        }
      }, 80);
    } catch (_) {
      try {
        client.end(false);
      } catch (__) {
        log.debug("net/relay.mqTeardown#2", __);
      }
    }
  } else if (client) {
    try {
      client.end(false);
    } catch (_) {
      log.debug("net/relay.mqTeardown#3", _);
    }
  }
}

function mqTryBroker(isHost) {
  if (MQ.tryIdx >= netConfig.current.mqttBrokers.length) {
    if (!isHost) settleJoin({ ok: false, reason: "unreachable" });
    return;
  }
  const b = netConfig.current.mqttBrokers[MQ.tryIdx];
  const opts = {
    clientId: "tzz_" + onlineSessionState.myPlayerId + "_" + fxRandom().toString(36).slice(2, 6),
    clean: true,
    connectTimeout: 5000,
    reconnectPeriod: 2500,
    keepalive: 25,
  };
  if (isHost) {
    MQ.gen = clock.wall();
    opts.will = {
      topic: mqTopicBase() + "/all",
      payload: JSON.stringify({ t: "host-left", from: onlineSessionState.myPlayerId, gen: MQ.gen }),
      qos: 1,
      retain: false,
    };
  } else {
  }
  let c;
  try {
    c = mqtt.connect(b.url, opts);
  } catch (e) {
    MQ.tryIdx++;
    mqTryBroker(isHost);
    return;
  }
  MQ.client = c;
  let settled = false;
  const giveUp = () => {
    if (settled) return;
    settled = true;
    try {
      c.end(true);
    } catch (_) {
      log.debug("net/relay.giveUp", _);
    }
    if (MQ.client === c) MQ.client = null;
    MQ.connected = false;
    MQ.tryIdx++;
    mqTryBroker(isHost);
  };
  const tm = setTimeout(giveUp, 8000);
  c.on("connect", () => {
    MQ.connected = true;
    MQ.downSince = 0;
    if (!settled) {
      settled = true;
      clearTimeout(tm);
    }
    if (isHost) {
      c.subscribe(mqTopicBase() + "/host");
      if (MQ.resumeGen) {
        const _rg = MQ.resumeGen;
        MQ.resumeGen = 0;
        setTimeout(function () {
          if (MQ.client && MQ.connected) {
            const _rm = { t: "host-resume", from: onlineSessionState.myPlayerId, gen: _rg };
            try {
              MQ.client.publish(mqTopicBase() + "/all", JSON.stringify(_rm));
              MQ.client.publish(mqTopicBase() + "/host", JSON.stringify(_rm));
            } catch (_) {
              log.debug("net/relay.mqTryBroker", _);
            }
          }
        }, 150);
      }
    } else {
      c.subscribe(mqTopicBase() + "/all");
      if (!MQ.joined) {
        c.publish(
          mqTopicBase() + "/host",
          JSON.stringify({
            t: "join",
            from: onlineSessionState.myPlayerId,
            name: onlineSessionState.onlineMyName,
            pwd: MQ.pendingPwd,
            v: PROTOCOL_VERSION,
          }),
        );
        if (!MQ.joinTimer)
          MQ.joinTimer = setTimeout(function () {
            if (!MQ.joined) {
              mqTeardown();
              settleJoin({ ok: false, reason: "not-found" });
            }
          }, 9000);
      }
    }
  });
  c.on("close", () => {
    MQ.connected = false;
    if (!MQ.downSince) MQ.downSince = clock.wall();
  });
  c.on("error", () => {
    if (!settled) giveUp();
  });
  c.on("message", (topic, buf) => mqOnMessage(topic, buf));
}

async function mqHostStart(roomId) {
  await ensureMqttLoaded();
  if (typeof mqtt === "undefined") return;
  MQ.isHost = true;
  MQ.room = roomId;
  MQ.tryIdx = 0;
  mqTryBroker(true);
}

async function mqJoin(roomId, pwd) {
  await ensureMqttLoaded();
  if (typeof mqtt === "undefined") {
    settleJoin({ ok: false, reason: "unavailable" });
    return;
  }
  const prevMode = onlineSessionState.netMode;
  onlineSessionState.netMode = "p2p";
  mqTeardown();
  MQ.isHost = false;
  MQ.room = roomId;
  MQ.pendingPwd = pwd || "";
  MQ.tryIdx = 0;
  MQ.lastHostMsg = 0;
  if (prevMode !== "supabase") console.info("[TetriZZ net] backend: MQTT public relay");
  mqTryBroker(false);
}

export function mqRemovePlayer(pid, announce) {
  if (!pid || !onlineSessionState.onlinePlayersList.some((p) => p.id === pid)) return;
  const nm = relayPlayerName(pid);
  onlineSessionState.onlinePlayersList = onlineSessionState.onlinePlayersList.filter(
    (p) => p.id !== pid,
  );
  MQ.seen.delete(pid);
  MQ.dead.add(pid);
  relayPushRoster();
  if (announce) {
    const pl = { sender: pid, name: nm };
    netSend("left", pl);
    onNetLeft(pl);
  }
}

function mqJoinRefused(reason) {
  if (MQ.joinTimer) {
    clearTimeout(MQ.joinTimer);
    MQ.joinTimer = null;
  }
  const triedPwd = !!MQ.pendingPwd;
  mqTeardown();
  if (reason === "pwd") settleJoin({ ok: false, reason: "password", wrongPassword: triedPwd });
  else if (reason === "version") settleJoin({ ok: false, reason: "version" });
  else settleJoin({ ok: false, reason: "failed" });
}

function mqOnMessage(topic, buf) {
  let m;
  try {
    m = JSON.parse(buf.toString());
  } catch (_) {
    return;
  }
  if (!m || typeof m !== "object") return;
  if (!MQ.isHost) MQ.lastHostMsg = clock.wall();
  if (MQ.isHost) {
    if (m.from && m.from !== onlineSessionState.myPlayerId) MQ.seen.set(m.from, clock.wall());
    if (m.t === "join") MQ.dead.delete(m.from);
    if (m.from && MQ.dead.has(m.from)) return;
    if (m.t === "host-left" || m.t === "host-transfer") {
      handleHostDeparture(m);
      return;
    }
    if (m.t === "join") {
      const pid = m.from;
      if (!pid) return;
      if (checkPeerVersion(m.v) !== "ok") {
        mqPub({ t: "deny", to: pid, reason: "version" });
        return;
      }
      const existing = onlineSessionState.onlinePlayersList.find((p) => p.id === pid);
      if (existing) {
        if (existing.state) delete existing.state.conn;
        onlineSessionState.onlineSeen[pid] = clock.wall();
        mqPub({
          t: "ack",
          to: pid,
          hostId: onlineSessionState.myPlayerId,
          roomId: onlineSessionState.onlineRoomId,
          seed: onlineSessionState.onlineSeed,
          settings: relaySettings(),
          v: PROTOCOL_VERSION,
        });
        if (onlineSessionState.isOnlineGame && !versusLobbyState.vsMatchOver)
          mqPub({
            t: "ev",
            from: onlineSessionState.myPlayerId,
            event: "rejoin",
            payload: buildRejoinPayload(pid),
          });
        relayPushRoster();
        return;
      }
      if (
        (onlineSessionState.onlineRoomPwd || onlineSessionState.onlineRoomPwdH) &&
        !pwdOkFor(m.pwd)
      ) {
        mqPub({ t: "deny", to: pid, reason: "pwd" });
        return;
      }
      if (onlineSessionState.onlinePlayersList.length >= 12) {
        mqPub({ t: "deny", to: pid, reason: "full" });
        return;
      }
      const players = onlineSessionState.onlinePlayersList.filter(
        (q) => !(q.state && q.state.role === "spec"),
      );
      const role =
        (onlineSessionState.isOnlineGame &&
          versusLobbyState.vsActive &&
          !versusLobbyState.vsMatchOver) ||
        players.length >= 4
          ? "spec"
          : "player";
      MQ.dead.delete(pid);
      onlineSessionState.onlinePlayersList.push({
        id: pid,
        username:
          String(m.name || "PLAYER")
            .toUpperCase()
            .slice(0, 12) || "PLAYER",
        state: { role: role, joined: clock.wall(), ready: false },
      });
      mqPub({
        t: "ack",
        to: pid,
        hostId: onlineSessionState.myPlayerId,
        roomId: onlineSessionState.onlineRoomId,
        seed: onlineSessionState.onlineSeed,
        settings: relaySettings(),
        v: PROTOCOL_VERSION,
      });
      if (
        onlineSessionState.isOnlineGame &&
        !versusLobbyState.vsMatchOver &&
        (game.state === "playing" || game.state === "countdown" || game.state === "vsround")
      ) {
        if (onlineSessionState.onlineLocalOrder.indexOf(pid) >= 0) {
          netSend("rejoin", {
            target: pid,
            seed: onlineSessionState.onlineSeed,
            settings: relaySettings(),
            order: onlineSessionState.onlineLocalOrder,
            round: versusLobbyState.vsRound,
            wins: MP.wins,
            restore: onlineFullStateFor(pid),
          });
        } else {
          netSend("start", {
            seed: onlineSessionState.onlineSeed,
            settings: relaySettings(),
            order: onlineSessionState.onlineLocalOrder,
          });
        }
      }
      relayPushRoster();
      return;
    }
    if (m.t === "presence") {
      const _ppid = m.from;
      if (
        _ppid &&
        !onlineSessionState.onlinePlayersList.some(function (q) {
          return q.id === _ppid;
        })
      ) {
        onlineSessionState.onlinePlayersList.push({
          id: _ppid,
          username:
            String(m.name || "PLAYER")
              .toUpperCase()
              .slice(0, 12) || "PLAYER",
          state: { role: m.role === "spec" ? "spec" : "player", joined: clock.wall() },
        });
        MQ.seen.set(_ppid, clock.wall());
        relayPushRoster();
        if (
          onlineSessionState.isOnlineGame &&
          !versusLobbyState.vsMatchOver &&
          (game.state === "playing" || game.state === "countdown" || game.state === "vsround") &&
          onlineSessionState.onlineLocalOrder.indexOf(_ppid) >= 0
        ) {
          netSend("rejoin", {
            target: _ppid,
            seed: onlineSessionState.onlineSeed,
            settings: relaySettings(),
            order: onlineSessionState.onlineLocalOrder,
            round: versusLobbyState.vsRound,
            wins: MP.wins,
            restore: onlineFullStateFor(_ppid),
          });
        }
      }
      return;
    }
    if (m.t === "ping") {
      return;
    }
    if (m.t === "bye") {
      mqRemovePlayer(m.from, true);
      return;
    }
    if (m.t === "host-left" || m.t === "host-transfer") {
      const deadHost = m.from;
      if (!deadHost || deadHost === onlineSessionState.myPlayerId) return;
      onlineSessionState.onlinePlayersList = onlineSessionState.onlinePlayersList.filter(
        (p) => p.id !== deadHost,
      );
      MQ.seen.delete(deadHost);
      MQ.dead.add(deadHost);
      const players = onlineSessionState.onlinePlayersList.filter(
        (p) => !(p.state && p.state.role === "spec"),
      );
      const newHost = players.length ? players[0] : onlineSessionState.onlinePlayersList[0];
      if (!newHost) {
        forcedLeave("The room was closed.");
        return;
      }
      onlineSessionState.onlineHostId = newHost.id;
      if (newHost.id === onlineSessionState.myPlayerId) {
        MQ.isHost = true;
        onlineSessionState.isOnlineHost = true;
        if (MQ.pingT) {
          clearInterval(MQ.pingT);
          MQ.pingT = null;
        }
        showEditNote("You are now the HOST");
        if (MQ.client) {
          try {
            MQ.client.unsubscribe(mqTopicBase() + "/all");
          } catch (_) {
            log.debug("net/relay.mqOnMessage", _);
          }
          MQ.client.subscribe(mqTopicBase() + "/host");
        }
        relayPushRoster();
        if (game.state === "vsround" && !versusLobbyState.vsMatchOver) {
          clearTimeout(versusLobbyState.vsRoundT);
          versusLobbyState.vsRoundT = setTimeout(hostProgressDecision, 800);
        }
      } else {
        onlineSessionState.isOnlineHost = false;
      }
      renderOnlineLists();
      return;
    }
    if (m.t === "rejoin-req") {
      const _mrpid = m.from;
      if (
        _mrpid &&
        _mrpid !== onlineSessionState.myPlayerId &&
        onlineSessionState.isOnlineGame &&
        !versusLobbyState.vsMatchOver
      ) {
        const _rn2 = clock.wall();
        if (!onNetRejoin._rr) onNetRejoin._rr = {};
        if (!onNetRejoin._rr[_mrpid] || _rn2 - onNetRejoin._rr[_mrpid] >= 1500) {
          onNetRejoin._rr[_mrpid] = _rn2;
          if (onlineSessionState.onlineLocalOrder.indexOf(_mrpid) >= 0) {
            netSend("rejoin", buildRejoinPayload(_mrpid));
          } else {
            netSend("game-active", {
              sender: onlineSessionState.myPlayerId,
              seed: onlineSessionState.onlineSeed,
              order: onlineSessionState.onlineLocalOrder,
              round: versusLobbyState.vsRound,
            });
          }
        }
      } else if (
        _mrpid &&
        _mrpid !== onlineSessionState.myPlayerId &&
        onlineSessionState.isOnlineHost
      ) {
        netSend("lobby-ok", { target: _mrpid });
      }
      return;
    }
    if (m.t === "ev") {
      if (m.event === "swap-req") {
        const me = onlineSessionState.onlinePlayersList.find((q) => q.id === m.from);
        if (me && m.payload) {
          if (m.payload.role) me.state.role = m.payload.role;
          if (m.payload.ready !== undefined) me.state.ready = m.payload.ready;
          relayPushRoster();
        }
        return;
      }
      if (m.event === "left") {
        MQ.seen.delete(m.from);
        MQ.dead.add(m.from);
        onlineSessionState.onlinePlayersList = onlineSessionState.onlinePlayersList.filter(
          (p) => p.id !== m.from,
        );
        relayPushRoster();
      }
      for (const [pid, c] of RELAY.conns) {
        if (pid !== m.from) {
          try {
            c.send({ event: m.event, payload: m.payload });
          } catch (_) {
            log.debug("net/relay.mqOnMessage#2", _);
          }
        }
      }
      mqPub({ t: "ev", from: m.from, event: m.event, payload: m.payload });
      receiveEnvelope("p2p", { event: m.event, payload: m.payload });
      return;
    }
    return;
  }

  if (m.t === "host-resume") {
    if (m.from && m.from !== onlineSessionState.myPlayerId) {
      if (typeof m.gen === "number") MQ.hostGenSeen = Math.max(MQ.hostGenSeen || 0, m.gen);
      if (MQ.isHost) {
        MQ.isHost = false;
        try {
          if (MQ.client && MQ.room) {
            MQ.client.unsubscribe(mqTopicBase() + "/host");
            MQ.client.subscribe(mqTopicBase() + "/all");
          }
        } catch (_) {
          log.debug("net/relay.mqOnMessage#3", _);
        }
        if (!MQ.pingT) {
          MQ.pingT = setInterval(function () {
            if (MQ.client && MQ.connected && MQ.room) {
              try {
                MQ.client.publish(
                  mqTopicBase() + "/host",
                  JSON.stringify({ t: "ping", from: onlineSessionState.myPlayerId }),
                );
              } catch (_) {
                log.debug("net/relay.mqOnMessage#4", _);
              }
            }
          }, 6000);
        }
      }
      onlineSessionState.isOnlineHost = false;
      onlineSessionState.onlineHostId = m.from;
      try {
        if (MQ.client && MQ.connected) {
          const _meP = onlineSessionState.onlinePlayersList.find(function (q) {
            return q.id === onlineSessionState.myPlayerId;
          });
          MQ.client.publish(
            mqTopicBase() + "/host",
            JSON.stringify({
              t: "presence",
              from: onlineSessionState.myPlayerId,
              name: onlineSessionState.onlineMyName,
              role: _meP && _meP.state && _meP.state.role ? _meP.state.role : "player",
            }),
          );
        }
      } catch (_) {
        log.debug("net/relay.mqOnMessage#5", _);
      }
      renderOnlineLists();
    }
    return;
  }
  if (m.t === "host-left" || m.t === "host-transfer") {
    if (
      m.t === "host-left" &&
      typeof m.gen === "number" &&
      MQ.hostGenSeen &&
      m.gen <= MQ.hostGenSeen
    )
      return;
    handleHostDeparture(m);
    return;
  }
  if (m.to && m.to !== onlineSessionState.myPlayerId) return;
  if (m.t === "ack") {
    if (checkPeerVersion(m.v) !== "ok") {
      mqJoinRefused("version");
      return;
    }
    if (!MQ.joinWaiter) return;
    MQ.joined = true;
    if (MQ.joinTimer) {
      clearTimeout(MQ.joinTimer);
      MQ.joinTimer = null;
    }
    MQ.pingT = setInterval(() => {
      if (MQ.client && MQ.connected && MQ.room) {
        try {
          MQ.client.publish(
            mqTopicBase() + "/host",
            JSON.stringify({ t: "ping", from: onlineSessionState.myPlayerId }),
          );
        } catch (_) {
          log.debug("net/relay.mqOnMessage#6", _);
        }
      }
    }, 6000);
    settleJoin({
      ok: true,
      roomId: m.roomId || MQ.room,
      hostId: m.hostId,
      isHost: false,
      seed: m.seed || 0,
      settings: m.settings || {},
    });
    return;
  }
  if (m.t === "deny") {
    mqJoinRefused(m.reason);
    return;
  }
  if (m.t === "ev") {
    receiveEnvelope("p2p", { event: m.event, payload: m.payload });
    return;
  }
}

const _scriptCache = {};

export function loadScriptWithSri(src, integrity, crossOrigin) {
  if (_scriptCache[src]) return _scriptCache[src];
  _scriptCache[src] = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    if (integrity) {
      s.integrity = integrity;
      s.crossOrigin = crossOrigin || "anonymous";
      s.referrerPolicy = "no-referrer";
    }
    s.onload = res;
    s.onerror = rej;
    document.head.appendChild(s);
  });
  return _scriptCache[src];
}
