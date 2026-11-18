// @ts-nocheck
import { clock } from "../core/clock";
import { log } from "../core/logger";
import { storage } from "../core/storage";
import { game } from "../game/state";
import { $ } from "../ui/layout";
import { quitToMenu, showScreen } from "../game/game";
import { showEditNote } from "../ui/settings";
import { MP, qCountIdx, versusLobbyState } from "../versus/lobby";
import { stBanner } from "../versus/stations";
import { boardHash } from "../bot/bot-control";
import { vsBeginRound, vsMatchEnd } from "../versus/rounds";
import { onlineSessionState } from "./online-session";
import { netSend } from "./transport";
import { MQ, relayPushRoster } from "./relay";
import {
  forcedLeave,
  onlineStationFor,
  renderOnlineLists,
  showOnlineLobbyUI,
  updateOnlinePlayerList,
} from "./online-lobby";

export const onlineSyncState = {
  _olSyncT: null,
  _osLastT: 0,
  _osLastSig: "",
  _osLastBoardHash: -1,
  _osLastRound: -1,
  _osLastForceT: 0,
  _myLastAct: null,
  _myActSeq: 0,
  _myLastFx: null,
  _myFxSeq: 0,
  _actSentSeq: 0,
  _fxSentSeq: 0,
  _urlRoom: undefined,
  _lastRoom: null,
};

export function backToOnlineLobby() {
  onlineSessionState.onlineGameActive = false;
  const wasSpec = !!onlineSessionState.isSpectator;
  const _matchLive = !!(versusLobbyState.vsActive && !versusLobbyState.vsMatchOver);
  const keepRoomId = onlineSessionState.onlineRoomId;
  onlineSessionState.isOnlineGame = false;
  onlineSessionState.isSpectator = false;
  versusLobbyState.vsActive = false;
  versusLobbyState.vsMatchOver = false;
  onlineSessionState.onlineRemote = new Set();
  onlineSessionState.onlineSlotMap = {};
  onlineSessionState.onlineSlotToPid = {};
  onlineSessionState.onlineGoSent = false;
  document.body.classList.remove(
    "online-play",
    "onlineMulti",
    "onlineMulti3",
    "onlineMulti4",
    "online-spec",
  );
  const op = $("ovOnlinePause");
  if (op) {
    op.classList.add("hidden");
    op.setAttribute("inert", "");
  }
  quitToMenu();
  if (wasSpec) {
    onlineSessionState.onlineRoomId = keepRoomId;
    if (_matchLive) onlineSessionState.onlineGameActive = true;
    showScreen($("ovStart"), "online-lobby");
    showOnlineLobbyUI();
  } else {
    showScreen($("ovStart"), "online-lobby");
    showOnlineLobbyUI();
  }
}

export function markOnlineLeft(pid, bannerTxt) {
  delete onlineSessionState.onlineReadyFlags[pid];
  const st = onlineStationFor(pid);
  if (st && !st.left) {
    st.left = true;
    if (versusLobbyState.vsActive && st.alive) {
      stBanner(st, bannerTxt || "LEFT", "#f5546b", "round");
    }
  }
  updateOnlinePlayerList();
}

