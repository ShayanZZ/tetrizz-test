// @ts-nocheck
import { clock } from "../core/clock";
import { gameRandom } from "../core/random";
import { escapeHtml } from "../core/escape";
import { log, swallow } from "../core/logger";
import { storage, tabStorage } from "../core/storage";
import { intercept, onEvent, onBefore } from "../core/events";
import { bindingsState } from "../input/bindings";
import { game } from "../game/state";
import { SFX } from "../engine/engine";
import { $, layout } from "../ui/layout";
import { openOverlay, saveSession } from "../game/game";
import { askConfirm, syncOnlineBackendToggle } from "../ui/settings";
import { networkConfigReady } from "../net/net-config";
import { MP, giOfSlot, versusLobbyState, vsGarbageMode } from "../versus/lobby";
import { setMpGauges } from "../versus/garbage";
import { onlineSessionState } from "../net/online-session";
import { relaySettings } from "../net/lan";
import { netSend } from "../net/transport";
import { activeBackend } from "../net/room-backend";
import {
  cancelReconnect,
  changeOnlinePwd,
  copyFlash,
  copyText,
  createOnlineRoom,
  hostStart,
  initSupabase,
  joinOnlineRoom,
  leaveOnlineRoom,
  onlineLobbyState,
  retryReconnect,
  startOnlineMatch,
  swapRole,
  toggleReady,
  transferHostTo,
} from "../net/online-lobby";
import {
  backToOnlineLobby,
  hostProgressDecision,
  markOnlineLeft,
  onlineSyncState,
} from "../net/online-sync";
import { AUTO_REJOIN_MS } from "../replay/replay";

["pointerdown", "keydown"].forEach(function (ev) {
  window.addEventListener(
    ev,
    function () {
      onlineLobbyState._userActT = clock.now();
    },
    true,
  );
});

window.addEventListener("pagehide", function () {
  saveSession();
});

intercept("sendAttack", function (from, A) {
  if (!onlineSessionState.isOnlineGame) return false;
  if (!versusLobbyState.vsActive || !vsGarbageMode() || A <= 0 || from !== 0) return true;
  const q = MP.qs[0] || [];
  let left = A;
  for (const ch of q) {
    if (left <= 0) break;
    const take = Math.min(ch.holes.length, left);
    ch.holes.splice(0, take);
    left -= take;
  }
  MP.qs[0] = q.filter((ch) => ch.holes.length > 0);
  if (MP.stations[0]) MP.stations[0].sent += left;
  setMpGauges();
  if (left > 0) {
    const cands = MP.stations.filter(
      (s) => onlineSessionState.onlineRemote.has(s.idx) && s.alive && !s.left,
    );
    if (cands.length) {
      let t;
      const strat =
        versusLobbyState.vs !== undefined && versusLobbyState.vs.target
          ? versusLobbyState.vs.target
          : "random";
      if (strat === "attacker") {
        const src = MP.stations[0];
        t =
          cands.find((s) => s.idx === (src && src.lastAttacker)) ||
          cands[(gameRandom() * cands.length) | 0];
      } else if (strat === "least") {
        t = cands.reduce((a, b) => ((a._olInc || 0) <= (b._olInc || 0) ? a : b));
      } else if (strat === "most") {
        t = cands.reduce((a, b) => ((a._olInc || 0) >= (b._olInc || 0) ? a : b));
      } else if (strat === "lowest") {
        t = cands.reduce((a, b) => {
          const ha = a.board.reduce((s, r) => s + (r.some((v) => v) ? 1 : 0), 0);
          const hb = b.board.reduce((s, r) => s + (r.some((v) => v) ? 1 : 0), 0);
          return ha <= hb ? a : b;
        });
      } else {
        t = cands[(gameRandom() * cands.length) | 0];
      }
      t.lastAttacker = 0;
      SFX.send();
      netSend("attack", {
        sender: onlineSessionState.myPlayerId,
        amount: left,
        target: onlineSessionState.onlineSlotToPid[t.slot],
        t: clock.wall(),
      });
    }
  }
  return true;
});

