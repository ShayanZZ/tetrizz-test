// @ts-nocheck
import { clock } from "../core/clock";
import { mulberry32 } from "@tetrizz/core";
import { fxRandom, gameRandom } from "../core/random";
import { PIECES } from "@tetrizz/core";
import { escapeHtml } from "../core/escape";
import { log } from "../core/logger";
import { storage } from "../core/storage";
import { HID, LOCK_MS, clamp, colsForMode, configState, visForMode } from "../core/config";
import { bindingsState } from "../input/bindings";
import { game } from "../game/state";
import {
  CLEARV0,
  CLEARV_PER,
  DROPV,
  SFX,
  collideOn,
  gravMsFor,
  levelForLines,
} from "../engine/engine";
import { $, applyGeometry, layout, layoutSoon } from "../ui/layout";
import { spawnXFor } from "../render/render";
import { hideAllOverlays, quitToMenu, showScreen, syncPad } from "../game/game";
import { askConfirm, showEditNote, showGameAlert } from "../ui/settings";
import { rndHole } from "../ui/screens";
import { PLAYER_COLORS } from "../ui/brand";
import {
  MP,
  buildMpChips,
  clampVs,
  copyRoomRules,
  mpBuildStations,
  qCountIdx,
  refreshVs,
  refreshVsBody,
  versusLobbyState,
  vsGarbageMode,
} from "../versus/lobby";
import { ensureStream, setMpGauges, stTopOut } from "../versus/garbage";
import {
  drawStHold,
  drawStNexts,
  mpBannerAll,
  showStAction,
  stBurstAt,
  stCheckDanger,
  stFxKick,
  stFxSpin,
  stUpdateChips,
  stUpdateStats,
} from "../versus/stations";
import { layoutMp, pingClass, vsBeginRound, vsStartMatch, vsUpdateHud } from "../versus/rounds";
import { clearLastRoom, onlineSessionState, saveLastRoom } from "./online-session";
import { lanCreateRoom, lanJoinRoom, relaySettings } from "./lan";
import { netSend, serverSocket, supabaseTransport } from "./transport";
import { activeBackend, backendOfKind } from "./room-backend";
import { rowIsFresh } from "./backends/supabase-room";
import { createRoomChannelHandlers, listenToRoomRows } from "./backends/supabase-channel";
import { roomBackendKinds } from "./backend-choice";
import { MQ, loadScriptWithSri, mqTopicBase, relayPushRoster } from "./relay";
import { hostProgressDecision, markOnlineLeft, onlineSyncState } from "./online-sync";
import { attemptRejoin } from "../replay/replay";
import { netConfig, networkConfigReady } from "./net-config";

export const onlineLobbyState = {
  _lastRoomAction: 0,
  _autoReconnecting: false,
  _rejoinWatchT: null,
  _rejoinAbort: false,
  _userActT: undefined,
};

async function ensureSupabaseLoaded() {
  if (window.supabase) return;
  try {
    await loadScriptWithSri(netConfig.current.scripts.supabase, null, null);
  } catch (_) {
    log.debug("net/online-lobby.ensureSupabaseLoaded", _);
  }
}

export async function ensureMqttLoaded() {
  if (window.mqtt) return;
  try {
    await loadScriptWithSri(netConfig.current.scripts.mqtt, null, null);
  } catch (_) {
    log.debug("net/online-lobby.ensureMqttLoaded", _);
  }
}

export async function initSupabase() {
  if (onlineSessionState.sb) return;
  try {
    await networkConfigReady();
    const cfg = netConfig.current.supabase;
    if (!cfg) return;
    await ensureSupabaseLoaded();
    if (!window.supabase) return;
    onlineSessionState.sb = window.supabase.createClient(cfg.url, cfg.anonKey);
  } catch (e) {
    onlineSessionState.sb = null;
  }
}

const olName = () => {
  const el = document.getElementById("onlineUsername");
  const v = el && el.value.trim();
  return v || storage.get("tetris_username") || "PLAYER";
};

export function genCode() {
  const cs = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 6; i++) s += cs[(fxRandom() * cs.length) | 0];
  return s;
}

export function pwdHashOf(s) {
  s = String(s == null ? "" : s);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

/** The hash the room's rules carry: of the typed password, or (own server, after a reconnect) the one the server sent. */
export function roomPwdH() {
  if (onlineSessionState.onlineRoomPwd) return pwdHashOf(onlineSessionState.onlineRoomPwd);
  return onlineSessionState.netMode === "server" ? onlineSessionState.onlineRoomPwdH || "" : "";
}

export function pwdOkFor(v) {
  if (onlineSessionState.onlineRoomPwd) return String(v || "") === onlineSessionState.onlineRoomPwd;
  if (onlineSessionState.onlineRoomPwdH) return pwdHashOf(v) === onlineSessionState.onlineRoomPwdH;
  return true;
}

/** A new room's code, seed and the rules a joining player is told. */
function newRoomDraft() {
  const roomId = genCode();
  const seed = Math.floor(gameRandom() * 1e9);
  onlineSessionState.onlineSeed = seed;
  const settings = Object.assign({}, versusLobbyState.vs);
  delete settings.players;
  settings.seed = seed;
  if (onlineSessionState.onlineRoomPwd) settings.pwdH = pwdHashOf(onlineSessionState.onlineRoomPwd);
  return { roomId, settings };
}

function roomRequestBase(roomId) {
  return {
    roomId,
    myId: onlineSessionState.myPlayerId,
    myName: onlineSessionState.onlineMyName,
    now: clock.wall(),
  };
}

/** The backends to try for a new or joined room, for the player's pick in Options. */
const backendKindsToTry = () => roomBackendKinds(netConfig.current, configState.onlineBackend);

function enterCreatedSupabaseRoom(made) {
  onlineSessionState.netMode = "supabase";
  console.info("[TetriZZ net] backend: Supabase Realtime");
  onlineSessionState.onlineRoomId = made.roomId;
  onlineSessionState.onlineHostId = made.hostId;
  onlineSessionState.isOnlineHost = true;
  onlineSessionState.onlineJoinedRoomAt = clock.wall();
  setupOnlineChannel(made.roomId);
  showOnlineLobbyUI();
}

function enterCreatedRelayRoom(made) {
  onlineSessionState.netMode = "p2p";
  onlineSessionState.onlineRoomId = made.roomId;
  onlineSessionState.onlineHostId = made.hostId;
  onlineSessionState.isOnlineHost = true;
  onlineSessionState.isSpectator = false;
  onlineSessionState.onlinePlayersList = [
    {
      id: onlineSessionState.myPlayerId,
      username: onlineSessionState.onlineMyName.toUpperCase(),
      state: { role: "player", joined: clock.wall() },
    },
  ];
  showOnlineLobbyUI();
}

function enterCreatedServerRoom(made) {
  onlineSessionState.netMode = "server";
  console.info("[TetriZZ net] backend: TetriZZ server");
  onlineSessionState.onlineRoomId = made.roomId;
  onlineSessionState.onlineHostId = made.hostId;
  onlineSessionState.isOnlineHost = true;
  onlineSessionState.isSpectator = false;
  onlineSessionState.onlinePlayersList = [
    {
      id: onlineSessionState.myPlayerId,
      username: onlineSessionState.onlineMyName.toUpperCase(),
      state: { role: "player", joined: clock.wall() },
    },
  ];
  showOnlineLobbyUI();
}

export async function createOnlineRoom() {
  if (onlineSessionState.isLanMode !== undefined && onlineSessionState.isLanMode) {
    lanCreateRoom();
    return;
  }
  if (clock.wall() - onlineLobbyState._lastRoomAction < 3000) {
    showEditNote("Please wait before creating another room");
    return;
  }
  onlineLobbyState._lastRoomAction = clock.wall();
  olNote("");
  olBusy("btnCreateRoom", true, "CREATING ROOM…");
  try {
    onlineSessionState.onlineMyName = olName();
    storage.set("tetris_username", onlineSessionState.onlineMyName);
    const pwdBtn = document.getElementById("tglOnlinePwd");
    const pwdOn = !!(pwdBtn && pwdBtn.textContent === "ON");
    const pwEl = document.getElementById("onlineRoomPassword");
    onlineSessionState.onlineRoomPwd = pwdOn && pwEl ? (pwEl.value || "").trim() : "";
    for (const kind of backendKindsToTry()) {
      const draft = newRoomDraft();
      const made = await backendOfKind(kind).create({
        ...roomRequestBase(draft.roomId),
        settings: draft.settings,
        password: onlineSessionState.onlineRoomPwd,
      });
      if (!made.ok) continue;
      if (kind === "supabase") enterCreatedSupabaseRoom(made);
      else if (kind === "server") enterCreatedServerRoom(made);
      else enterCreatedRelayRoom(made);
      return;
    }
    olNote("Failed to create the room. Please try again.", true);
  } catch (_) {
    olNote("Failed to create the room. Please try again.", true);
  } finally {
    olBusy("btnCreateRoom", false);
  }
}

function askRoomPassword(roomId, header, onSubmit) {
  askConfirm(
    header +
      "Room <b>" +
      roomId +
      '</b> is protected.<br><input id="cfPwd" type="password" maxlength="16" class="tp-name" style="margin-top:10px;text-align:center;letter-spacing:2px" placeholder="PASSWORD">',
    "JOIN",
    () => {
      const i = document.getElementById("cfPwd");
      onSubmit(i ? i.value : "");
    },
  );
}

/** Shows why a join ended, for the backend that was tried last (or whose answer is final). */
function showJoinRefusal(roomId, joined, retryWithPassword) {
  olBusy("btnConfirmJoin", false);
  switch (joined.reason) {
    case "unavailable":
      showEditNote("Room not found");
      break;
    case "unreachable":
      olNote("Could not reach any server. Check your connection and try again.", true);
      break;
    case "password":
      askRoomPassword(
        roomId,
        joined.wrongPassword ? '<b style="color:#f5546b">Wrong password!</b><br>' : "",
        (typed) => {
          if (!typed.trim()) return;
          olBusy("btnConfirmJoin", true, "JOINING ROOM…");
          retryWithPassword(typed, joined);
        },
      );
      break;
    case "version":
      showGameAlert(
        "Room <b>" +
          roomId +
          "</b> runs a different version of TetriZZ.<br>Reload the page to update, then try again.",
      );
      break;
    case "not-found":
      clearLastRoom();
      if (onlineLobbyState._autoReconnecting) {
        onlineLobbyState._autoReconnecting = false;
        clearRejoinWatchdog();
        showReconnectPanel(
          "RECONNECT FAILED",
          'Room <b style="color:var(--acchi);letter-spacing:.2em">' +
            escapeHtml(roomId || "") +
            "</b> was not found.",
          roomId,
          true,
          "The room was probably closed. " + RECONNECT_NOTE_CANCEL,
          true,
          true,
        );
      } else olNote("Room not found. Check the code and try again.", true);
      break;
    default:
      showGameAlert("Could not join room <b>" + roomId + "</b>.");
  }
}

function enterJoinedRelayRoom(joined) {
  onlineSessionState.netMode = "p2p";
  onlineSessionState.onlineRoomId = joined.roomId;
  onlineSessionState.onlineHostId = joined.hostId;
  onlineSessionState.isOnlineHost = false;
  onlineSessionState.onlineSeed = joined.seed;
  copyRoomRules(joined.settings);
  if (typeof joined.settings.pwdH === "string")
    onlineSessionState.onlineRoomPwdH = joined.settings.pwdH;
  clampVs();
  showOnlineLobbyUI();
}

function enterJoinedServerRoom(joined) {
  onlineSessionState.netMode = "server";
  console.info("[TetriZZ net] backend: TetriZZ server");
  onlineSessionState.onlineRoomId = joined.roomId;
  onlineSessionState.onlineHostId = joined.hostId;
  onlineSessionState.isOnlineHost = joined.isHost;
  onlineSessionState.isSpectator = false;
  onlineSessionState.onlineSeed = joined.seed;
  copyRoomRules(joined.settings);
  onlineSessionState.onlineRoomPwd = "";
  onlineSessionState.onlineRoomPwdH =
    typeof joined.settings.pwdH === "string" ? joined.settings.pwdH : "";
  clampVs();
  showOnlineLobbyUI();
  if (onlineLobbyState._autoReconnecting)
    netSend("rejoin-req", { sender: onlineSessionState.myPlayerId });
}

function enterJoinedSupabaseRoom(joined) {
  onlineSessionState.netMode = "supabase";
  console.info("[TetriZZ net] backend: Supabase Realtime");
  onlineSessionState.onlineSeed = joined.seed;
  onlineSessionState.onlineHostId = joined.hostId;
  onlineSessionState.onlineJoinedRoomAt = clock.wall();
  copyRoomRules(joined.settings);
  onlineSessionState.onlineRoomPwd = "";
  onlineSessionState.onlineRoomPwdH =
    typeof joined.settings.pwdH === "string" ? joined.settings.pwdH : "";
  clampVs();
  onlineSessionState.onlineRoomId = joined.roomId;
  onlineSessionState.isOnlineHost = joined.isHost;
  setupOnlineChannel(joined.roomId);
  showOnlineLobbyUI();
}

/** Tries one backend. The relay and the own server check a typed password themselves; Supabase leaves it to the player's page. */
function tryJoin(kind, roomId, password, passwordChecked) {
  return backendOfKind(kind).join({
    ...roomRequestBase(roomId),
    password,
    passwordChecked,
  });
}

/** A refusal that says the room exists, so that the other backends are not tried. */
const isFinalRefusal = (joined) => joined.reason === "password" || joined.reason === "version";

async function joinRoomOn(kinds, roomId, password, pwdOk) {
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const last = i === kinds.length - 1;
    if (kind === "relay" && onlineLobbyState._autoReconnecting)
      showReconnectPanel(
        "RECONNECTING…",
        "Room not found on the main server — trying the fallback relay…",
        roomId,
        true,
        "",
        false,
        false,
      );
    const joined = await tryJoin(
      kind,
      roomId,
      kind === "relay" || kind === "server" ? password : "",
      kind === "supabase" && !!pwdOk,
    );
    if (joined.ok) {
      if (kind === "supabase") enterJoinedSupabaseRoom(joined);
      else if (kind === "server") enterJoinedServerRoom(joined);
      else enterJoinedRelayRoom(joined);
      return;
    }
    if (kind === "supabase" && joined.reason === "password") {
      olBusy("btnConfirmJoin", false);
      if (onlineLobbyState._autoReconnecting)
        showReconnectPanel(
          "PASSWORD REQUIRED",
          'Room <b style="color:var(--acchi);letter-spacing:.2em">' +
            escapeHtml(roomId) +
            "</b> is protected.",
          roomId,
          true,
          "Enter the password to rejoin.",
          false,
          false,
        );
      askRoomPassword(roomId, "", (typed) => {
        if (pwdHashOf(typed) === joined.pwdH) joinRoomOn(kinds.slice(i), roomId, "", true);
        else showGameAlert("Wrong password for room <b>" + roomId + "</b>");
      });
      return;
    }
    if (last || isFinalRefusal(joined)) {
      const shown =
        kind === "supabase" && joined.reason === "unavailable"
          ? { ...joined, reason: "unreachable" }
          : joined;
      showJoinRefusal(roomId, shown, (typed) => joinRoomOn(kinds.slice(i), roomId, typed, false));
      return;
    }
    console.info("[TetriZZ net] " + kind + " join incomplete — trying the next backend");
  }
  olNote("Online play is not available here.", true);
  olBusy("btnConfirmJoin", false);
}

