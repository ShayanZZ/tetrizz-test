// @ts-nocheck
import { clock } from "../core/clock";
import { fxRandom } from "../core/random";
import { log } from "../core/logger";
import { storage, tabStorage } from "../core/storage";
import { game } from "../game/state";
import { saveSession } from "../game/game";
import { versusLobbyState } from "../versus/lobby";
import { GONE_MS, graceSweep, onlineSessionState, saveLastRoom } from "../net/online-session";
import { netSend } from "../net/transport";
import { MQ, mqRemovePlayer } from "../net/relay";
import { forcedLeave, onlineLobbyState, renderOnlineLists } from "../net/online-lobby";
import { handleHostDeparture, sendOnlineState } from "../net/online-sync";

try {
  onlineSessionState.myPlayerId = tabStorage.get("tetris_pid");
} catch (_) {
  log.debug("boot/30-online-session", _);
}

if (!onlineSessionState.myPlayerId) {
  try {
    onlineSessionState.myPlayerId = storage.get("tetris_pid");
  } catch (_) {
    log.debug("boot/30-online-session#2", _);
  }
}

if (!onlineSessionState.myPlayerId) {
  onlineSessionState.myPlayerId =
    fxRandom().toString(36).substring(2, 10) + clock.wall().toString(36).slice(-4);
}

try {
  storage.set("tetris_pid", onlineSessionState.myPlayerId);
} catch (_) {
  log.debug("boot/30-online-session#3", _);
}

try {
  tabStorage.set("tetris_pid", onlineSessionState.myPlayerId);
} catch (_) {
  log.debug("boot/30-online-session#4", _);
}

setInterval(function () {
  if (onlineSessionState.isOnlineGame) sendOnlineState(false);
  onlineSessionState._schNetAcc += 100;
  onlineSessionState._schKeepAliveAcc += 100;
  onlineSessionState._schSessionAcc += 100;
  onlineSessionState._schMqSweepAcc += 100;
  onlineSessionState._schGraceAcc += 100;

  if (onlineSessionState._schGraceAcc >= 1000) {
    onlineSessionState._schGraceAcc = 0;
    graceSweep();
  }

  if (onlineSessionState._schNetAcc >= 3000) {
    onlineSessionState._schNetAcc = 0;
    if (onlineSessionState.onlineRoomId) {
      netSend("ping", { sender: onlineSessionState.myPlayerId, ts: clock.wall() });
      netSend("hb", { sender: onlineSessionState.myPlayerId });
      saveLastRoom();
      if (!onlineSessionState.isOnlineGame) {
        const ol = document.getElementById("onlineLobby");
        if (ol && ol.style.display !== "none") renderOnlineLists();
      }
    }
  }

  if (onlineSessionState._schSessionAcc >= 3000) {
    onlineSessionState._schSessionAcc = 0;
    if (game.state === "playing" || game.state === "countdown" || game.state === "paused")
      saveSession();
  }

  if (onlineSessionState._schMqSweepAcc >= 6000) {
    onlineSessionState._schMqSweepAcc = 0;
    if (onlineSessionState.netMode === "p2p" && onlineSessionState.onlineRoomId) {
      if (MQ.isHost) {
        const now = clock.wall();
        for (const [pid, t] of MQ.seen) {
          if (now - t > GONE_MS) mqRemovePlayer(pid, true);
        }
      }
      if (
        MQ.joined &&
        MQ.client &&
        !MQ.connected &&
        MQ.downSince &&
        clock.wall() - MQ.downSince > 75000
      )
        forcedLeave("Connection to the room was lost.");
      if (
        MQ.joined &&
        !MQ.isHost &&
        onlineSessionState.isOnlineGame &&
        !versusLobbyState.vsMatchOver &&
        (game.state === "playing" || game.state === "countdown" || game.state === "vsround") &&
        MQ.lastHostMsg &&
        clock.wall() - MQ.lastHostMsg > 90000
      )
        handleHostDeparture({ from: onlineSessionState.onlineHostId });
    }
  }

  if (onlineSessionState._schKeepAliveAcc >= 180000) {
    onlineSessionState._schKeepAliveAcc = 0;
    if (
      onlineSessionState.onlineRoomId &&
      onlineSessionState.sb &&
      onlineSessionState.netMode === "supabase"
    ) {
      const nowIso = new Date().toISOString();
      try {
        onlineSessionState.sb
          .from("players")
          .update({ last_active: nowIso })
          .eq("id", onlineSessionState.myPlayerId)
          .then(function () {});
      } catch (_) {
        log.debug("boot/30-online-session#5", _);
      }
      if (clock.now() - onlineLobbyState._userActT < 10 * 60000) {
        try {
          onlineSessionState.sb
            .from("rooms")
            .update({ last_active: nowIso })
            .eq("id", onlineSessionState.onlineRoomId)
            .then(function () {});
        } catch (_) {
          log.debug("boot/30-online-session#6", _);
        }
      }
    }
  }
}, 100);
