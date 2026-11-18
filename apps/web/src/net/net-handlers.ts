import { clock } from "../core/clock";
import { quitToMenu, showScreen } from "../game/game";
import { $ } from "../ui/layout";
import { versusLobbyState } from "../versus/lobby";
import { dispatchTo, type HandlerTable } from "./dispatch";
import {
  applyHostXferLocal,
  buildRejoinPayload,
  forcedLeave,
  onNetHostXfer,
  onNetLobbyOk,
  onNetReady,
  onReadyFlags,
  onlineLobbyState,
  onlineStationFor,
  rejoinSucceeded,
  renderOnlineLists,
  showOnlineLobbyUI,
} from "./online-lobby";
import { onNetHb, onNetPing, onNetPong, onNetRejoin, onlineSessionState } from "./online-session";
import {
  MQ,
  onNetAttack,
  onNetGameOver,
  onNetKick,
  onNetLeft,
  onNetProgress,
  onNetRoster,
  onNetSettings,
  onNetStart,
  onNetState,
} from "./relay";
import { netSend } from "./transport";
import type { TransportKind } from "@tetrizz/protocol";

const REJOIN_REQUEST_GAP_MS = 1500;

type PlayerPayload = { sender?: string; order?: unknown; round?: unknown } | null | undefined;

function onNetUnleft(payload: PlayerPayload): void {
  const station = onlineStationFor(payload && payload.sender) as unknown as {
    left: boolean;
    leftByGone: boolean;
    bannerEl?: { textContent: string | null } | null;
  } | null;
  if (!station) return;
  station.left = false;
  station.leftByGone = false;
  if (station.bannerEl) station.bannerEl.textContent = "";
}

/** A player who just arrived or came back asks the people already playing to bring them up to date. */
function onNetRejoinRequest(payload: PlayerPayload): void {
  if (!payload || payload.sender === onlineSessionState.myPlayerId) return;
  const live = onlineSessionState.isOnlineGame && !versusLobbyState.vsMatchOver;
  if (!onlineSessionState.isOnlineHost && !live) return;
  const asker = payload.sender as string;
  const lastAsked = onNetRejoin as unknown as { _rr?: Record<string, number> };
  const now = clock.wall();
  if (lastAsked._rr && lastAsked._rr[asker] && now - lastAsked._rr[asker] < REJOIN_REQUEST_GAP_MS) {
    return;
  }
  if (!lastAsked._rr) lastAsked._rr = {};
  lastAsked._rr[asker] = now;
  if (live) {
    if (onlineSessionState.onlineLocalOrder.indexOf(asker) >= 0) {
      netSend("rejoin", buildRejoinPayload(asker));
    } else {
      netSend("game-active", {
        sender: onlineSessionState.myPlayerId,
        seed: onlineSessionState.onlineSeed,
        order: onlineSessionState.onlineLocalOrder,
        round: versusLobbyState.vsRound,
      });
    }
  } else if (onlineSessionState.isOnlineHost) {
    netSend("lobby-ok", { target: asker });
  }
}

/**
 * Someone says a match is running. Over Supabase a player who is reconnecting is also let back
 * into the lobby by this message; the relay and LAN reconnect through their own messages.
 */
function onNetGameActive(payload: PlayerPayload, endsReconnect: boolean): void {
  if (!payload) return;
  if (payload.sender === onlineSessionState.myPlayerId) return;
  onlineSessionState.onlineGameActive = true;
  if (Array.isArray(payload.order)) onlineSessionState.onlineLiveOrder = payload.order.slice();
  if (
    typeof payload.round === "number" &&
    !onlineSessionState.isOnlineGame &&
    !onlineSessionState.isSpectator
  ) {
    versusLobbyState.vsRound = payload.round;
  }
  if (endsReconnect && onlineLobbyState._autoReconnecting) {
    rejoinSucceeded();
    showOnlineLobbyUI();
    return;
  }
  if (!onlineSessionState.isOnlineGame && !onlineSessionState.isSpectator) {
    const reconnecting = document.getElementById("onlineReconnecting");
    if (reconnecting) reconnecting.style.display = "none";
    const setup = document.getElementById("onlineSetup");
    if (setup) setup.style.display = "none";
    const lobby = document.getElementById("onlineLobby");
    if (lobby) lobby.style.display = "block";
    renderOnlineLists();
  }
}