export async function joinOnlineRoom(code, pwdOk) {
  if (onlineSessionState.isLanMode !== undefined && onlineSessionState.isLanMode) {
    lanJoinRoom();
    return;
  }
  if (clock.wall() - onlineLobbyState._lastRoomAction < 3000) {
    showEditNote("Please wait before joining another room");
    return;
  }
  const roomId = String(code || "")
    .toUpperCase()
    .trim();
  if (!roomId) {
    olNote("Enter a room code first.", true);
    return;
  }
  onlineLobbyState._lastRoomAction = clock.wall();
  olNote("");
  olBusy("btnConfirmJoin", true, "JOINING ROOM…");
  onlineSessionState.onlineMyName = olName();
  storage.set("tetris_username", onlineSessionState.onlineMyName);
  await joinRoomOn(backendKindsToTry(), roomId, "", pwdOk);
}

export function olBusy(id, busy, label) {
  const b = document.getElementById(id);
  if (!b) return;
  b.classList.toggle("busy", busy);
  b.disabled = busy;
  if (busy) {
    if (!b.dataset.orig) b.dataset.orig = b.textContent;
    b.textContent = label || "PLEASE WAIT…";
  } else if (b.dataset.orig) {
    b.textContent = b.dataset.orig;
    delete b.dataset.orig;
  }
}

export function olNote(msg, err) {
  const n = document.getElementById("onlineStatusNote");
  if (!n) return;
  n.textContent = msg || "";
  n.classList.toggle("err", !!err);
}

export const RECONNECT_NOTE_CANCEL = "You can rejoin manually from MULTI PLAYER → ONLINE.";

export function showReconnectPanel(title, sub, room, showCancel, note, noteErr, showRetry) {
  const rc = document.getElementById("onlineReconnecting");
  if (!rc) return;
  const t = document.getElementById("rcTitle"),
    s = document.getElementById("rcSub"),
    n = document.getElementById("rcNote");
  const retry = document.getElementById("btnRetryReconnect"),
    cancel = document.getElementById("btnCancelReconnect");
  if (t) t.textContent = title || "RECONNECTING…";
  if (s)
    s.innerHTML =
      (room
        ? 'ROOM <b style="color:var(--acchi);letter-spacing:.2em">' + escapeHtml(room) + "</b><br>"
        : "") + (sub || "");
  if (n) {
    n.textContent = note || "";
    n.classList.toggle("err", !!noteErr);
  }
  if (retry) retry.style.display = showRetry ? "" : "none";
  if (cancel) cancel.style.display = showCancel === false ? "none" : "";
  const setup = document.getElementById("onlineSetup"),
    lobby = document.getElementById("onlineLobby");
  if (setup) setup.style.display = "none";
  if (lobby) lobby.style.display = "none";
  rc.style.display = "block";
}

function hideReconnectPanel() {
  const rc = document.getElementById("onlineReconnecting");
  if (rc) rc.style.display = "none";
}

export function clearRejoinWatchdog() {
  if (onlineLobbyState._rejoinWatchT) {
    clearTimeout(onlineLobbyState._rejoinWatchT);
    onlineLobbyState._rejoinWatchT = null;
  }
}

function showReconnectFailed(room) {
  showReconnectPanel(
    "RECONNECT FAILED",
    'Could not reach room <b style="color:var(--acchi);letter-spacing:.2em">' +
      escapeHtml(room || "") +
      "</b>.<br>It may be closed, or the others need a moment.",
    room,
    true,
    "The others may still be connecting — retry in a few seconds.",
    true,
    true,
  );
}

function startRejoinWatchdog(room) {
  clearRejoinWatchdog();
  onlineLobbyState._rejoinWatchT = setTimeout(function () {
    onlineLobbyState._rejoinWatchT = null;
    if (!onlineLobbyState._autoReconnecting) return;
    if (onlineSessionState.isOnlineGame || onlineSessionState.isSpectator) return;
    const rc = document.getElementById("onlineReconnecting");
    if (!rc || rc.style.display === "none") return;
    showReconnectFailed(room);
  }, 12000);
}

export function beginReconnectUI(room, sub) {
  onlineLobbyState._autoReconnecting = true;
  onlineLobbyState._rejoinAbort = false;
  showReconnectPanel(
    "RECONNECTING…",
    sub || "Restoring your match — please wait.",
    room,
    true,
    "",
    false,
    false,
  );
  startRejoinWatchdog(room);
}

export function rejoinSucceeded() {
  onlineLobbyState._autoReconnecting = false;
  clearRejoinWatchdog();
  hideReconnectPanel();
}

export function cancelReconnect() {
  onlineLobbyState._rejoinAbort = true;
  onlineLobbyState._autoReconnecting = false;
  clearRejoinWatchdog();
  hideReconnectPanel();
  clearLastRoom();
  if (onlineSessionState.isOnlineGame || onlineSessionState.isSpectator) return;
  if (onlineSessionState.onlineRoomId) {
    leaveOnlineRoom(false);
  }
  onlineSessionState.onlineRoomId = null;
  onlineSessionState.isOnlineHost = false;
  showScreen($("ovStart"), "online-lobby");
  showOnlineLobbyUI();
}