export function handleHostDeparture(msg) {
  try {
    const deadHost = (msg && msg.from) || onlineSessionState.onlineHostId;
    if (!deadHost || deadHost === onlineSessionState.myPlayerId) return;
    let present = false,
      deadName = "HOST";
    for (let i = 0; i < onlineSessionState.onlinePlayersList.length; i++) {
      if (onlineSessionState.onlinePlayersList[i].id === deadHost) {
        present = true;
        deadName = onlineSessionState.onlinePlayersList[i].username || "HOST";
        break;
      }
    }
    if (!present) return;
    onlineSessionState.onlinePlayersList = onlineSessionState.onlinePlayersList.filter(
      function (p) {
        return p.id !== deadHost;
      },
    );
    MQ.seen.delete(deadHost);
    MQ.dead.add(deadHost);
    markOnlineLeft(deadHost, deadName + " LEFT");
    let successor = null;
    if (msg && msg.newHost) {
      for (let j = 0; j < onlineSessionState.onlinePlayersList.length; j++) {
        if (onlineSessionState.onlinePlayersList[j].id === msg.newHost) {
          successor = onlineSessionState.onlinePlayersList[j];
          break;
        }
      }
    }
    if (!successor) {
      const players = onlineSessionState.onlinePlayersList.filter(function (p) {
        return !(p.state && p.state.role === "spec");
      });
      successor = players[0] || onlineSessionState.onlinePlayersList[0];
    }
    if (!successor) {
      forcedLeave("The room was closed.");
      return;
    }
    onlineSessionState.onlineHostId = successor.id;
    if (successor.id === onlineSessionState.myPlayerId) {
      onlineSessionState.isOnlineHost = true;
      MQ.isHost = true;
      if (MQ.pingT) {
        clearInterval(MQ.pingT);
        MQ.pingT = null;
      }
      try {
        if (MQ.client && MQ.room) {
          MQ.client.unsubscribe("tzz/" + MQ.room + "/all");
          MQ.client.subscribe("tzz/" + MQ.room + "/host");
        }
      } catch (_) {
        log.debug("net/online-sync.handleHostDeparture", _);
      }
      showEditNote("You are now the HOST");
      relayPushRoster();
      if (game.state === "vsround" && !versusLobbyState.vsMatchOver) {
        clearTimeout(versusLobbyState.vsRoundT);
        versusLobbyState.vsRoundT = setTimeout(hostProgressDecision, 800);
      }
    } else {
      onlineSessionState.isOnlineHost = false;
    }
    renderOnlineLists();
  } catch (e) {
    log.debug("net/online-sync.handleHostDeparture#2", e);
  }
}

export function hostProgressDecision() {
  if (
    !onlineSessionState.isOnlineHost ||
    !onlineSessionState.isOnlineGame ||
    !versusLobbyState.vsRoundOver
  )
    return;
  const w = MP.lastWinner != null ? MP.lastWinner : 0;
  const active = MP.stations.filter((s) => !s.left);
  if (MP.wins[w] >= versusLobbyState.vs.rounds || active.length <= 1) {
    netSend("progress", { kind: "match", winner: w });
    vsMatchEnd(w);
  } else {
    const nr = versusLobbyState.vsRound + 1;
    netSend("progress", { kind: "round", round: nr });
    versusLobbyState.vsRound = nr;
    vsBeginRound();
  }
}