function onNetMatchOver(): void {
  if (
    onlineSessionState.isOnlineGame === undefined ||
    !(
      onlineSessionState.isOnlineGame ||
      versusLobbyState.vsActive ||
      onlineSessionState.isSpectator
    )
  ) {
    return;
  }
  onlineSessionState.isOnlineGame = false;
  onlineSessionState.isSpectator = false;
  versusLobbyState.vsActive = false;
  versusLobbyState.vsMatchOver = false;
  document.body.classList.remove(
    "online-play",
    "onlineMulti",
    "onlineMulti3",
    "onlineMulti4",
    "online-spec",
    "matchover",
  );
  const pause = $("ovOnlinePause");
  if (pause) {
    pause.classList.add("hidden");
    pause.setAttribute("inert", "");
  }
  quitToMenu();
  showScreen($("ovStart"), "online-lobby");
  showOnlineLobbyUI();
}

function onNetHostResume(payload: { from?: string; gen?: unknown } | null | undefined): void {
  if (!payload || !payload.from || payload.from === onlineSessionState.myPlayerId) return;
  if (typeof payload.gen === "number") {
    (MQ as { hostGenSeen?: number }).hostGenSeen = Math.max(
      (MQ as { hostGenSeen?: number }).hostGenSeen || 0,
      payload.gen,
    );
  }
  applyHostXferLocal(payload.from);
}

/** Game traffic from someone while this player sits in a lobby means a match is already running. */
function noteGameTraffic(payload: PlayerPayload): void {
  try {
    if (
      payload &&
      payload.sender !== onlineSessionState.myPlayerId &&
      !onlineSessionState.isOnlineGame &&
      !versusLobbyState.vsMatchOver &&
      onlineSessionState.onlineRoomId !== undefined &&
      onlineSessionState.onlineRoomId
    ) {
      onlineSessionState.onlineGameActive = true;
      renderOnlineLists();
    }
  } catch (error) {
    void error;
  }
}

function buildTables(): { relay: HandlerTable; supabase: HandlerTable; server: HandlerTable } {
  const shared: HandlerTable = {
    gameover: onNetGameOver,
    left: onNetLeft,
    kick: onNetKick,
    unleft: onNetUnleft,
    start: onNetStart,
    progress: onNetProgress,
    "host-xfer": onNetHostXfer,
    ping: onNetPing,
    pong: onNetPong,
    hb: onNetHb,
    rejoin: onNetRejoin,
    ready: onNetReady,
    "ready-flags": onReadyFlags,
    "rejoin-req": onNetRejoinRequest,
    "match-over": onNetMatchOver,
  };
  const relay: HandlerTable = {
    ...shared,
    attack: onNetAttack,
    state: onNetState,
    roster: onNetRoster,
    settings: onNetSettings,
    "host-resume": onNetHostResume,
    "game-active": (payload) => onNetGameActive(payload, false),
    closed: () => forcedLeave("The host closed the room."),
  };
  return {
    relay,
    // The own server has no messages of its own for coming back, so a player who is reconnecting is
    // let back into the lobby by the host's `lobby-ok` or by anyone's `game-active`, as over Supabase.
    server: {
      ...relay,
      "lobby-ok": onNetLobbyOk,
      "game-active": (payload) => onNetGameActive(payload, true),
    },
    supabase: {
      ...shared,
      attack: (payload) => {
        noteGameTraffic(payload);
        onNetAttack(payload);
      },
      state: (payload) => {
        noteGameTraffic(payload);
        onNetState(payload);
      },
      "lobby-ok": onNetLobbyOk,
      "game-active": (payload) => onNetGameActive(payload, true),
    },
  };
}

let tables: ReturnType<typeof buildTables> | null = null;

/** Runs the game's reaction to an event that arrived on a transport of this kind. */
export function dispatchNetMessage(kind: TransportKind, event: unknown, payload: unknown): void {
  tables ??= buildTables();
  dispatchTo(
    kind === "supabase" ? tables.supabase : kind === "server" ? tables.server : tables.relay,
    event,
    payload,
  );
}