export function retryReconnect() {
  if (!onlineLobbyState._autoReconnecting) return;
  onlineLobbyState._rejoinAbort = false;
  const room =
    onlineSyncState._lastRoom !== undefined &&
    onlineSyncState._lastRoom &&
    onlineSyncState._lastRoom.room
      ? onlineSyncState._lastRoom.room
      : onlineSessionState.onlineRoomId;
  olBusy("btnConfirmJoin", false);
  olBusy("btnCreateRoom", false);
  beginReconnectUI(room, "Trying again — restoring your match…");
  if (onlineSessionState.netMode === "server" && room) {
    keepRejoiningServerRoom(room);
    return;
  }
  attemptRejoin(onlineSyncState._lastRoom);
}

/** Extra time past the server's grace period before the page gives up on a seat that may still be held. */
const SERVER_REJOIN_MARGIN_MS = 5000;
const SERVER_REJOIN_DELAYS_MS = [1000, 2000, 3000];
let serverRejoinRun = 0;

/**
 * One try at taking a seat in a server room back, with the same player id the server holds it
 * under. `again` means the server could not be reached; any other answer is final and shown.
 */
async function rejoinServerRoom(roomId) {
  const joined = await tryJoin("server", roomId, "", false);
  if (joined.ok) {
    enterJoinedServerRoom(joined);
    return "joined";
  }
  if (joined.reason === "unreachable") return "again";
  showJoinRefusal(roomId, joined, (typed) => joinRoomOn(["server"], roomId, typed, false));
  return "ended";
}

/**
 * Keeps trying to get back into a server room while the server still holds the seat (its grace
 * period, as it announced it) and the player has not cancelled. The server keeps the role, the
 * ready flag and the host role for that time, so a short outage costs nothing.
 */
export function keepRejoiningServerRoom(roomId) {
  clearRejoinWatchdog();
  const run = ++serverRejoinRun;
  const startedAt = clock.wall();
  const windowMs = serverSocket().graceMs() + SERVER_REJOIN_MARGIN_MS;
  let tries = 0;
  const live = () =>
    run === serverRejoinRun &&
    onlineLobbyState._autoReconnecting &&
    !onlineLobbyState._rejoinAbort &&
    !onlineSessionState.leavingRoom;
  const step = async () => {
    if (!live()) return;
    const outcome = await rejoinServerRoom(roomId);
    if (outcome !== "again" || !live()) return;
    if (clock.wall() - startedAt >= windowMs) {
      showReconnectFailed(roomId);
      return;
    }
    const delay = SERVER_REJOIN_DELAYS_MS[Math.min(tries, SERVER_REJOIN_DELAYS_MS.length - 1)];
    tries++;
    setTimeout(step, delay);
  };
  step();
}

export function copyText(str) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str);
      return;
    }
  } catch (_) {
    log.debug("net/online-lobby.copyText", _);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    ta.remove();
  } catch (_) {
    log.debug("net/online-lobby.copyText#2", _);
  }
}

export function copyFlash(btn, txt) {
  if (!btn) return;
  if (btn._cfT) clearTimeout(btn._cfT);
  if (!btn.dataset.orig) btn.dataset.orig = btn.textContent;
  btn.textContent = txt;
  btn.style.color = "var(--green)";
  btn.style.borderColor = "rgba(79,224,138,.6)";
  btn._cfT = setTimeout(function () {
    btn.textContent = btn.dataset.orig;
    delete btn.dataset.orig;
    btn.style.color = "";
    btn.style.borderColor = "";
    btn._cfT = null;
  }, 1400);
}

export function transferHostTo(pid) {
  if (
    !onlineSessionState.isOnlineHost ||
    !onlineSessionState.onlineRoomId ||
    !pid ||
    pid === onlineSessionState.myPlayerId
  )
    return;
  activeBackend().setHost({
    roomId: onlineSessionState.onlineRoomId,
    myId: onlineSessionState.myPlayerId,
    newHost: pid,
  });
  netSend("host-xfer", { newHost: pid, from: onlineSessionState.myPlayerId });
  applyHostXferLocal(pid);
}

export function applyHostXferLocal(nh) {
  if (!nh) return;
  if (nh === onlineSessionState.myPlayerId && onlineSessionState.isOnlineHost) return;
  if (
    nh !== onlineSessionState.myPlayerId &&
    nh === onlineSessionState.onlineHostId &&
    !onlineSessionState.isOnlineHost
  )
    return;
  onlineSessionState.onlineHostId = nh;
  const viaBroker = onlineSessionState.netMode !== "server";
  if (nh === onlineSessionState.myPlayerId) {
    onlineSessionState.isOnlineHost = true;
    if (viaBroker) MQ.isHost = true;
    if (MQ.pingT) {
      clearInterval(MQ.pingT);
      MQ.pingT = null;
    }
    try {
      if (MQ.client && MQ.room) {
        MQ.client.unsubscribe(mqTopicBase() + "/all");
        MQ.client.subscribe(mqTopicBase() + "/host");
      }
    } catch (_) {
      log.debug("net/online-lobby.applyHostXferLocal", _);
    }
    showEditNote("You are now the HOST");
    if (viaBroker) relayPushRoster();
    else renderOnlineLists();
    if (game.state === "vsround" && !versusLobbyState.vsMatchOver) {
      clearTimeout(versusLobbyState.vsRoundT);
      versusLobbyState.vsRoundT = setTimeout(hostProgressDecision, 800);
    }
  } else {
    onlineSessionState.isOnlineHost = false;
    if (viaBroker) MQ.isHost = false;
    try {
      if (MQ.client && MQ.room) {
        MQ.client.unsubscribe(mqTopicBase() + "/host");
        MQ.client.subscribe(mqTopicBase() + "/all");
      }
    } catch (_) {
      log.debug("net/online-lobby.applyHostXferLocal#2", _);
    }
    if (viaBroker && MQ.room && !MQ.pingT) {
      MQ.pingT = setInterval(function () {
        if (MQ.client && MQ.connected && MQ.room) {
          try {
            MQ.client.publish(
              mqTopicBase() + "/host",
              JSON.stringify({ t: "ping", from: onlineSessionState.myPlayerId }),
            );
          } catch (_) {
            log.debug("net/online-lobby.applyHostXferLocal#3", _);
          }
        }
      }, 6000);
    }
    renderOnlineLists();
  }
}

export function onNetHostXfer(p) {
  p = p || {};
  if (!p.newHost) return;
  applyHostXferLocal(p.newHost);
}

export function toggleReady() {
  const _n = clock.wall();
  if (toggleReady._at && _n - toggleReady._at < 300) return;
  const me = onlineSessionState.onlinePlayersList.find(
    (p) => p.id === onlineSessionState.myPlayerId,
  );
  const r = !(
    (me && me.state && me.state.ready) ||
    onlineSessionState.onlineReadyFlags[onlineSessionState.myPlayerId]
  );
  toggleReady._at = _n;
  onlineSessionState.onlineReadyFlags[onlineSessionState.myPlayerId] = r;
  if (me) {
    if (!me.state) me.state = {};
    me.state.ready = r;
  }
  netSend("ready", { sender: onlineSessionState.myPlayerId, ready: r });
  if (me) activeBackend().saveMyState({ myId: onlineSessionState.myPlayerId, state: me.state });
  renderOnlineLists();
}

export function onNetLobbyOk(p) {
  if (!p || p.target !== onlineSessionState.myPlayerId) return;
  if (!onlineLobbyState._autoReconnecting) return;
  onlineLobbyState._autoReconnecting = false;
  clearRejoinWatchdog();
  hideReconnectPanel();
  showOnlineLobbyUI();
}

export function onNetReady(p) {
  if (!p || p.sender == null || !onlineSessionState.isOnlineHost) return;
  onlineSessionState.onlineReadyFlags[p.sender] = !!p.ready;
  const _rp = onlineSessionState.onlinePlayersList.find(function (q) {
    return q.id === p.sender;
  });
  if (_rp) {
    if (!_rp.state) _rp.state = {};
    _rp.state.ready = !!p.ready;
  }
  netSend("ready-flags", { flags: onlineSessionState.onlineReadyFlags });
  renderOnlineLists();
}

export function onReadyFlags(p) {
  if (!p || !p.flags || onlineSessionState.isOnlineHost) return;
  const _merged = Object.assign({}, onlineSessionState.onlineReadyFlags, p.flags);
  if (toggleReady._at && clock.wall() - toggleReady._at < 2500)
    _merged[onlineSessionState.myPlayerId] =
      !!onlineSessionState.onlineReadyFlags[onlineSessionState.myPlayerId];
  onlineSessionState.onlineReadyFlags = _merged;
  renderOnlineLists();
}

/**
 * The own server's roster is the truth about who is in the room, who hosts and who is ready, and
 * the host's page gets it too. A change of host that the page has not heard of yet is applied.
 */
export function applyServerRoster(p) {
  if (!p || !Array.isArray(p.players)) return;
  onlineSessionState.onlinePlayersList = p.players;
  const flags = {};
  for (const seat of p.players) flags[seat.id] = !!(seat.state && seat.state.ready);
  const me = onlineSessionState.myPlayerId;
  if (toggleReady._at && clock.wall() - toggleReady._at < 2500)
    flags[me] = !!onlineSessionState.onlineReadyFlags[me];
  onlineSessionState.onlineReadyFlags = flags;
  if (typeof p.host === "string" && p.host) applyHostXferLocal(p.host);
  renderOnlineLists();
  updateOnlinePlayerList();
}

export function resetOnlineReady() {
  onlineSessionState.onlineReadyFlags = {};
  for (const _p of onlineSessionState.onlinePlayersList) {
    if (_p.state) _p.state.ready = false;
  }
  if (onlineSessionState.netMode === "server" && onlineSessionState.onlineRoomId) {
    const _srvMe = onlineSessionState.onlinePlayersList.find(function (p) {
      return p.id === onlineSessionState.myPlayerId;
    });
    activeBackend().saveMyState({
      myId: onlineSessionState.myPlayerId,
      state: Object.assign({}, _srvMe && _srvMe.state ? _srvMe.state : {}, { ready: false }),
    });
  }
  if (
    onlineSessionState.netMode === "supabase" &&
    onlineSessionState.sb &&
    onlineSessionState.onlineRoomId
  ) {
    const _meRow = onlineSessionState.onlinePlayersList.find(function (p) {
      return p.id === onlineSessionState.myPlayerId;
    });
    const _meSt = _meRow && _meRow.state ? Object.assign({}, _meRow.state) : {};
    _meSt.ready = false;
    try {
      onlineSessionState.sb
        .from("players")
        .update({ state: _meSt })
        .eq("id", onlineSessionState.myPlayerId)
        .then(function () {});
    } catch (_) {
      log.debug("net/online-lobby.resetOnlineReady", _);
    }
  }
}