export function sendOnlineState(force) {
  if (!onlineSessionState.isOnlineGame || !versusLobbyState.vsActive) return;
  if (onlineSessionState._rjSuppress !== undefined && onlineSessionState._rjSuppress) return;
  if (onlineSessionState.netMode === "supabase" && !onlineSessionState.onlineChannel) return;
  if (onlineSessionState.isSpectator) return;
  const st = MP.stations[0];
  if (!st) return;
  if (game.state !== "playing" && game.state !== "countdown" && game.state !== "vsround") return;
  const now = clock.now();
  if (now - onlineSyncState._osLastForceT > 4000) force = true;
  if (force) onlineSyncState._osLastForceT = now;
  if (!force && now - onlineSyncState._osLastT < 100) return;
  if (versusLobbyState.vsRound !== onlineSyncState._osLastRound) {
    onlineSyncState._osLastRound = versusLobbyState.vsRound;
    onlineSyncState._osLastSig = "";
    onlineSyncState._osLastBoardHash = -1;
  }
  const bh = boardHash(st.board);
  const p = st.piece;
  const sig =
    bh +
    "|" +
    (p ? p.type + "," + p.rot + "," + p.x + "," + p.y : "-") +
    "|" +
    st.queue.join(",") +
    "|" +
    st.hold +
    "|" +
    (st.holdUsed ? 1 : 0) +
    "|" +
    st.sent +
    "|" +
    st.lines +
    "|" +
    st.score +
    "|" +
    st.pieces +
    "|" +
    (st.alive ? 1 : 0) +
    "|" +
    (onlineSyncState._myLastAct ? onlineSyncState._myLastAct.seq : 0) +
    "|" +
    st.combo +
    "|" +
    st.b2b +
    "|" +
    (onlineSyncState._myLastFx ? onlineSyncState._myLastFx.seq : 0);
  if (!force && sig === onlineSyncState._osLastSig) return;
  onlineSyncState._osLastT = now;
  onlineSyncState._osLastSig = sig;
  const payload = {
    sender: onlineSessionState.myPlayerId,
    round: versusLobbyState.vsRound,
    phase: game.state,
    t: Math.round(versusLobbyState.vsTime),
    sent: st.sent,
    recv: st.recv || 0,
    lines: st.lines,
    score: st.score,
    level: st.level,
    pieces: st.pieces,
    alive: st.alive ? 1 : 0,
    hold: st.hold,
    holdUsed: st.holdUsed ? 1 : 0,
    inc: qCountIdx(0, ["travel", "pending", "active"]),
    piece: p ? { t: p.type, r: p.rot, x: p.x, y: p.y } : 0,
    q: st.queue,
    combo: st.combo,
    b2b: st.b2b,
  };
  if (
    onlineSyncState._myLastAct &&
    onlineSyncState._myLastAct.seq !== onlineSyncState._actSentSeq
  ) {
    payload.act = onlineSyncState._myLastAct;
    onlineSyncState._actSentSeq = onlineSyncState._myLastAct.seq;
  }
  if (onlineSyncState._myLastFx && onlineSyncState._myLastFx.seq !== onlineSyncState._fxSentSeq) {
    payload.fx = onlineSyncState._myLastFx;
    onlineSyncState._fxSentSeq = onlineSyncState._myLastFx.seq;
  }
  if (force || bh !== onlineSyncState._osLastBoardHash) {
    payload.board = st.board;
    onlineSyncState._osLastBoardHash = bh;
  }
  if (onlineSessionState.isOnlineHost) payload.wins = MP.wins;
  try {
    if (
      st.alive &&
      game.state === "playing" &&
      clock.wall() > onlineSessionState._olSelfLockUntil
    ) {
      storage.set(
        "tetris_olself",
        JSON.stringify({
          pid: onlineSessionState.myPlayerId,
          room: onlineSessionState.onlineRoomId,
          seed: onlineSessionState.onlineSeed,
          round: versusLobbyState.vsRound,
          t: Math.round(versusLobbyState.vsTime),
          ptr: MP.ptrs[0],
          board: st.board,
          piece: st.piece
            ? { t: st.piece.type, r: st.piece.rot, x: st.piece.x, y: st.piece.y }
            : null,
          q: st.queue.slice(0, 5),
          hold: st.hold,
          holdUsed: st.holdUsed ? 1 : 0,
          sent: st.sent,
          recv: st.recv || 0,
          lines: st.lines,
          score: st.score,
          level: st.level,
          pieces: st.pieces,
          combo: st.combo,
          b2b: st.b2b,
          ts: clock.wall(),
        }),
      );
    }
  } catch (_) {
    log.debug("net/online-sync.sendOnlineState", _);
  }
  if (st.alive) {
    onlineSessionState._olLastFull[onlineSessionState.myPlayerId] = {
      round: versusLobbyState.vsRound,
      phase: game.state,
      ptr: MP.ptrs[0],
      time: versusLobbyState.vsTime,
      board: st.board,
      piece: st.piece ? { t: st.piece.type, r: st.piece.rot, x: st.piece.x, y: st.piece.y } : null,
      q: st.queue.slice(0, 5),
      hold: st.hold,
      holdUsed: st.holdUsed ? 1 : 0,
      sent: st.sent,
      lines: st.lines,
      score: st.score,
      level: st.level,
      pieces: st.pieces,
      combo: st.combo,
      b2b: st.b2b,
      alive: 1,
      inc: qCountIdx(0, ["travel", "pending", "active"]),
    };
    onlineSessionState._olLastFullAt[onlineSessionState.myPlayerId] = clock.wall();
  }
  netSend("state", payload);
  if (st.alive) onlineSessionState.onlineGoSent = false;
  else if (!onlineSessionState.onlineGoSent) {
    onlineSessionState.onlineGoSent = true;
    netSend("gameover", { sender: onlineSessionState.myPlayerId, rnd: versusLobbyState.vsRound });
  }
}