onBefore("vsRoundEnd", function (w) {
  MP.lastWinner = giOfSlot(w);
});

onEvent("vsRoundEnd", function () {
  if (!onlineSessionState.isOnlineGame) return;
  clearTimeout(versusLobbyState.vsRoundT);
  versusLobbyState.vsRoundT = setTimeout(hostProgressDecision, 2300);
});

onEvent("refreshVs", function () {
  if (
    onlineSessionState.onlineRoomId &&
    onlineSessionState.isOnlineHost &&
    document.getElementById("onlineHostControls") &&
    document.getElementById("onlineHostControls").style.display !== "none"
  ) {
    clearTimeout(onlineSyncState._olSyncT);
    onlineSyncState._olSyncT = setTimeout(() => {
      const settings = relaySettings();
      if (onlineSessionState.netMode === "p2p" || onlineSessionState.netMode === "server") {
        netSend("settings", settings);
      } else if (onlineSessionState.sb) {
        onlineSessionState.sb
          .from("rooms")
          .update({ settings: settings })
          .eq("id", onlineSessionState.onlineRoomId)
          .then(() => {});
      }
    }, 120);
  }
});

intercept("togglePause", function () {
  if (
    (onlineSessionState.isOnlineGame ||
      (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator)) &&
    (game.state === "playing" || game.state === "countdown" || game.state === "vsround")
  ) {
    const op = $("ovOnlinePause");
    if (op && !op.classList.contains("hidden")) {
      op.classList.add("hidden");
      bindingsState.openOverlayEl = null;
      document.body.classList.remove("onlinePaused");
      layout();
      return true;
    }
    const _isSpec = onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator;
    const _plb = document.getElementById("onlinePauseLobbyBtn");
    if (_plb) _plb.style.display = _isSpec ? "" : "none";
    if (op) {
      op.classList.toggle("with-lobby", !!_isSpec);
      try {
        const _row = op.querySelector(".op-row") || op.querySelector(".menu-btns");
        const _lobby = op.querySelector("#onlinePauseLobbyBtn");
        const _leave = op.querySelector("#onlinePauseLeaveBtn");
        if (
          _row &&
          _lobby &&
          _leave &&
          _lobby.parentElement === _row &&
          _leave.parentElement === _row &&
          _lobby.nextElementSibling !== _leave
        ) {
          _row.insertBefore(_lobby, _leave);
        }
      } catch (_) {
        log.debug("boot/34-online-sync", _);
      }
    }
    openOverlay(op);
    document.body.classList.add("onlinePaused");
    return true;
  }
  return false;
});

(function () {
  const lb = document.getElementById("onlinePauseLeaveBtn");
  if (lb)
    lb.addEventListener("click", () => {
      askConfirm("Leave this room and return to menu?", "LEAVE", () => leaveOnlineRoom(true));
    });
  const rb = document.getElementById("onlinePauseResumeBtn");
  if (rb)
    rb.addEventListener("click", () => {
      $("ovOnlinePause").classList.add("hidden");
      bindingsState.openOverlayEl = null;
      document.body.classList.remove("onlinePaused");
      layout();
    });
  const lob = document.getElementById("onlinePauseLobbyBtn");
  if (lob)
    lob.addEventListener("click", () => {
      askConfirm("Stop watching and return to the <b>lobby</b>?", "TO LOBBY", () =>
        backToOnlineLobby(),
      );
    });
})();