export function changeOnlinePwd() {
  if (!onlineSessionState.isOnlineHost || !onlineSessionState.onlineRoomId) return;
  askConfirm(
    'Set a new room password.<br>Leave empty to <b>remove</b> it.<br><input id="cfNewPwd" type="text" maxlength="16" class="tp-name" style="margin-top:10px;text-align:center;letter-spacing:2px" placeholder="PASSWORD" value="' +
      (onlineSessionState.onlineRoomPwd || "") +
      '">',
    "SAVE",
    function () {
      const i = document.getElementById("cfNewPwd");
      onlineSessionState.onlineRoomPwd = i ? (i.value || "").trim() : "";
      if (onlineSessionState.netMode === "server")
        onlineSessionState.onlineRoomPwdH = onlineSessionState.onlineRoomPwd
          ? pwdHashOf(onlineSessionState.onlineRoomPwd)
          : "";
      const settings = relaySettings();
      if (onlineSessionState.netMode === "supabase" && onlineSessionState.sb) {
        try {
          onlineSessionState.sb
            .from("rooms")
            .update({ settings: settings })
            .eq("id", onlineSessionState.onlineRoomId)
            .then(() => {});
        } catch (_) {
          log.debug("net/online-lobby.changeOnlinePwd", _);
        }
      }
      const backend = activeBackend();
      if (onlineSessionState.netMode === "server" && backend.setPassword) {
        backend.setPassword({
          roomId: onlineSessionState.onlineRoomId,
          myId: onlineSessionState.myPlayerId,
          password: onlineSessionState.onlineRoomPwd,
          settings,
        });
      } else netSend("settings", settings);
      showEditNote(onlineSessionState.onlineRoomPwd ? "Password updated" : "Password removed");
      renderOnlineLists();
    },
  );
}

export function showOnlineLobbyUI() {
  olBusy("btnCreateRoom", false);
  olBusy("btnConfirmJoin", false);
  olNote("");
  saveLastRoom();
  const setup = document.getElementById("onlineSetup"),
    lobby = document.getElementById("onlineLobby");
  const rc = document.getElementById("onlineReconnecting");
  const _rcOn = _isReconnecting();
  if (rc) rc.style.display = _rcOn ? "block" : "none";
  if (setup) setup.style.display = !onlineSessionState.onlineRoomId && !_rcOn ? "flex" : "none";
  if (lobby) lobby.style.display = onlineSessionState.onlineRoomId && !_rcOn ? "block" : "none";
  if (_rcOn) {
    const _rs = document.getElementById("rcSub");
    if (_rs)
      _rs.innerHTML =
        (onlineSessionState.onlineRoomId
          ? 'ROOM <b style="color:var(--acchi);letter-spacing:.2em">' +
            onlineSessionState.onlineRoomId +
            "</b><br>"
          : "") + "Waiting for the match state…";
    if (!showOnlineLobbyUI._fbT) {
      showOnlineLobbyUI._fbT = setTimeout(function () {
        showOnlineLobbyUI._fbT = null;
        if (_isReconnecting()) {
          if (onlineLobbyState._autoReconnecting !== undefined)
            onlineLobbyState._autoReconnecting = false;
          clearRejoinWatchdog();
          showOnlineLobbyUI();
        }
      }, 8000);
    }
  }
  const c = document.getElementById("displayRoomCode");
  if (c) c.textContent = onlineSessionState.onlineRoomId || "----";
  const lv = document.getElementById("onlineLeaveBtn");
  if (lv) lv.style.display = onlineSessionState.onlineRoomId ? "" : "none";
  renderOnlineLists();
  refreshVs();
  if (onlineSessionState.onlineRoomId) updateOnlinePlayerList();
}

export function renderOnlineLists() {
  const pe = document.getElementById("onlinePlayerList"),
    se = document.getElementById("onlineSpecList");
  if (!pe) return;
  for (const _p of onlineSessionState.onlinePlayersList) {
    if (_p.id !== onlineSessionState.myPlayerId && onlineSessionState.onlineSeen[_p.id] == null)
      onlineSessionState.onlineSeen[_p.id] = clock.wall();
  }
  const players = onlineSessionState.onlinePlayersList.filter(
    (p) => !(p.state && p.state.role === "spec"),
  );
  const specs = onlineSessionState.onlinePlayersList.filter(
    (p) => p.state && p.state.role === "spec",
  );
  const iAmSpec = specs.some((p) => p.id === onlineSessionState.myPlayerId);
  const _rlGL =
    versusLobbyState.vsActive !== undefined &&
    versusLobbyState.vsActive &&
    !versusLobbyState.vsMatchOver &&
    onlineSessionState.isOnlineGame !== undefined &&
    onlineSessionState.isOnlineGame;
  const _rlSig = [
    onlineSessionState.onlineHostId || "",
    onlineSessionState.isOnlineHost ? 1 : 0,
    _rlGL ? 1 : 0,
    onlineSessionState.onlineGameActive ? 1 : 0,
    iAmSpec ? 1 : 0,
    onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame ? 1 : 0,
    players.length >= 4 ? 1 : 0,
    onlineSessionState.onlineRoomPwd ? "w" : onlineSessionState.onlineRoomPwdH ? "h" : "",
    players
      .map(function (p) {
        return (
          p.id +
          "." +
          ((p.state && p.state.role) || "p") +
          "." +
          ((p.state && p.state.ready) || onlineSessionState.onlineReadyFlags[p.id] ? 1 : 0) +
          "." +
          ((p.state && p.state.conn) || (p.state && p.state.away ? "lost" : "-"))
        );
      })
      .join(","),
    specs
      .map(function (p) {
        return p.id;
      })
      .join(","),
  ].join("|");
  if (_rlSig === renderOnlineLists._sig && pe.innerHTML !== "") return;
  renderOnlineLists._sig = _rlSig;

  const gameLive =
    ((onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame) ||
      onlineSessionState.onlineGameActive) &&
    !versusLobbyState.vsMatchOver;
  const progressBox = document.getElementById("onlineProgressBox");
  if (progressBox) {
    if (
      (gameLive && onlineSessionState.isSpectator) ||
      (onlineSessionState.onlineGameActive && !onlineSessionState.isOnlineGame)
    ) {
      progressBox.style.display = "block";
      progressBox.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;gap:10px">' +
        "<div style=\"color:var(--gold);font:700 15px/1.3 'Chakra Petch',sans-serif;letter-spacing:.12em;text-shadow:0 0 12px rgba(255,210,63,.4)\">⚡ MATCH IN PROGRESS</div>" +
        "<div style=\"color:var(--mut2);font:500 12px/1.5 'IBM Plex Mono',monospace;text-align:center\">A game is currently being played.<br>You can watch it live as a spectator.</div>" +
        '<button class="menu-btn primary" id="btnWatchNow" type="button" style="width:auto;padding:12px 28px;font-size:13px;margin-top:4px">▶ WATCH MATCH</button>' +
        "</div>";
    } else {
      progressBox.style.display = "none";
      progressBox.innerHTML = "";
    }
  }

  const row = (p, isSpectatorRow) => {
    const me = p.id === onlineSessionState.myPlayerId;
    const isHost = p.id === onlineSessionState.onlineHostId;
    let slot =
      onlineSessionState.onlineSlotMap !== undefined &&
      onlineSessionState.onlineSlotMap &&
      onlineSessionState.onlineSlotMap[p.id] != null
        ? onlineSessionState.onlineSlotMap[p.id]
        : undefined;
    if (slot === undefined || slot < 0) slot = !isSpectatorRow ? players.indexOf(p) : -1;
    const slotColor = slot >= 0 && slot < PLAYER_COLORS.length ? PLAYER_COLORS[slot] : null;

    const conn = (p.state && p.state.conn) || (p.state && p.state.away ? "lost" : "");
    let connDot = "";
    if (conn === "lost")
      connDot =
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ff9f43;margin-right:6px;box-shadow:0 0 8px #ff9f43;animation:lpulse 1s ease-in-out infinite" title="Reconnecting…"></span>';
    else if (conn === "gone")
      connDot =
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f5546b;margin-right:6px;box-shadow:0 0 8px #f5546b" title="Disconnected"></span>';

    const nameStyle = slotColor
      ? "color:" +
        slotColor +
        ";font-weight:700;letter-spacing:.06em;text-shadow:0 0 10px " +
        slotColor +
        "55;"
      : "color:var(--txt);font-weight:600;";
    const youTag = me
      ? '<span style="color:var(--mut2);font-weight:500;margin-left:6px;font-size:10px;letter-spacing:.12em">(YOU)</span>'
      : "";
    const hostTag = isHost
      ? '<span class="bchip" style="color:var(--gold);border-color:rgba(255,210,63,.5);padding:2px 8px;font-size:10px;letter-spacing:.1em;line-height:1;margin-left:6px">★ HOST</span>'
      : "";

    const pingChip =
      !me && onlineSessionState.onlinePing[p.id] != null
        ? '<span class="mpc-ping ' +
          pingClass(Math.round(onlineSessionState.onlinePing[p.id])) +
          '" data-pingid="' +
          escapeHtml(p.id) +
          '" style="display:inline-flex;align-items:center;margin-left:6px;font-size:10px"> · ' +
          Math.round(onlineSessionState.onlinePing[p.id]) +
          "ms</span>"
        : "";

    let statusChip = "";
    if (!isSpectatorRow) {
      const _rowLive =
        gameLive &&
        (onlineSessionState.onlineLiveOrder.length > 0
          ? onlineSessionState.onlineLiveOrder.indexOf(p.id) >= 0
          : isHost || !me);
      if (_rowLive) {
        statusChip =
          '<span class="bchip" style="color:#2a93a8;border-color:rgba(42,147,168,.5);padding:2px 9px;font-size:10px;letter-spacing:.1em;line-height:1">IN GAME</span>';
      } else if (
        !isHost &&
        ((p.state && p.state.ready) || onlineSessionState.onlineReadyFlags[p.id])
      ) {
        statusChip =
          '<span class="bchip" style="color:var(--green);border-color:rgba(79,224,138,.5);padding:2px 9px;font-size:10px;letter-spacing:.1em;line-height:1">✓ READY</span>';
      } else if (!isHost) {
        statusChip =
          '<span class="bchip" style="color:var(--mut);border-style:dashed;padding:2px 9px;font-size:10px;letter-spacing:.1em;line-height:1">NOT READY</span>';
      }
    }

    let actions = "";
    if (onlineSessionState.isOnlineHost && !me) {
      actions +=
        '<button class="swap-btn" data-hostxfer="' +
        escapeHtml(p.id) +
        '" title="Transfer host">★</button>';
      actions +=
        '<button class="kick-btn" data-kick="' +
        escapeHtml(p.id) +
        '" title="Kick player">✕</button>';
    } else if (!onlineSessionState.isOnlineHost && me && !isSpectatorRow && !gameLive) {
      const isReady = !!((p.state && p.state.ready) || onlineSessionState.onlineReadyFlags[p.id]);
      actions +=
        '<button class="swap-btn" id="btnReady" style="background:' +
        (isReady ? "var(--green)" : "var(--chip-bg)") +
        ";color:" +
        (isReady ? "#fff" : "var(--txt)") +
        ";border-color:" +
        (isReady ? "var(--green)" : "var(--line)") +
        ';padding:6px 14px;font-weight:700;letter-spacing:.1em">' +
        (isReady ? "✓ READY" : "READY") +
        "</button>";
    }

    return (
      '<div class="bindrow" style="padding:10px 14px;margin-bottom:8px;border:1px solid var(--line);border-radius:10px;background:var(--chip-bg);border-left:3px solid ' +
      (slotColor || "var(--line)") +
      '">' +
      '<span class="bl" style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0">' +
      connDot +
      '<span style="' +
      nameStyle +
      '">' +
      escapeHtml(p.username || "PLAYER") +
      "</span>" +
      youTag +
      hostTag +
      pingChip +
      statusChip +
      "</span>" +
      '<span class="bchips" style="align-items:center;gap:4px">' +
      actions +
      "</span>" +
      "</div>"
    );
  };

  pe.innerHTML =
    '<div style="font:700 11px/1 "Chakra Petch",sans-serif;letter-spacing:.18em;color:var(--grp);text-transform:uppercase;margin:6px 0 8px;padding:0 4px;display:flex;align-items:center;gap:8px"><span style="width:6px;height:6px;border-radius:2px;background:var(--grp);box-shadow:0 0 8px var(--grp)"></span>PLAYERS (' +
    players.length +
    "/4)</div>" +
    (players.map((p) => row(p, false)).join("") ||
      '<div class="dev-note" style="padding:8px 12px">—</div>');
  se.innerHTML =
    '<div style="font:700 11px/1 "Chakra Petch",sans-serif;letter-spacing:.18em;color:var(--mut2);text-transform:uppercase;margin:14px 0 8px;padding:0 4px;display:flex;align-items:center;gap:8px"><span style="width:6px;height:6px;border-radius:2px;background:var(--mut2);box-shadow:0 0 6px var(--mut2)"></span>SPECTATORS (' +
    specs.length +
    ")</div>" +
    (specs.map((p) => row(p, true)).join("") ||
      '<div class="dev-note" style="padding:8px 12px;color:var(--mut)">No spectators</div>');

  const btp = document.getElementById("btnToPlayer");
  if (btp) {
    btp.style.display = iAmSpec ? "block" : "none";
    btp.disabled = players.length >= 4;
  }
  const bts = document.getElementById("btnToSpec");
  if (bts) {
    bts.style.display = iAmSpec ? "none" : "block";
    bts.disabled = players.length <= 1;
  }
  const sb2 = document.getElementById("btnStartOnlineGame");
  if (sb2) {
    sb2.style.display = onlineSessionState.isOnlineHost ? "block" : "none";
    sb2.textContent = "START MATCH";
    sb2.disabled =
      !onlineSessionState.isOnlineHost || _isReconnecting() || onlineSessionState.onlineGameActive;
  }
  const wm = document.getElementById("onlineWaitingMsg");
  if (wm) wm.style.display = onlineSessionState.isOnlineHost ? "none" : "block";
  const hc = document.getElementById("onlineHostControls");
  if (hc) {
    hc.style.display = "block";
    hc.classList.toggle("host-disabled", !onlineSessionState.isOnlineHost || _isReconnecting());
  }
  const pwBox = document.getElementById("olPwdBox");
  if (pwBox) {
    pwBox.style.display =
      onlineSessionState.isOnlineHost ||
      onlineSessionState.onlineRoomPwd ||
      onlineSessionState.onlineRoomPwdH
        ? "block"
        : "none";
    const pwTxt = document.getElementById("displayRoomPwd");
    if (pwTxt)
      pwTxt.textContent = onlineSessionState.onlineRoomPwd
        ? onlineSessionState.onlineRoomPwd
        : onlineSessionState.onlineRoomPwdH
          ? "••••••"
          : "NONE";
    const cpb = document.getElementById("btnChangePwd");
    if (cpb) cpb.style.display = onlineSessionState.isOnlineHost ? "" : "none";
  }
  document
    .querySelectorAll("#onlinePlayerList button,#onlineSpecList button")
    .forEach((b) => b.setAttribute("tabindex", "-1"));
}

export async function updateOnlinePlayerList() {
  if (
    onlineSessionState.netMode === "p2p" ||
    onlineSessionState.netMode === "lan" ||
    onlineSessionState.netMode === "server"
  ) {
    renderOnlineLists();
    return;
  }
  if (!onlineSessionState.onlineRoomId || !onlineSessionState.sb) return;
  const { data: players } = await onlineSessionState.sb
    .from("players")
    .select("username,id,state")
    .eq("room_id", onlineSessionState.onlineRoomId);
  if (players)
    onlineSessionState.onlinePlayersList = players.slice().sort(function (a, b) {
      const _ah = a.id === onlineSessionState.onlineHostId ? 0 : 1,
        _bh = b.id === onlineSessionState.onlineHostId ? 0 : 1;
      if (_ah !== _bh) return _ah - _bh;
      return ((a.state && a.state.joined) || 0) - ((b.state && b.state.joined) || 0);
    });
  renderOnlineLists();
}

function setupOnlineChannel(roomId) {
  if (onlineSessionState.onlineChannel) {
    try {
      onlineSessionState.sb.removeChannel(onlineSessionState.onlineChannel);
    } catch (_) {
      log.debug("net/online-lobby.setupOnlineChannel", _);
    }
    onlineSessionState.onlineChannel = null;
  }
  const handlers = createRoomChannelHandlers({
    roomId,
    session: onlineSessionState,
    match: versusLobbyState,
    gameState: () => game.state,
    now: () => clock.wall(),
    lastReadyToggleAt: () => toggleReady._at,
    later: (task, ms) => setTimeout(task, ms),
    cancel: (timer) => clearTimeout(timer),
    send: netSend,
    rejoinPayload: buildRejoinPayload,
    forcedLeave,
    markLeft: markOnlineLeft,
    refreshPlayers: updateOnlinePlayerList,
    claimHost: claimHostIfNext,
    deleteRoomIfEmpty: maybeDeleteEmptyRoom,
    renderLists: renderOnlineLists,
    note: showEditNote,
    hostDecides: hostProgressDecision,
    applyRules: () => {
      clampVs();
      refreshVsBody();
    },
    startMatch: startOnlineMatch,
  });
  onlineSessionState.onlineChannel = supabaseTransport()
    .attach(listenToRoomRows(onlineSessionState.sb.channel("room:" + roomId), roomId, handlers))
    .subscribe(handlers.onStatus);
  updateOnlinePlayerList();
}

export function onlineStationFor(pid) {
  const slot = onlineSessionState.onlineSlotMap ? onlineSessionState.onlineSlotMap[pid] : undefined;
  if (slot === undefined) return null;
  return MP.stations.find((s) => s.slot === slot) || null;
}

function onlineAdvanceSnapshot(lf, elAt) {
  if (lf.phase && lf.phase !== "playing") elAt = 0;
  const bd = Array.isArray(lf.board)
    ? lf.board.map(function (row) {
        return row.slice();
      })
    : null;
  let pc =
    lf.piece && typeof lf.piece === "object"
      ? { t: lf.piece.t, r: lf.piece.r, x: lf.piece.x, y: lf.piece.y }
      : null;
  const q = Array.isArray(lf.q) ? lf.q.slice() : [];
  let tm = typeof lf.t === "number" ? lf.t : versusLobbyState.vsTime;
  let lines = lf.lines || 0,
    level = lf.level || 1,
    alive = lf.alive != null ? lf.alive : 1;
  let remain = Math.max(0, elAt),
    guard = 0,
    _lk = 0;
  function _gmsAt() {
    if (vsGarbageMode()) {
      const G =
        versusLobbyState.vs.grav +
        (tm > versusLobbyState.vs.gravMargin
          ? (versusLobbyState.vs.gInc * (tm - versusLobbyState.vs.gravMargin)) / 1000
          : 0);
      return Math.max(25, 1000 / (60 * G));
    }
    return gravMsFor("vsbot", level);
  }
  while (remain > 0 && guard++ < 400 && alive) {
    if (!pc) {
      if (!q.length) {
        tm += remain;
        remain = 0;
        break;
      }
      const _nt = q.shift();
      pc = { t: _nt, r: 0, x: spawnXFor(_nt), y: 0 };
      if (collideOn(bd, PIECES[_nt].cells[0], pc.x, pc.y)) {
        alive = 0;
        pc = null;
        break;
      }
      continue;
    }
    const _gm = Math.max(20, _gmsAt());
    const _cells = PIECES[pc.t].cells[pc.r];
    let _falling = true;
    while (_falling && remain > 0) {
      if (!collideOn(bd, _cells, pc.x, pc.y + 1)) {
        pc.y++;
        remain -= _gm;
        tm += _gm;
      } else {
        _falling = false;
      }
    }
    if (remain <= 0) break;
    if (remain < LOCK_MS) break;
    remain -= LOCK_MS;
    tm += LOCK_MS;
    for (let _qi = 0; _qi < _cells.length; _qi++) {
      const _X = pc.x + _cells[_qi][0],
        _Y = pc.y + _cells[_qi][1];
      if (_Y >= 0 && _Y < bd.length && _X >= 0 && _X < bd[_Y].length) bd[_Y][_X] = pc.t + 1;
    }
    const _full = [];
    for (let _yy = 0; _yy < bd.length; _yy++) {
      if (
        bd[_yy].every(function (v) {
          return v;
        })
      )
        _full.push(_yy);
    }
    if (_full.length) {
      for (let _fi = 0; _fi < _full.length; _fi++) {
        bd.splice(_full[_fi], 1);
        bd.unshift(Array(configState.COLS).fill(0));
      }
      lines += _full.length;
    }
    const _nl = levelForLines("vsbot", lines);
    if (_nl > level) level = _nl;
    _lk++;
    pc = null;
  }
  const _origQLen = Array.isArray(lf.q) ? lf.q.length : 5;
  let _qConsumed = _origQLen - q.length;
  if (_qConsumed > 0 && typeof lf.ptr === "number") {
    ensureStream(lf.ptr + _origQLen + _qConsumed + 2);
    for (let _ri = 0; _ri < _qConsumed; _ri++) {
      q.push(versusLobbyState.sharedStream[lf.ptr + _origQLen + _ri]);
    }
  }
  if (!pc && q.length > 0 && alive) {
    const _nt2 = q.shift();
    pc = { t: _nt2, r: 0, x: spawnXFor(_nt2), y: 0, lockT: 0 };
    if (collideOn(bd, PIECES[_nt2].cells[0], pc.x, pc.y)) {
      alive = 0;
      pc = null;
    } else {
      _qConsumed++;
      if (typeof lf.ptr === "number") {
        ensureStream(lf.ptr + _origQLen + _qConsumed + 2);
        while (q.length < 5) {
          q.push(versusLobbyState.sharedStream[lf.ptr + _origQLen + _qConsumed - 1]);
          break;
        }
      }
    }
  }
  return {
    round: lf.round,
    time: tm,
    board: bd,
    piece: pc,
    q: q.slice(0, 5),
    ptr: typeof lf.ptr === "number" ? lf.ptr + _qConsumed : undefined,
    hold: lf.hold != null ? lf.hold : null,
    holdUsed: lf.holdUsed ? 1 : 0,
    sent: lf.sent || 0,
    recv: lf.recv || 0,
    lines: lines,
    score: lf.score || 0,
    level: level,
    pieces: lf.pieces || 0,
    combo: typeof lf.combo === "number" ? lf.combo : -1,
    b2b: lf.b2b || 0,
    alive: alive,
    inc: lf.inc || 0,
  };
}