document.addEventListener("click", (e) => {
  const t = e.target.closest ? e.target.closest("button") : null;
  if (!t) return;
  if (t.id === "tglOnlinePwd") {
    const on = t.textContent === "OFF";
    t.textContent = on ? "ON" : "OFF";
    t.classList.toggle("off", !on);
    const step = document.getElementById("stepOnlinePwd");
    if (step) step.style.display = on ? "grid" : "none";
    const inp = document.getElementById("onlineRoomPassword");
    if (inp && !on) inp.value = "";
    return;
  }
  if (t.id === "btnCreateRoom") {
    createOnlineRoom();
    return;
  }
  if (t.id === "btnConfirmJoin") {
    joinOnlineRoom(document.getElementById("onlineRoomCodeInput").value);
    return;
  }
  if (t.id === "onlineLeaveBtn") {
    e.preventDefault();
    if (onlineSessionState.onlineRoomId)
      askConfirm("Leave this room and return to menu?", "LEAVE", () => leaveOnlineRoom(true));
    else cancelReconnect();
    return;
  }
  if (t.id === "btnStartOnlineGame") {
    hostStart();
    return;
  }
  if (t.id === "btnWatchNow") {
    const _wSrc =
      onlineSessionState.onlineLiveOrder !== undefined &&
      onlineSessionState.onlineLiveOrder &&
      onlineSessionState.onlineLiveOrder.length
        ? onlineSessionState.onlineLiveOrder
        : onlineSessionState.onlineLocalOrder && onlineSessionState.onlineLocalOrder.length
          ? onlineSessionState.onlineLocalOrder
          : onlineSessionState.onlinePlayersList
              .filter(function (p) {
                return (
                  !(p.state && p.state.role === "spec") && p.id !== onlineSessionState.myPlayerId
                );
              })
              .map(function (p) {
                return p.id;
              });
    const order = _wSrc.filter(function (id) {
      return id !== onlineSessionState.myPlayerId;
    });
    if (order.length) {
      startOnlineMatch(order);
    }
    return;
  }
  if (t.id === "btnCopyCode") {
    copyText(onlineSessionState.onlineRoomId);
    copyFlash(t, "COPIED ✓");
    return;
  }
  if (t.id === "btnShareLink") {
    const url = location.href.split("?")[0] + "?room=" + onlineSessionState.onlineRoomId;
    if (navigator.share) {
      navigator
        .share({
          title: "TetriZZ",
          text: "Join my room " + onlineSessionState.onlineRoomId,
          url: url,
        })
        .catch(swallow("boot/online-sync.promise"));
    } else {
      copyText(url);
      copyFlash(t, "COPIED ✓");
    }
    return;
  }
  if (t.dataset.hostxfer) {
    const hp = (onlineSessionState.onlinePlayersList || []).find(
      (p) => p.id === t.dataset.hostxfer,
    );
    askConfirm(
      "Make <b>" + escapeHtml((hp && hp.username) || "PLAYER") + "</b> the new <b>HOST</b>?",
      "TRANSFER",
      () => transferHostTo(t.dataset.hostxfer),
    );
    return;
  }
  if (t.id === "btnChangePwd") {
    changeOnlinePwd();
    return;
  }
  if (t.dataset.kick) {
    const kp = (onlineSessionState.onlinePlayersList || []).find((p) => p.id === t.dataset.kick);
    askConfirm(
      "Kick <b>" + escapeHtml((kp && kp.username) || "PLAYER") + "</b> from the room?",
      "KICK",
      () => {
        const kid = t.dataset.kick;
        netSend("kick", { target: kid });
        markOnlineLeft(kid, "KICKED");
        activeBackend().kick({
          roomId: onlineSessionState.onlineRoomId,
          myId: onlineSessionState.myPlayerId,
          targetId: kid,
        });
      },
    );
    return;
  }
  if (t.id === "btnReady") {
    toggleReady();
    return;
  }
  if (t.id === "btnToPlayer" || t.id === "btnToSpec") {
    swapRole();
    return;
  }
  if (t.id === "btnCancelReconnect") {
    cancelReconnect();
    return;
  }
  if (t.id === "btnRetryReconnect") {
    retryReconnect();
    return;
  }
});

initSupabase();
networkConfigReady().then(syncOnlineBackendToggle);

onlineSyncState._urlRoom = new URLSearchParams(window.location.search).get("room");

try {
  onlineSyncState._lastRoom = JSON.parse(storage.get("tetris_lastroom"));
} catch (_) {
  log.debug("boot/34-online-sync#3", _);
}