export function onlineFullStateFor(pid) {
  const _lf = onlineSessionState._olLastFull[pid];
  const st = onlineStationFor(pid);
  const _ofsPl = onlineSessionState.onlinePlayersList.find(function (q) {
    return q.id === pid;
  });
  let _ofsStale = !!(
    _ofsPl &&
    _ofsPl.state &&
    (_ofsPl.state.conn === "lost" || _ofsPl.state.conn === "gone")
  );
  if (
    !_ofsStale &&
    _ofsPl &&
    onlineSessionState.onlineSeen[pid] &&
    clock.wall() - onlineSessionState.onlineSeen[pid] > 3000
  )
    _ofsStale = true;
  if (_ofsStale && st && st.alive && st.board) {
    return {
      round: versusLobbyState.vsRound,
      ptr: MP.ptrs[st.idx],
      time: versusLobbyState.vsTime,
      board: st.board.map(function (r) {
        return r.slice();
      }),
      piece: st.piece ? { t: st.piece.type, r: st.piece.rot, x: st.piece.x, y: st.piece.y } : null,
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
      alive: 1,
      inc: qCountIdx(st.idx, ["travel", "pending", "active"]),
    };
  }
  if (_lf && _lf.round === versusLobbyState.vsRound) {
    let _elAt =
      typeof onlineSessionState._olLastFullAt[pid] === "number"
        ? Math.max(0, clock.wall() - onlineSessionState._olLastFullAt[pid])
        : 0;
    if (_lf.phase && _lf.phase !== "playing") _elAt = 0;
    return onlineAdvanceSnapshot(_lf, _elAt);
  }
  if (st && st.board) {
    return {
      round: versusLobbyState.vsRound,
      ptr: MP.ptrs[st.idx],
      time: versusLobbyState.vsTime,
      board: st.board.map(function (r) {
        return r.slice();
      }),
      piece: st.piece ? { t: st.piece.type, r: st.piece.rot, x: st.piece.x, y: st.piece.y } : null,
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
      alive: st.alive ? 1 : 0,
      inc: qCountIdx(st.idx, ["travel", "pending", "active"]),
    };
  }
  return _lf || null;
}

function _isReconnecting() {
  return (
    onlineLobbyState._autoReconnecting !== undefined &&
    !!onlineLobbyState._autoReconnecting &&
    !onlineSessionState.isOnlineGame &&
    !onlineSessionState.isSpectator
  );
}

export function buildRejoinPayload(pid) {
  const _others = {};
  for (let _oi = 0; _oi < onlineSessionState.onlineLocalOrder.length; _oi++) {
    const _oid = onlineSessionState.onlineLocalOrder[_oi];
    if (_oid === pid) continue;
    _others[_oid] = onlineFullStateFor(_oid);
  }
  const _cumByPid = {};
  for (let _ci = 0; _ci < MP.stations.length; _ci++) {
    const _cst = MP.stations[_ci];
    const _cpid =
      onlineSessionState.onlineSlotToPid !== undefined && onlineSessionState.onlineSlotToPid
        ? onlineSessionState.onlineSlotToPid[_cst.slot]
        : null;
    const _cc = MP.cum[_cst.slot];
    if (_cpid && _cc)
      _cumByPid[_cpid] = {
        lines: _cc.lines || 0,
        pieces: _cc.pieces || 0,
        ms: _cc.ms || 0,
        combo: _cc.combo || 0,
        score: _cc.score || 0,
        atk: _cc.atk || 0,
        recv: _cc.recv || 0,
        lvl: _cc.lvl || 1,
      };
  }
  return {
    target: pid,
    ts: clock.wall(),
    phase: game.state,
    cd: game.countdownRemaining,
    vsTime: versusLobbyState.vsTime,
    seed: onlineSessionState.onlineSeed,
    settings: relaySettings(),
    order:
      onlineSessionState.onlineMatchOrder && onlineSessionState.onlineMatchOrder.length
        ? onlineSessionState.onlineMatchOrder.slice()
        : onlineSessionState.onlineLocalOrder.slice(),
    round: versusLobbyState.vsRound,
    wins: MP.wins.slice(0, 4),
    cumByPid: _cumByPid,
    restore: onlineFullStateFor(pid),
    others: _others,
  };
}

export function onlineApplyRestore(st, r) {
  if (!st || !r) return;
  if (Array.isArray(r.board) && r.board.length === configState.ROWS)
    st.board = r.board.map(function (row) {
      return row.slice();
    });
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
  st.gravT = 0;
  if (Array.isArray(r.q)) st.queue = r.q.slice();
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
  st.left = false;
  st.leftByGone = false;
  if (typeof r.time === "number") st.timeMs = r.time;
  if (st.wrapEl) st.wrapEl.classList.remove("lost");
  if (st.bannerEl) st.bannerEl.textContent = "";
  stUpdateStats(st);
  stUpdateChips(st);
  drawStHold(st);
  drawStNexts(st);
  stCheckDanger(st);
}

export function onlinePushGarbage(amount, netMs) {
  if (!versusLobbyState.vsActive || !vsGarbageMode() || amount <= 0) return;
  const lag = clamp(Math.round((netMs || 0) / 2), 0, 350);
  let pv = MP.lastHole[0];
  const holes = [];
  for (let k = 0; k < amount; k++) {
    const same = pv < 0 ? false : k === 0 ? gameRandom() < 0.1 : gameRandom() < 0.8;
    const h = same ? pv : rndHole(pv);
    holes.push(h);
    pv = h;
  }
  MP.lastHole[0] = pv;
  MP.qs[0].push({ holes: holes, state: "travel", t0: versusLobbyState.vsTime - lag });
  SFX.recv();
  setMpGauges();
}

function remoteClearFx(st, d) {
  if (!st || !st.alive) return;
  stFxKick(st, 0, CLEARV0 + CLEARV_PER * Math.min(4, d), 0);
  const rows = Math.min(d, 4);
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < configState.COLS; x += 2)
      stBurstAt(st, x, configState.ROWS - 1 - r, null, 3, true, 1.4);
  }
}

export function onlineApplyState(p) {
  if (typeof p.round === "number" && p.round !== versusLobbyState.vsRound) {
    if (p.round > versusLobbyState.vsRound) {
      versusLobbyState.vsRound = p.round;
      vsBeginRound();
    } else return;
  }
  const st = onlineStationFor(p.sender);
  if (!st) return;
  if (typeof p.t === "number" && p.sender === onlineSessionState.onlineHostId) {
    const _cd = p.t - versusLobbyState.vsTime;
    const _rjFresh =
      onlineSessionState.onlineJoinedRoomAt !== undefined &&
      clock.wall() - onlineSessionState.onlineJoinedRoomAt < 5000;
    if (_rjFresh) {
      if (Math.abs(_cd) > 50) versusLobbyState.vsTime = p.t;
    } else {
      if (_cd > 250 || _cd < -250) versusLobbyState.vsTime = p.t;
      else if (_cd !== 0) versusLobbyState.vsTime += _cd * 0.12;
    }
  }
  if (st.paused) st.paused = false;
  const _oldPiece = st.piece
    ? { t: st.piece.type, r: st.piece.rot, x: st.piece.x, y: st.piece.y }
    : null;
  const _oldType = _oldPiece ? _oldPiece.t : null;
  if (Array.isArray(p.board) && p.board.length === configState.ROWS)
    st.board = p.board.map(function (r) {
      return r.slice();
    });
  if (p.piece && typeof p.piece === "object") {
    st.piece = {
      type: p.piece.t,
      rot: p.piece.r,
      x: p.piece.x,
      y: p.piece.y,
      cells: PIECES[p.piece.t].cells[p.piece.r],
      lockT: 0,
      lockResets: 0,
    };
    st.gravT = 0;
  } else st.piece = null;
  if (Array.isArray(p.q)) {
    st.queue = p.q.slice();
    if (p.q.length > 0 && typeof MP.ptrs[st.idx] === "number") {
      ensureStream(MP.ptrs[st.idx] + p.q.length + 2);
      let _qMatch = true;
      for (let _qj = 0; _qj < p.q.length; _qj++) {
        if (versusLobbyState.sharedStream[MP.ptrs[st.idx] + _qj] !== p.q[_qj]) {
          _qMatch = false;
          break;
        }
      }
      if (!_qMatch) {
        ensureStream(MP.ptrs[st.idx] + p.q.length + 350);
        for (
          let _qk = Math.max(0, MP.ptrs[st.idx]);
          _qk < versusLobbyState.sharedStream.length - p.q.length;
          _qk++
        ) {
          let _qok = true;
          for (let _qj2 = 0; _qj2 < p.q.length; _qj2++) {
            if (versusLobbyState.sharedStream[_qk + _qj2] !== p.q[_qj2]) {
              _qok = false;
              break;
            }
          }
          if (_qok) {
            MP.ptrs[st.idx] = _qk;
            break;
          }
        }
      }
    }
  }
  if (p.hold !== undefined) st.hold = p.hold;
  st.holdUsed = !!p.holdUsed;
  st.sent = p.sent || 0;
  st.recv = p.recv || 0;
  const _prevLines = st.lines || 0;
  st.lines = p.lines || 0;
  st.score = p.score || 0;
  st.level = p.level || 1;
  st.pieces = p.pieces || st.pieces;
  const _cleared = p.lines - _prevLines;
  if (_cleared > 0) {
    remoteClearFx(st, _cleared);
    if (st._sndInit) {
      if (p.fx && p.fx.s) SFX.spinClear();
      else if (_cleared >= 4) SFX.tetris();
      else SFX.chime();
    }
  }
  st._sndInit = true;
  if ((p.alive === false || p.alive === 0) && st.alive) {
    stTopOut(st);
    if (st._sndInit) SFX.sigh();
  }
  st._olInc = p.inc || 0;
  if (p.act && p.act.seq !== st._actSeq) {
    st._actSeq = p.act.seq;
    showStAction(st, p.act.t, p.act.s, p.act.c, p.act.col || null);
  }
  if (typeof p.combo === "number") st.combo = p.combo;
  if (typeof p.b2b === "number") st.b2b = p.b2b;
  if (p.fx && p.fx.seq !== st._fxSeq) {
    st._fxSeq = p.fx.seq;
    if (p.fx.k === "d") {
      stFxKick(st, 0, DROPV, 0);
    } else if (p.fx.k === "l") {
      if (p.fx.h) stFxKick(st, 0, DROPV * 0.55, 0);
      if (p.fx.s) stFxSpin(st, p.fx.d || 1);
      if (Array.isArray(p.fx.c)) {
        for (const q of p.fx.c) {
          if (q[1] >= HID)
            stBurstAt(st, q[0], q[1], _oldType, p.fx.h ? 3 : 2, true, p.fx.h ? 1.1 : 0.85);
        }
      }
      if (_cleared <= 0 && st._fxInit) {
        if (p.fx.h) SFX.slam();
        else SFX.lock();
      }
    }
    st._fxInit = true;
  }
  stUpdateChips(st);
  if (p.sender === onlineSessionState.onlineHostId && Array.isArray(p.wins)) {
    MP.wins = p.wins.slice(0, 4);
    vsUpdateHud();
  }
  drawStHold(st);
  drawStNexts(st);
  stUpdateStats(st);
  stCheckDanger(st);
}

export function spectatorStartWatching() {
  if (!MP.stations.length) return;
  versusLobbyState.vsRoundOver = false;
  versusLobbyState.vsCountdownStarted = true;
  game.countdownRemaining = 0;
  game.countdownPhase = "";
  versusLobbyState.vsBannerUntil = 0;
  game.state = "playing";
  document.body.classList.add("vsplay");
  document.body.classList.toggle("vsWide", versusLobbyState.vs.submode === "wide");
  document.body.classList.toggle("vs3P", MP.n === 3);
  document.body.classList.add("online-play");
  document.body.classList.toggle("onlineMulti", MP.n > 2);
  document.body.classList.toggle("onlineMulti3", MP.n === 3);
  document.body.classList.toggle("onlineMulti4", MP.n === 4);
  mpBannerAll("WATCHING", "var(--mut2)", "round");
  vsUpdateHud();
  setMpGauges();
  hideAllOverlays();
  bindingsState.openOverlayEl = null;
  syncPad();
  layout();
  layoutMp(game.MINI);
  layoutSoon(80);
  layoutSoon(300);
}

export function startOnlineMatch(order) {
  order = Array.isArray(order)
    ? order.filter(function (id) {
        return typeof id === "string" && id;
      })
    : [];
  if (
    !order.length &&
    onlineSessionState.onlinePlayersList !== undefined &&
    onlineSessionState.onlinePlayersList &&
    onlineSessionState.onlinePlayersList.length
  ) {
    order = onlineSessionState.onlinePlayersList
      .filter(function (p) {
        return p && p.id && !(p.state && p.state.role === "spec");
      })
      .map(function (p) {
        return p.id;
      });
  }
  if (!order.length) {
    onlineSessionState.onlineGameActive = false;
    onlineSessionState.isOnlineGame = false;
    onlineSessionState.isSpectator = false;
    onlineSessionState.onlineRemote = new Set();
    onlineSessionState.onlineSlotMap = {};
    onlineSessionState.onlineSlotToPid = {};
    document.body.classList.remove("online-play", "vsplay", "matchover");
    showOnlineLobbyUI();
    return;
  }
  onlineSessionState.isOnlineGame = true;
  onlineSessionState.onlineRng = mulberry32(onlineSessionState.onlineSeed);
  document.body.classList.add("online-play");
  onlineSessionState.onlineRemote = new Set();
  onlineSessionState.onlineSlotMap = {};
  onlineSessionState.onlineSlotToPid = {};
  onlineSessionState.onlineGoSent = false;
  onlineSessionState.onlineRemote = new Set();
  onlineSessionState.onlineSlotMap = {};
  onlineSessionState.onlineSlotToPid = {};
  onlineSessionState.onlineGoSent = false;
  onlineSessionState.onlineGlobalIdx = {};
  onlineSessionState.onlineMatchOrder = order.slice();
  order.forEach((id, i) => (onlineSessionState.onlineGlobalIdx[id] = i));
  const others = order.filter((id) => id !== onlineSessionState.myPlayerId);
  const localOrder =
    order.indexOf(onlineSessionState.myPlayerId) >= 0
      ? [onlineSessionState.myPlayerId].concat(others)
      : order.slice();
  onlineSessionState.onlineLocalOrder = localOrder;
  localOrder.forEach((id, i) => {
    onlineSessionState.onlineSlotMap[id] = i;
    onlineSessionState.onlineSlotToPid[i] = id;
    if (id !== onlineSessionState.myPlayerId) onlineSessionState.onlineRemote.add(i);
  });
  onlineSessionState.isSpectator = order.indexOf(onlineSessionState.myPlayerId) < 0;
  versusLobbyState.vs.players = localOrder.map((id) =>
    id === onlineSessionState.myPlayerId
      ? { type: "user", dev: "key", touch: true, swipe: true }
      : { type: "bot", dev: "key" },
  );
  while (versusLobbyState.vs.players.length < 4)
    versusLobbyState.vs.players.push({ type: "off", dev: "key" });
  onlineSyncState._osLastRound = -1;
  onlineSyncState._osLastSig = "";
  onlineSyncState._osLastBoardHash = -1;
  versusLobbyState.vsActive = true;
  if (onlineSessionState.isSpectator) {
    MP.wins = [0, 0, 0, 0];
    MP.cum = [0, 1, 2, 3].map(() => ({
      lines: 0,
      pieces: 0,
      ms: 0,
      combo: 0,
      score: 0,
      atk: 0,
      recv: 0,
      lvl: 1,
    }));
    configState.COLS = colsForMode("vsbot");
    configState.VIS = visForMode("vsbot");
    configState.ROWS = configState.VIS + HID;
    applyGeometry();
    const specAct = [];
    for (let _si = 0; _si < localOrder.length; _si++) {
      specAct.push({ p: { type: "bot", dev: "key" }, i: _si });
    }
    mpBuildStations(specAct);
    document.body.style.setProperty("--mpN", String(MP.n));
    buildMpChips();
    applyOnlineIdentity();
    spectatorStartWatching();
    return;
  }
  vsStartMatch();
  applyOnlineIdentity();
  document.body.classList.toggle("onlineMulti", MP.n > 2);
  document.body.classList.toggle("onlineMulti3", MP.n === 3);
  document.body.classList.toggle("onlineMulti4", MP.n === 4);
}

function applyOnlineIdentity() {
  document.body.classList.toggle("online-spec", !!onlineSessionState.isSpectator);
  const names = {};
  onlineSessionState.onlinePlayersList.forEach((p) => (names[p.id] = p.username));
  for (const st of MP.stations) {
    const pid = onlineSessionState.onlineLocalOrder[st.slot];
    if (!pid) continue;
    const gi =
      onlineSessionState.onlineGlobalIdx[pid] != null
        ? onlineSessionState.onlineGlobalIdx[pid]
        : st.slot;
    st.gi = gi;
    st.color = PLAYER_COLORS[gi];
    if (st.arenaEl) st.arenaEl.style.setProperty("--acchi", st.color);
    st.label = (names[pid] || "P" + (gi + 1)).slice(0, 8).toUpperCase();
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
  }
  buildMpChips();
}

export function hostStart() {
  if (_isReconnecting()) {
    showEditNote("Still reconnecting…");
    return;
  }
  if (onlineSessionState.onlineGameActive) {
    showEditNote("A match is already in progress.");
    return;
  }
  const players = onlineSessionState.onlinePlayersList.filter(
    (p) => !(p.state && p.state.role === "spec"),
  );
  if (players.length < 2) {
    showGameAlert("Need at least <b>2 players</b> to start the match.");
    return;
  }
  const notReady = players.filter(
    (p) =>
      (p.state && p.state.away) ||
      (p.id !== onlineSessionState.onlineHostId &&
        !onlineSessionState.onlineReadyFlags[p.id] &&
        !(p.state && p.state.ready)),
  );
  if (notReady.length) {
    showGameAlert(
      "All players must be <b>READY</b> to start.<br>Waiting for: <b>" +
        notReady.map((p) => p.username).join(", ") +
        "</b>",
    );
    return;
  }
  resetOnlineReady();
  netSend("ready-flags", { flags: {} });
  const order = players.map((p) => p.id);
  const settings = Object.assign({}, versusLobbyState.vs);
  delete settings.players;
  settings.seed = onlineSessionState.onlineSeed;
  if (roomPwdH()) settings.pwdH = roomPwdH();
  settings.st = { order: order, seed: onlineSessionState.onlineSeed, ts: clock.wall() };
  if (onlineSessionState.netMode === "supabase" && onlineSessionState.sb) {
    onlineSessionState.sb
      .from("rooms")
      .update({ settings: settings })
      .eq("id", onlineSessionState.onlineRoomId)
      .then(() => {});
  }
  netSend("start", { seed: onlineSessionState.onlineSeed, settings: settings, order: order });
  startOnlineMatch(order);
}

export async function swapRole() {
  const meRow = onlineSessionState.onlinePlayersList.find(function (p) {
    return p.id === onlineSessionState.myPlayerId;
  });
  const cur = meRow && meRow.state && meRow.state.role === "spec" ? "spec" : "player";
  if (cur === "player") {
    if (onlineSessionState.isOnlineGame && !onlineSessionState.isSpectator)
      netSend("left", {
        sender: onlineSessionState.myPlayerId,
        name: onlineSessionState.onlineMyName,
      });
    if (onlineSessionState.netMode === "p2p") {
      if (onlineSessionState.isOnlineHost) {
        if (meRow) meRow.state = { role: "spec", joined: clock.wall() };
        relayPushRoster();
      } else netSend("swap-req", { role: "spec" });
    } else if (onlineSessionState.netMode === "lan") {
      if (onlineSessionState.isOnlineHost) {
        if (meRow) meRow.state = { role: "spec", joined: clock.wall() };
        relayPushRoster();
      } else netSend("swap-req", { role: "spec" });
    } else if (onlineSessionState.netMode === "server") {
      activeBackend().saveMyState({
        myId: onlineSessionState.myPlayerId,
        state: { role: "spec", joined: clock.wall() },
      });
    } else if (onlineSessionState.sb) {
      await onlineSessionState.sb
        .from("players")
        .update({ state: { role: "spec", joined: clock.wall() } })
        .eq("id", onlineSessionState.myPlayerId);
    }
    if (onlineSessionState.isOnlineGame) {
      const players = onlineSessionState.onlinePlayersList.filter(
        (p) => !(p.state && p.state.role === "spec") && p.id !== onlineSessionState.myPlayerId,
      );
      startOnlineMatch(players.map((p) => p.id));
    }
  } else {
    const pc = onlineSessionState.onlinePlayersList.filter(
      (p) => !(p.state && p.state.role === "spec"),
    ).length;
    if (pc >= 4) {
      showEditNote("Player slots full");
      return;
    }
    if (onlineSessionState.netMode === "p2p") {
      if (onlineSessionState.isOnlineHost) {
        if (meRow) meRow.state = { role: "player", joined: clock.wall() };
        relayPushRoster();
      } else netSend("swap-req", { role: "player" });
    } else if (onlineSessionState.netMode === "server") {
      activeBackend().saveMyState({
        myId: onlineSessionState.myPlayerId,
        state: { role: "player", joined: clock.wall() },
      });
    } else if (onlineSessionState.sb) {
      await onlineSessionState.sb
        .from("players")
        .update({ state: { role: "player", joined: clock.wall() } })
        .eq("id", onlineSessionState.myPlayerId);
      if (onlineSessionState.isOnlineGame) {
        const { data: pl } = await onlineSessionState.sb
          .from("players")
          .select("id,state")
          .eq("room_id", onlineSessionState.onlineRoomId);
        const npl = (pl || [])
          .filter((p) => !(p.state && p.state.role === "spec"))
          .map((p) => p.id);
        if (npl.indexOf(onlineSessionState.myPlayerId) < 0) npl.push(onlineSessionState.myPlayerId);
        startOnlineMatch(npl);
      }
    }
    if (
      onlineSessionState.isOnlineGame &&
      (onlineSessionState.netMode === "p2p" || onlineSessionState.netMode === "server")
    ) {
      const npl = onlineSessionState.onlinePlayersList
        .filter((p) => !(p.state && p.state.role === "spec"))
        .map((p) => p.id);
      if (npl.indexOf(onlineSessionState.myPlayerId) < 0) npl.push(onlineSessionState.myPlayerId);
      startOnlineMatch(npl);
    }
  }
  updateOnlinePlayerList();
}

export async function leaveOnlineRoom(announce) {
  onlineSessionState.leavingRoom = true;
  clearLastRoom();
  onlineSessionState.onlineGameActive = false;
  if (onlineLobbyState._autoReconnecting !== undefined) onlineLobbyState._autoReconnecting = false;
  clearRejoinWatchdog();
  hideReconnectPanel();
  if (showOnlineLobbyUI._fbT) {
    clearTimeout(showOnlineLobbyUI._fbT);
    showOnlineLobbyUI._fbT = null;
  }
  const leaving = activeBackend().leave({
    roomId: onlineSessionState.onlineRoomId,
    myId: onlineSessionState.myPlayerId,
    myName: onlineSessionState.onlineMyName,
    isHost: onlineSessionState.isOnlineHost,
    announce,
    players: onlineSessionState.onlinePlayersList,
  });
  if (leaving) await leaving;
  onlineSessionState.onlineRoomId = null;
  onlineSessionState.isOnlineGame = false;
  onlineSessionState.isOnlineHost = false;
  onlineSessionState.isSpectator = false;
  onlineSessionState.onlineRemote = new Set();
  onlineSessionState.onlineSlotMap = {};
  onlineSessionState.onlineSlotToPid = {};
  onlineSessionState.onlinePlayersList = [];
  onlineSessionState.onlineSeen = {};
  onlineSessionState._olLastFull = {};
  onlineSessionState._olLastFullAt = {};
  onlineSessionState.onlinePing = {};
  onlineSessionState.onlineRoomPwd = "";
  onlineSessionState.onlineRoomPwdH = "";
  onlineSessionState.leavingRoom = false;
  document.body.classList.remove("online-play", "onlineMulti", "onlineMulti3", "onlineMulti4");
  const op = $("ovOnlinePause");
  if (op) {
    op.classList.add("hidden");
    op.setAttribute("inert", "");
  }
  showOnlineLobbyUI();
  quitToMenu();
}

export function forcedLeave(msg) {
  onlineSessionState.leavingRoom = true;
  clearLastRoom();
  onlineSessionState.onlineGameActive = false;
  if (onlineLobbyState._autoReconnecting !== undefined) onlineLobbyState._autoReconnecting = false;
  clearRejoinWatchdog();
  hideReconnectPanel();
  if (showOnlineLobbyUI._fbT) {
    clearTimeout(showOnlineLobbyUI._fbT);
    showOnlineLobbyUI._fbT = null;
  }
  activeBackend().drop({
    roomId: onlineSessionState.onlineRoomId,
    myId: onlineSessionState.myPlayerId,
  });
  // A channel left over from an earlier Supabase room is released whichever backend the room used.
  supabaseTransport().close();
  onlineSessionState.onlineRoomId = null;
  onlineSessionState.isOnlineGame = false;
  onlineSessionState.isOnlineHost = false;
  onlineSessionState.isSpectator = false;
  onlineSessionState.onlineRemote = new Set();
  onlineSessionState.onlineSlotMap = {};
  onlineSessionState.onlineSlotToPid = {};
  onlineSessionState.onlinePlayersList = [];
  onlineSessionState.onlineSeen = {};
  onlineSessionState._olLastFull = {};
  onlineSessionState._olLastFullAt = {};
  onlineSessionState.onlinePing = {};
  onlineSessionState.onlineRoomPwd = "";
  onlineSessionState.onlineRoomPwdH = "";
  document.body.classList.remove("online-play", "onlineMulti", "onlineMulti3", "onlineMulti4");
  const op = $("ovOnlinePause");
  if (op) {
    op.classList.add("hidden");
    op.setAttribute("inert", "");
  }
  showOnlineLobbyUI();
  quitToMenu();
  onlineSessionState.leavingRoom = false;
  setTimeout(() => showGameAlert(msg), 50);
}

function onlineFresh(row, mins) {
  return rowIsFresh(row, mins, clock.wall());
}

async function claimHostIfNext(departedId) {
  if (!onlineSessionState.sb || !onlineSessionState.onlineRoomId || onlineSessionState.isOnlineHost)
    return;
  try {
    const { data: room } = await onlineSessionState.sb
      .from("rooms")
      .select("host_id")
      .eq("id", onlineSessionState.onlineRoomId)
      .maybeSingle();
    if (!room) return;

    if (departedId && room.host_id !== departedId) return;
    const { data } = await onlineSessionState.sb
      .from("players")
      .select("id,state,last_active")
      .eq("room_id", onlineSessionState.onlineRoomId);
    const list = (data || [])
      .filter(function (r) {
        return onlineFresh(r, 10);
      })
      .sort((a, b) => ((a.state && a.state.joined) || 0) - ((b.state && b.state.joined) || 0));
    const players = list.filter((p) => !(p.state && p.state.role === "spec"));
    const pick = (players.length ? players : list)[0];
    if (pick && pick.id === onlineSessionState.myPlayerId)
      await onlineSessionState.sb
        .from("rooms")
        .update({ host_id: onlineSessionState.myPlayerId })
        .eq("id", onlineSessionState.onlineRoomId)
        .eq("host_id", departedId || room.host_id);
  } catch (_) {
    log.debug("net/online-lobby.claimHostIfNext", _);
  }
}

async function maybeDeleteEmptyRoom() {
  if (!onlineSessionState.sb || !onlineSessionState.onlineRoomId) return;
  try {
    const { data } = await onlineSessionState.sb
      .from("players")
      .select("id")
      .eq("room_id", onlineSessionState.onlineRoomId);
    if (data && data.length) return;
    const { data: room } = await onlineSessionState.sb
      .from("rooms")
      .select("host_id")
      .eq("id", onlineSessionState.onlineRoomId)
      .maybeSingle();
    if (
      room &&
      room.host_id &&
      onlineSessionState.onlinePlayersList.some(function (q) {
        return q.id === room.host_id;
      })
    )
      return;
    await onlineSessionState.sb.from("rooms").delete().eq("id", onlineSessionState.onlineRoomId);
  } catch (_) {
    log.debug("net/online-lobby.maybeDeleteEmptyRoom", _);
  }
}
