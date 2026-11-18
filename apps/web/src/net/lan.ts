// @ts-nocheck
import { checkPeerVersion, PROTOCOL_VERSION } from "@tetrizz/protocol";
import { clock } from "../core/clock";
import { gameRandom } from "../core/random";
import { escapeHtml } from "../core/escape";
import { log } from "../core/logger";
import { storage } from "../core/storage";
import { goBack, showScreen } from "../game/game";
import { askConfirm } from "../ui/settings";
import { PLAYER_COLORS } from "../ui/brand";
import { versusLobbyState } from "../versus/lobby";
import { onlineSessionState } from "./online-session";
import { netSend, receiveEnvelope } from "./transport";
import {
  roomPwdH,
  renderOnlineLists,
  showOnlineLobbyUI,
  updateOnlinePlayerList,
} from "./online-lobby";

export const lanState = {
  lanPCs: new Set(),
  lanPeers: new Set(),
  lanDC: null,
  lanPendingPC: null,
  lanPendingChannel: null,
  lanGuestPC: null,
  lanCameraStream: null,
  lanScanActive: false,
  lanScanRaf: null,
  lanUiMode: "",
  lanCurrentCode: "",
  lanFromLobby: false,
  lanLobbyTimer: null,
};

function lanName() {
  const li = document.getElementById("lanUsername");
  let v = "";
  if (li && li.value.trim()) v = li.value.trim();
  else v = (storage.get("tetris_username") || "").trim();
  v = v.toUpperCase().slice(0, 12);
  return v || "PLAYER";
}

function lanSetStatus(s) {
  const el = document.getElementById("lanStatus");
  if (el) el.textContent = s;
}

function ensureLanLibs() {
  if (typeof qrcode === "undefined" || typeof jsQR === "undefined") {
    alert(
      "LAN QR libraries are missing. Please paste the full contents of qrcode.min.js and jsQR.min.js into TetriZZ.html.",
    );
    return false;
  }
  return true;
}

function lanEncodeDesc(desc) {
  const s = JSON.stringify(desc);
  try {
    return btoa(s);
  } catch (_) {
    return btoa(encodeURIComponent(s));
  }
}

function lanDecodeDesc(str) {
  let raw = String(str || "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  while (raw.length % 4) raw += "=";
  const s = atob(raw);
  try {
    return JSON.parse(s);
  } catch (_) {
    return JSON.parse(decodeURIComponent(s));
  }
}

function lanRoomCode() {
  return "LAN";
}

function lanSetScreenTitle(text) {
  const lobby = document.getElementById("onlineLobby");
  if (!lobby) return;
  const root = lobby.closest(".screen") || lobby.closest(".menu-screen") || lobby.parentElement;
  if (!root) return;
  const title = root.querySelector(".bar-title");
  if (title) title.textContent = text;
}

function lanStopLobbyRefresh() {
  if (lanState.lanLobbyTimer) {
    clearInterval(lanState.lanLobbyTimer);
    lanState.lanLobbyTimer = null;
  }
}

function lanStartLobbyRefresh() {
  lanStopLobbyRefresh();
  lanState.lanLobbyTimer = setInterval(function () {
    if (!onlineSessionState.isLanMode) {
      lanStopLobbyRefresh();
      return;
    }
    const lobby = document.getElementById("onlineLobby");
    if (!lobby || lobby.style.display === "none") return;
    if (onlineSessionState.isOnlineHost) {
      netSend("roster", { players: onlineSessionState.onlinePlayersList });
    }
    try {
      renderOnlineLists();
    } catch (_) {
      log.debug("net/lan.lanStartLobbyRefresh", _);
    }
    try {
      updateOnlinePlayerList();
    } catch (_) {
      log.debug("net/lan.lanStartLobbyRefresh#2", _);
    }
  }, 1200);
}

export function lanReturnToLobby() {
  lanState.lanFromLobby = false;
  const screen = document.getElementById("lanSetupScreen");
  if (screen) screen.style.display = "none";
  document.body.classList.remove("lan-setup-active");
  const setup = document.getElementById("onlineSetup");
  const lobby = document.getElementById("onlineLobby");
  if (setup) setup.style.display = "none";
  if (lobby) lobby.style.display = "block";
  showOnlineLobbyUI();
  lanApplyLobbyBranding();
  lanStartLobbyRefresh();
}

function lanOpenHostPanel() {
  if (!onlineSessionState.isLanMode || !onlineSessionState.isOnlineHost) return;
  lanState.lanFromLobby = true;
  document.body.classList.add("lan-setup-active");
  const setup = document.getElementById("onlineSetup");
  const lobby = document.getElementById("onlineLobby");
  if (setup) setup.style.display = "none";
  if (lobby) lobby.style.display = "none";
  lanInjectScreen();
  const s = document.getElementById("lanSetupScreen");
  if (s) s.style.display = "block";
  lanSetScreenTitle("LAN");
  lanShowHostPanel();
}

function lanBoxByLabel(labels, hide) {
  document.querySelectorAll("#onlineLobby span, #onlineLobby div").forEach(function (el) {
    if (el.children.length === 0) {
      const t = (el.textContent || "").trim().toUpperCase();
      if (labels.indexOf(t) >= 0) {
        let box = el;
        for (let i = 0; i < 5 && box; i++) {
          box = box.parentElement;
          if (box && box.querySelector("button")) break;
        }
        if (box) box.style.display = hide ? "none" : "";
      }
    }
  });
}

function lanApplyLobbyBranding() {
  if (!onlineSessionState.isLanMode) return;
  lanSetScreenTitle("LAN");
  lanBoxByLabel(["LAN CODE", "ROOM CODE", "ROOM PASSWORD"], true);
  let addBtn = document.getElementById("lanAddPlayerBtn");
  if (!addBtn) {
    addBtn = document.createElement("button");
    addBtn.id = "lanAddPlayerBtn";
    addBtn.className = "menu-btn primary";
    addBtn.textContent = "ADD LAN PLAYER";
    addBtn.style.marginTop = "10px";
    const anchor =
      document.getElementById("btnStartMatch") ||
      document.querySelector("#onlineLobby .start-wrap");
    if (anchor && anchor.parentNode) {
      const wrapper = document.createElement("div");
      wrapper.className = "start-wrap";
      wrapper.style.marginTop = "10px";
      wrapper.appendChild(addBtn);
      anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);
    }
  }
  addBtn.style.display = onlineSessionState.isOnlineHost ? "" : "none";
  addBtn.onclick = function (e) {
    if (e) e.stopPropagation();

    if (onlineSessionState.isOnlineHost && !lanState.lanPendingPC) {
      lanOpenHostPanel();
      lanCreatePendingOffer();
    } else {
      lanOpenHostPanel();
    }
  };
  const share = document.getElementById("btnShareLink");
  if (share) share.style.display = "none";
}

function restoreOnlineLobbyBranding() {
  lanSetScreenTitle("ONLINE");
  lanBoxByLabel(["LAN CODE", "ROOM CODE", "ROOM PASSWORD"], false);
  const addBtn = document.getElementById("lanAddPlayerBtn");
  if (addBtn) addBtn.style.display = "none";
  const copy = document.getElementById("btnCopyCode");
  if (copy) {
    copy.textContent = "COPY CODE";
    copy.onclick = null;
  }
  const share = document.getElementById("btnShareLink");
  if (share) share.style.display = "";
}

function lanInjectScreen() {
  if (document.getElementById("lanSetupScreen")) return;
  const setup = document.getElementById("onlineSetup");
  const screen = document.createElement("div");
  screen.id = "lanSetupScreen";
  screen.className = "settings";
  screen.style.display = "none";
  screen.innerHTML = `
<div class="step" style="margin-bottom:10px"><span class="lb">PLAYER NAME</span><span class="ctl"><input type="text" id="lanUsername" class="tp-name" maxlength="12" placeholder="PLAYER" value=""></span></div>
<div id="lanMain">
<div class="grp-title">LAN PLAY</div>
<div class="start-wrap" style="margin-top:min(1.8vh,14px)"><button class="menu-btn primary ol-action-btn" id="btnLanCreate" type="button">CREATE ROOM</button></div>
<div class="start-wrap" style="margin-top:min(1.2vh,10px)"><button class="menu-btn primary ol-action-btn" id="btnLanJoin" type="button">JOIN ROOM</button></div>
<div class="start-wrap" style="margin-top:min(1.2vh,10px)"><button class="menu-btn" id="btnLanHelp" type="button">HOW TO CONNECT ?</button></div>
</div>
<div id="lanHelp" style="display:none">
<div class="grp-title">HOW TO CONNECT</div>
<div style="font:500 12px/1.7 'IBM Plex Mono',monospace;color:var(--txt,#dfe7f3);padding:0 4px">
<p style="margin:0 0 10px"><b style="color:var(--acchi,#7c8cc7)">STEP 1 — SAME NETWORK</b><br>All devices must be on the <b>same WiFi</b>.<br>No modem? One phone can enable its <b>Hotspot</b> and others connect to it. This works exactly like a local WiFi — no internet needed.</p>
<p style="margin:0 0 10px"><b style="color:var(--acchi,#7c8cc7)">STEP 2 — HOST CREATES</b><br>One player taps <b>CREATE ROOM</b>. A QR code and a long text code appear.</p>
<p style="margin:0 0 10px"><b style="color:var(--acchi,#7c8cc7)">STEP 3 — GUEST GETS CODE</b><br>The other player taps <b>JOIN ROOM</b>, then scans the QR with camera, or pastes the text code.</p>
<p style="margin:0 0 10px"><b style="color:var(--acchi,#7c8cc7)">STEP 4 — GUEST SENDS ANSWER</b><br>The guest gets an <b>answer code</b>. Send it back to the host (copy/paste via chat, show QR, etc).</p>
<p style="margin:0 0 10px"><b style="color:var(--acchi,#7c8cc7)">STEP 5 — HOST CONNECTS</b><br>The host pastes the answer code and taps <b>CONNECT ANSWER</b>. Players are now connected!</p>
<p style="margin:0 0 4px"><b style="color:var(--acchi,#7c8cc7)">STEP 6 — PLAY</b><br>Both tap <b>GO TO LOBBY</b>, then host taps <b>START MATCH</b>.</p>
</div>
<div class="start-wrap" style="margin-top:12px"><button class="menu-btn" id="btnLanHelpBack" type="button">BACK</button></div>
</div>
<div id="lanActive" style="display:none">
<div class="grp-title" id="lanTitle">LAN ROOM</div>
<div class="step"><span class="lb">STATUS</span><span class="ctl" id="lanStatus" style="color:var(--acchi)">WAITING</span></div>
<div id="lanDisplay" style="display:none">
<div style="display:flex;justify-content:center;margin:12px 0"><canvas id="lanQR" style="width:min(70vw,300px);height:auto;background:#fff;border-radius:10px;padding:6px"></canvas></div>
<div style="margin:12px 0"><div style="font:600 11px/1 'IBM Plex Mono',monospace;letter-spacing:.16em;color:var(--mut2);margin-bottom:6px">TEXT CODE</div><textarea id="lanCode" readonly wrap="soft" style="display:block;width:100%;box-sizing:border-box;height:clamp(120px,22vh,200px);resize:none;font:500 12px/1.55 'IBM Plex Mono',monospace;word-break:break-all;overflow:auto;background:var(--p1,#161d2b);border:1px solid var(--line,rgba(148,170,210,.13));border-radius:10px;padding:10px;color:var(--txt,#dfe7f3)"></textarea></div>
<div class="start-wrap" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
<button class="menu-btn" id="btnLanCopy" type="button">COPY CODE</button>
<button class="menu-btn" id="btnLanRegen" type="button">REGENERATE</button>
<button class="menu-btn" id="btnLanDownload" type="button">DOWNLOAD QR</button>
<button class="menu-btn" id="btnLanShare" type="button">SHARE QR</button>
</div>
</div>

<div id="lanInput">
<div style="margin:12px 0"><div style="font:600 11px/1 'IBM Plex Mono',monospace;letter-spacing:.16em;color:var(--mut2);margin-bottom:6px" id="lanInputLabel">PASTE CODE</div><textarea id="lanPaste" wrap="soft" style="display:block;width:100%;box-sizing:border-box;height:clamp(120px,22vh,200px);resize:none;font:500 12px/1.55 'IBM Plex Mono',monospace;word-break:break-all;overflow:auto;background:var(--p1,#161d2b);border:1px solid var(--line,rgba(148,170,210,.13));border-radius:10px;padding:10px;color:var(--txt,#dfe7f3)" placeholder="PASTE CODE HERE"></textarea></div>
<div class="start-wrap" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
<button class="menu-btn" id="btnLanScan" type="button">SCAN CAMERA</button>
<button class="menu-btn" id="btnLanLoadFile" type="button">READ FROM FILE</button>
<input type="file" id="lanFileInput" accept="image/*" style="display:none">
<button class="menu-btn primary" id="btnLanConnect" type="button">CONNECT CODE</button>
</div>
</div>



<div class="grp-title" style="margin-top:16px;font-size:12px">CONNECTED PLAYERS</div>
<div id="lanPlayersList" style="min-height:20px;padding:8px 0;display:flex;flex-direction:column;gap:6px"><span style="color:var(--mut);font-size:11px">No players connected yet</span></div>
<div class="start-wrap" style="margin-top:14px"><button class="menu-btn primary" id="btnLanGoLobby" type="button" style="display:none">GO TO LOBBY</button></div>
<div class="start-wrap" style="margin-top:10px"><button class="menu-btn danger" id="btnLanBackSetup" type="button">BACK</button></div>
</div>
`;
  if (setup && setup.parentNode) setup.parentNode.insertBefore(screen, setup);
  else document.body.appendChild(screen);

  document.getElementById("btnLanCreate").onclick = lanCreateRoom;
  document.getElementById("btnLanJoin").onclick = lanJoinRoom;
  document.getElementById("btnLanBackSetup").onclick = lanBackToMain;
  document.getElementById("btnLanHelp").onclick = function () {
    document.getElementById("lanMain").style.display = "none";
    document.getElementById("lanHelp").style.display = "block";
  };
  document.getElementById("btnLanHelpBack").onclick = function () {
    document.getElementById("lanHelp").style.display = "none";
    document.getElementById("lanMain").style.display = "block";
  };
  document.getElementById("btnLanGoLobby").onclick = lanEnterOnlineLobby;
  document.getElementById("btnLanCopy").onclick = copyLanCode;
  document.getElementById("btnLanRegen").onclick = function () {
    if (lanState.lanUiMode === "host") lanCreatePendingOffer();
  };
  document.getElementById("btnLanDownload").onclick = downloadLanQR;
  document.getElementById("btnLanShare").onclick = shareLanQR;
  document.getElementById("btnLanScan").onclick = scanLanCamera;
  document.getElementById("btnLanLoadFile").onclick = function () {
    document.getElementById("lanFileInput").click();
  };
  document.getElementById("lanFileInput").onchange = loadLanQRFromFile;
  document.getElementById("btnLanConnect").onclick = function () {
    const paste = document.getElementById("lanPaste");
    const code = paste ? paste.value.trim() : "";
    if (!code) return;
    if (paste) paste.value = "";
    lanHandleIncomingCode(code);
  };
}

export function showLanSetupScreen() {
  lanTeardownAll();
  onlineSessionState.isLanMode = true;
  onlineSessionState.netMode = "lan";
  lanState.lanUiMode = "";

  const setup = document.getElementById("onlineSetup");
  const lobby = document.getElementById("onlineLobby");
  if (setup) setup.style.display = "none";
  if (lobby) lobby.style.display = "none";

  lanInjectScreen();
  const screen = document.getElementById("lanSetupScreen");
  if (screen) screen.style.display = "block";
  document.body.classList.add("lan-setup-active");
  lanState.lanFromLobby = false;
  lanStopLobbyRefresh();
  lanSetScreenTitle("LAN");

  lanShowMainMenu();
}

function lanShowMainMenu() {
  lanState.lanUiMode = "";
  const main = document.getElementById("lanMain");
  const active = document.getElementById("lanActive");
  const help = document.getElementById("lanHelp");
  if (main) main.style.display = "block";
  if (active) active.style.display = "none";
  if (help) help.style.display = "none";

  const username = document.getElementById("lanUsername");
  if (username) {
    const stored = storage.get("tetris_username") || "";
    const online = document.getElementById("onlineUsername");
    username.value = stored || (online ? online.value : "");
  }
}

function lanShowHostPanel() {
  lanState.lanUiMode = "host";
  const main = document.getElementById("lanMain");
  const active = document.getElementById("lanActive");
  if (main) main.style.display = "none";
  if (active) active.style.display = "block";

  const titleEl = document.getElementById("lanTitle");
  if (titleEl) titleEl.textContent = "HOST LAN ROOM";
  const inputLbl = document.getElementById("lanInputLabel");
  if (inputLbl) inputLbl.textContent = "GET PLAYER ANSWER";
  const connectBtn = document.getElementById("btnLanConnect");
  if (connectBtn) connectBtn.textContent = "CONNECT ANSWER";

  const connWrap = document.getElementById("lanConnectedWrap");
  if (connWrap) connWrap.style.display = "";
  const regenBtn = document.getElementById("btnLanRegen");
  if (regenBtn) regenBtn.style.display = "";
  const display = document.getElementById("lanDisplay");
  if (display)
    display.style.display = lanState.lanCurrentCode && lanState.lanPendingPC ? "block" : "none";
  const input = document.getElementById("lanInput");
  if (input) input.style.display = "block";

  lanUpdateConnected();
  if (!lanState.lanPendingPC) lanCreatePendingOffer();
  else if (lanState.lanCurrentCode) lanDisplayCode(lanState.lanCurrentCode);
}

function lanShowGuestPanel() {
  lanState.lanUiMode = "guest";
  const main = document.getElementById("lanMain");
  const active = document.getElementById("lanActive");
  if (main) main.style.display = "none";
  if (active) active.style.display = "block";

  const titleEl = document.getElementById("lanTitle");
  if (titleEl) titleEl.textContent = "JOIN LAN ROOM";
  const inputLbl = document.getElementById("lanInputLabel");
  if (inputLbl) inputLbl.textContent = "GET HOST CODE";
  const connectBtn = document.getElementById("btnLanConnect");
  if (connectBtn) connectBtn.textContent = "JOIN";

  const pasteBox = document.getElementById("lanPaste");
  if (pasteBox) pasteBox.focus();
  const connWrap = document.getElementById("lanConnectedWrap");
  if (connWrap) connWrap.style.display = "none";
  const goLobbyBtn = document.getElementById("btnLanGoLobby");
  if (goLobbyBtn) goLobbyBtn.style.display = "none";
  const regenBtn = document.getElementById("btnLanRegen");
  if (regenBtn) regenBtn.style.display = "none";

  const display = document.getElementById("lanDisplay");
  const input = document.getElementById("lanInput");

  if (lanState.lanGuestPC && lanState.lanCurrentCode) {
    if (display) display.style.display = "block";
    if (input) input.style.display = "none";
    lanDisplayCode(lanState.lanCurrentCode);
  } else {
    if (display) display.style.display = "none";
    if (input) input.style.display = "block";
    lanSetStatus("SCAN/LOAD HOST CODE");
  }
}

export function lanBackToMain() {
  if (lanState.lanFromLobby !== undefined && lanState.lanFromLobby) {
    lanReturnToLobby();
    return;
  }
  if (lanState.lanUiMode === "host" || lanState.lanUiMode === "guest") {
    if (onlineSessionState.onlineRoomId && onlineSessionState.onlinePlayersList.length > 0) {
      askConfirm(
        "Leave this LAN room?<br>Connected players will be disconnected.",
        "LEAVE",
        function () {
          lanTeardownAll();
          lanShowMainMenu();
        },
      );
    } else {
      lanTeardownAll();
      lanShowMainMenu();
    }
    return;
  }
  leaveLanMode();
  const ov = document.querySelector(".overlay:not(.hidden)") || document.getElementById("ovStart");
  if (ov) {
    showScreen(ov, "multiplayer");
  } else if (ov) {
    goBack(ov);
  }
}

export function leaveLanMode() {
  lanTeardownAll();
  lanStopLobbyRefresh();
  lanState.lanFromLobby = false;
  document.body.classList.remove("lan-setup-active");
  restoreOnlineLobbyBranding();
  const screen = document.getElementById("lanSetupScreen");
  if (screen) screen.style.display = "none";
  const setup = document.getElementById("onlineSetup");
  const lobby = document.getElementById("onlineLobby");
  if (setup) setup.style.display = "flex";
  if (lobby) lobby.style.display = "none";
  onlineSessionState.isLanMode = false;
  onlineSessionState.netMode = "supabase";
}

export function lanCreateRoom() {
  if (!ensureLanLibs()) return;
  lanTeardownAll();

  onlineSessionState.isLanMode = true;
  onlineSessionState.netMode = "lan";

  onlineSessionState.isOnlineHost = true;

  onlineSessionState.onlineMyName = lanName();
  storage.set("tetris_username", onlineSessionState.onlineMyName);

  onlineSessionState.onlineHostId = onlineSessionState.myPlayerId;
  onlineSessionState.onlineRoomId = lanRoomCode();
  onlineSessionState.onlineSeed = Math.floor(gameRandom() * 1e9);
  onlineSessionState.onlineRoomPwd = "";

  onlineSessionState.onlinePlayersList = [
    {
      id: onlineSessionState.myPlayerId,
      username: onlineSessionState.onlineMyName.toUpperCase(),
      state: { role: "player", joined: clock.wall(), ready: false },
    },
  ];

  lanShowHostPanel();
  lanSetStatus("CREATING ROOM...");
}

export function lanJoinRoom() {
  if (!ensureLanLibs()) return;
  lanTeardownAll();

  onlineSessionState.isLanMode = true;
  onlineSessionState.netMode = "lan";

  onlineSessionState.isOnlineHost = false;

  onlineSessionState.onlineMyName = lanName();
  storage.set("tetris_username", onlineSessionState.onlineMyName);

  lanShowGuestPanel();
}

function lanUpdateConnected() {
  const listEl = document.getElementById("lanPlayersList");
  if (listEl) {
    if (onlineSessionState.onlinePlayersList.length === 0) {
      listEl.innerHTML =
        '<span style="color:var(--mut);font-size:11px">No players connected yet</span>';
    } else {
      listEl.innerHTML = onlineSessionState.onlinePlayersList
        .map(function (p, i) {
          const c = PLAYER_COLORS[i % PLAYER_COLORS.length];
          const me = p.id === onlineSessionState.myPlayerId;
          const host = p.id === onlineSessionState.onlineHostId;
          return (
            '<div class="bindrow" style="padding:10px 14px;margin-bottom:8px;border:1px solid var(--line);border-radius:10px;background:var(--chip-bg);border-left:3px solid ' +
            c +
            '">' +
            '<span class="bl" style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0">' +
            '<span style="color:' +
            c +
            ";font-weight:700;letter-spacing:.06em;text-shadow:0 0 10px " +
            c +
            '55;">' +
            escapeHtml(p.username || "PLAYER") +
            "</span>" +
            (me
              ? '<span style="color:var(--mut2);font-weight:500;margin-left:6px;font-size:10px;letter-spacing:.12em">(YOU)</span>'
              : "") +
            (host
              ? '<span class="bchip" style="color:var(--gold);border-color:rgba(255,210,63,.5);padding:2px 8px;font-size:10px;letter-spacing:.1em;line-height:1;margin-left:6px">★ HOST</span>'
              : "") +
            '</span><span class="bchips"></span></div>'
          );
        })
        .join("");
    }
  }
  const go = document.getElementById("btnLanGoLobby");
  if (go)
    go.style.display =
      onlineSessionState.isOnlineHost && onlineSessionState.onlinePlayersList.length > 1
        ? ""
        : "none";
}

function lanDisplayCode(code) {
  lanState.lanCurrentCode = code;
  const display = document.getElementById("lanDisplay");
  const area = document.getElementById("lanCode");
  if (display) display.style.display = "block";
  if (area) area.value = code;
  generateLanQR(code);
}

function lanClosePending() {
  if (lanState.lanPendingPC) {
    const pc = lanState.lanPendingPC;
    lanState.lanPendingPC = null;
    lanState.lanPendingChannel = null;
    lanState.lanPCs.delete(pc);
    try {
      pc.close();
    } catch (_) {
      log.debug("net/lan.lanClosePending", _);
    }
  }
}

function lanCreatePendingOffer() {
  if (!onlineSessionState.isOnlineHost) return;
  lanClosePending();
  lanSetStatus("CREATING OFFER...");

  const pc = new RTCPeerConnection({ iceServers: [] });
  lanState.lanPendingPC = pc;

  const channel = pc.createDataChannel("tetrizz");
  lanState.lanPendingChannel = channel;
  channel.lanPC = pc;
  setupLanChannel(channel, true, true);

  pc.onconnectionstatechange = function () {
    if (pc !== lanState.lanPendingPC) return;
    if (pc.connectionState === "failed") lanSetStatus("CONNECTION FAILED");
  };

  let lanOfferDone = false;
  function finishOffer() {
    if (lanOfferDone || pc !== lanState.lanPendingPC) return;
    if (!pc.localDescription) return;
    lanOfferDone = true;
    const code = lanEncodeDesc(pc.localDescription);
    lanDisplayCode(code);
    lanSetStatus("WAITING FOR PLAYER ANSWER");
  }

  pc.onicecandidate = function (e) {
    if (pc !== lanState.lanPendingPC) return;
    if (!e.candidate) finishOffer();
  };

  pc.onicegatheringstatechange = function () {
    if (pc !== lanState.lanPendingPC) return;
    if (pc.iceGatheringState === "complete") finishOffer();
  };

  pc.createOffer()
    .then(function (offer) {
      if (pc !== lanState.lanPendingPC) return;
      return pc.setLocalDescription(offer);
    })
    .then(function () {
      setTimeout(function () {
        if (pc === lanState.lanPendingPC && pc.localDescription) {
          const code = lanEncodeDesc(pc.localDescription);
          lanDisplayCode(code);
          lanSetStatus("WAITING FOR PLAYER ANSWER");
        }
      }, 3000);
    })
    .catch(function () {
      lanSetStatus("FAILED TO CREATE OFFER");
    });
}

async function lanLoadAnswer(code) {
  if (!lanState.lanPendingPC) {
    lanSetStatus("CREATE A NEW OFFER FIRST");
    lanCreatePendingOffer();
    return;
  }
  try {
    const answer = lanDecodeDesc(code);
    if (!answer || !answer.type || !answer.sdp) {
      lanSetStatus("INVALID ANSWER FORMAT");
      return;
    }
    await lanState.lanPendingPC.setRemoteDescription(answer);
    lanSetStatus("CONNECTING... WAITING FOR DATA CHANNEL");
  } catch (err) {
    console.error("[LAN] Failed to load answer:", err);
    lanSetStatus("INVALID ANSWER CODE: " + (err.message || "Unknown error"));
  }
}

async function lanGuestProcessOffer(code) {
  if (!ensureLanLibs()) return;
  lanTeardownAll();

  onlineSessionState.isLanMode = true;
  onlineSessionState.netMode = "lan";

  onlineSessionState.isOnlineHost = false;

  lanState.lanUiMode = "guest";
  lanSetStatus("GENERATING ANSWER...");

  const pc = new RTCPeerConnection({ iceServers: [] });
  lanState.lanGuestPC = pc;

  pc.onconnectionstatechange = function () {
    if (pc !== lanState.lanGuestPC) return;
    if (pc.connectionState === "failed") lanSetStatus("CONNECTION FAILED");
  };

  pc.ondatachannel = function (e) {
    setupLanChannel(e.channel, false, false);
  };

  let lanAnswerDone = false;
  function finishAnswer() {
    if (lanAnswerDone || pc !== lanState.lanGuestPC) return;
    if (!pc.localDescription) return;
    lanAnswerDone = true;
    const answerCode = lanEncodeDesc(pc.localDescription);
    lanDisplayCode(answerCode);
    const input = document.getElementById("lanInput");
    if (input) input.style.display = "none";
    lanSetStatus("SEND THIS ANSWER BACK TO HOST");
  }

  pc.onicecandidate = function (e) {
    if (pc !== lanState.lanGuestPC) return;
    if (!e.candidate) finishAnswer();
  };

  pc.onicegatheringstatechange = function () {
    if (pc !== lanState.lanGuestPC) return;
    if (pc.iceGatheringState === "complete") finishAnswer();
  };

  try {
    const offer = lanDecodeDesc(code);
    await pc.setRemoteDescription(offer);
    lanSetStatus("CREATING ANSWER...");
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    setTimeout(function () {
      finishAnswer();
    }, 4000);
  } catch (_) {
    lanSetStatus("INVALID HOST CODE");
    const input = document.getElementById("lanInput");
    if (input) input.style.display = "block";
  }
}

function setupLanChannel(channel, host, pending) {
  channel.onopen = function () {
    if (host) {
      if (pending) {
        if (lanState.lanPendingChannel === channel) {
          lanState.lanPendingPC = null;
          lanState.lanPendingChannel = null;
        }
        if (channel.lanPC) lanState.lanPCs.add(channel.lanPC);
        lanState.lanPeers.add(channel);
        lanSetStatus("PLAYER CONNECTED, WAITING FOR HELLO...");
      } else {
        lanState.lanPeers.add(channel);
      }
    } else {
      lanState.lanDC = channel;
      onlineSessionState.isOnlineHost = false;
      log.debug("lan", "[LAN] Guest data channel opened, sending hello");

      const sendHello = function () {
        if (lanState.lanDC && lanState.lanDC.readyState === "open") {
          try {
            lanState.lanDC.send(
              JSON.stringify({
                t: "hello",
                id: onlineSessionState.myPlayerId,
                name: onlineSessionState.onlineMyName,
                v: PROTOCOL_VERSION,
              }),
            );
            log.debug("lan", "[LAN] Hello sent to host");
          } catch (err) {
            console.error("[LAN] Failed to send hello:", err);

            setTimeout(sendHello, 100);
          }
        }
      };
      sendHello();
      lanSetStatus("CONNECTED, WAITING FOR HOST DATA...");
    }
  };

  channel.onmessage = function (e) {
    lanOnMessage(e, channel, host);
  };

  channel.onclose = function () {
    lanState.lanPeers.delete(channel);
    if (host && channel.lanPid) {
      const pid = channel.lanPid;
      const p = onlineSessionState.onlinePlayersList.find((x) => x.id === pid);
      onlineSessionState.onlinePlayersList = onlineSessionState.onlinePlayersList.filter(
        (x) => x.id !== pid,
      );
      netSend("roster", { players: onlineSessionState.onlinePlayersList });
      netSend("left", { sender: pid, name: p ? p.username : "PLAYER" });
      if (lanState.lanUiMode === "host") lanUpdateConnected();
    }
    if (lanState.lanDC === channel) lanState.lanDC = null;
  };
}

function lanOnMessage(e, channel, host) {
  let d;
  try {
    d = JSON.parse(e.data);
  } catch (_) {
    return;
  }

  if (host) {
    if (d && d.t === "hello") {
      if (checkPeerVersion(d.v) !== "ok") {
        log.debug("lan", "[LAN] Refused a guest that speaks protocol version " + d.v);
        if (lanState.lanUiMode === "host")
          lanSetStatus("A PLAYER USES A DIFFERENT VERSION - ASK THEM TO RELOAD");
        try {
          channel.close();
        } catch (_) {
          log.debug("net/lan.lanOnMessage", _);
        }
        return;
      }
      channel.lanPid = d.id;
      const name =
        String(d.name || "PLAYER")
          .toUpperCase()
          .slice(0, 12) || "PLAYER";
      if (!onlineSessionState.onlinePlayersList.find((p) => p.id === d.id)) {
        onlineSessionState.onlinePlayersList.push({
          id: d.id,
          username: name,
          state: { role: "player", joined: clock.wall(), ready: false },
        });
      }
      log.debug(
        "lan",
        "[LAN] Player joined:",
        name,
        "Total players:",
        onlineSessionState.onlinePlayersList.length,
      );

      setTimeout(function () {
        netSend("roster", { players: onlineSessionState.onlinePlayersList });
        const settings = relaySettings();
        settings.hostId = onlineSessionState.myPlayerId;
        settings.roomId = onlineSessionState.onlineRoomId;
        netSend("settings", settings);
        renderOnlineLists();
        updateOnlinePlayerList();
      }, 200);

      if (lanState.lanUiMode === "host") {
        lanUpdateConnected();
        lanSetStatus('PLAYER JOINED - CLICK "ADD LAN PLAYER" FOR MORE');
      }
      return;
    }
    receiveEnvelope("lan", d);
    lanRelay(d, channel);
    return;
  }

  receiveEnvelope("lan", d);
}

function lanRelay(d, fromChannel) {
  if (!onlineSessionState.isOnlineHost) return;
  let s;
  try {
    s = JSON.stringify(d);
  } catch (_) {
    return;
  }
  for (const ch of lanState.lanPeers) {
    if (ch !== fromChannel && ch.readyState === "open") {
      try {
        ch.send(s);
      } catch (_) {
        log.debug("net/lan.lanRelay", _);
      }
    }
  }
}

export function lanEnterOnlineLobby() {
  document.body.classList.remove("lan-setup-active");
  const screen = document.getElementById("lanSetupScreen");
  if (screen) screen.style.display = "none";

  const setup = document.getElementById("onlineSetup");
  const lobby = document.getElementById("onlineLobby");
  if (setup) setup.style.display = "none";
  if (lobby) lobby.style.display = "block";

  showOnlineLobbyUI();
  lanApplyLobbyBranding();
  renderOnlineLists();
  updateOnlinePlayerList();
  setTimeout(function () {
    renderOnlineLists();
    updateOnlinePlayerList();
  }, 120);
  lanState.lanFromLobby = false;
  lanStartLobbyRefresh();

  if (onlineSessionState.isOnlineHost) {
    const rc = document.getElementById("displayRoomCode");
    if (rc) {
      rc.style.cursor = "pointer";
      rc.title = "Add LAN players";
      rc.onclick = lanOpenHostPanel;
    }
  }
}

export function lanTeardownAll() {
  stopLanScan();
  lanClosePending();
  for (const pc of lanState.lanPCs) {
    try {
      pc.close();
    } catch (_) {
      log.debug("net/lan.lanTeardownAll", _);
    }
  }
  lanState.lanPCs.clear();
  lanState.lanPeers.clear();
  if (lanState.lanGuestPC) {
    try {
      lanState.lanGuestPC.close();
    } catch (_) {
      log.debug("net/lan.lanTeardownAll#2", _);
    }
  }
  lanState.lanGuestPC = null;
  lanState.lanDC = null;

  onlineSessionState.onlineRoomId = null;
  lanState.lanCurrentCode = "";
}

function generateLanQR(text) {
  const canvas = document.getElementById("lanQR");
  if (!canvas) return;
  if (typeof qrcode === "undefined") {
    lanSetStatus("QR LIBRARY MISSING");
    return;
  }
  try {
    const qr = qrcode(0, "L");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const cell = Math.max(2, Math.floor(640 / count));
    const size = count * cell;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000000";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(c * cell, r * cell, cell, cell);
      }
    }
  } catch (_) {
    canvas.width = 260;
    canvas.height = 80;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#9e2430";
    ctx.font = "12px monospace";
    ctx.fillText("QR too large. Copy the long code.", 10, 40);
  }
}

function copyLanCode() {
  const area = document.getElementById("lanCode");
  if (!area) return;
  area.focus();
  area.select();
  area.setSelectionRange(0, 999999);
  try {
    navigator.clipboard.writeText(area.value);
  } catch (_) {
    try {
      document.execCommand("copy");
    } catch (__) {
      log.debug("net/lan.copyLanCode", __);
    }
  }
}

function downloadLanQR() {
  const canvas = document.getElementById("lanQR");
  if (!canvas) return;
  const a = document.createElement("a");
  a.download = "tetrizz-lan-code.png";
  a.href = canvas.toDataURL("image/png");
  a.click();
}

async function shareLanQR() {
  const canvas = document.getElementById("lanQR");
  if (!canvas) return;
  canvas.toBlob(async function (blob) {
    if (!blob) {
      downloadLanQR();
      return;
    }
    const file = new File([blob], "tetrizz-lan-code.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "TetriZZ LAN Code" });
        return;
      } catch (_) {
        log.debug("net/lan.shareLanQR", _);
      }
    }
    downloadLanQR();
  });
}

function lanCleanCode(code) {
  return String(code || "")
    .replace(/\s+/g, "")
    .trim();
}

function lanHandleIncomingCode(code) {
  const c = lanCleanCode(code);
  if (!c) {
    lanSetStatus("EMPTY CODE");
    return;
  }
  if (lanState.lanUiMode === "host") lanLoadAnswer(c);
  else if (lanState.lanUiMode === "guest") lanGuestProcessOffer(c);
  else lanSetStatus("OPEN CREATE OR JOIN FIRST");
}

async function decodeLanCanvas(canvas) {
  if ("BarcodeDetector" in window) {
    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const codes = await detector.detect(canvas);
      if (codes && codes.length) return codes[0].rawValue;
    } catch (_) {
      log.debug("net/lan.decodeLanCanvas", _);
    }
  }
  if (typeof jsQR === "function") {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    if (code) return code.data;
  }
  return null;
}

async function scanLanCamera() {
  if (!ensureLanLibs()) return;
  const old = document.getElementById("lanCameraOverlay");
  if (old) old.remove();

  try {
    lanState.lanCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
  } catch (_) {
    alert("Camera not available. Use READ FROM FILE or paste the code.");
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "lanCameraOverlay";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:100000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px";
  overlay.innerHTML =
    "<div style=\"color:#fff;font:600 15px/1.4 'Chakra Petch',sans-serif;letter-spacing:.08em;text-align:center\">POINT CAMERA AT QR CODE</div>";

  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.style.cssText = "width:min(90vw,420px);border-radius:10px;background:#000";
  overlay.appendChild(video);

  const cancel = document.createElement("button");
  cancel.className = "menu-btn danger";
  cancel.textContent = "CANCEL";
  overlay.appendChild(cancel);

  document.body.appendChild(overlay);
  video.srcObject = lanState.lanCameraStream;
  await video.play();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  lanState.lanScanActive = true;

  cancel.onclick = function () {
    stopLanScan();
    overlay.remove();
  };

  async function tick() {
    if (!lanState.lanScanActive) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const text = await decodeLanCanvas(canvas);
      if (text) {
        stopLanScan();
        overlay.remove();
        lanHandleIncomingCode(text);
        return;
      }
    }
    lanState.lanScanRaf = requestAnimationFrame(tick);
  }
  tick();
}

function stopLanScan() {
  lanState.lanScanActive = false;
  if (lanState.lanScanRaf) cancelAnimationFrame(lanState.lanScanRaf);
  lanState.lanScanRaf = null;
  if (lanState.lanCameraStream) {
    lanState.lanCameraStream.getTracks().forEach(function (t) {
      t.stop();
    });
    lanState.lanCameraStream = null;
  }
}

async function loadLanQRFromFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!ensureLanLibs()) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = async function () {
    try {
      const canvas = document.createElement("canvas");
      const max = 1800;
      let w = img.width,
        h = img.height;
      if (w > max || h > max) {
        const ratio = Math.min(max / w, max / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const text = await decodeLanCanvas(canvas);
      if (text) lanHandleIncomingCode(text);
      else alert("No QR code found in that image.");
    } finally {
      URL.revokeObjectURL(url);
      e.target.value = "";
    }
  };
  img.onerror = function () {
    URL.revokeObjectURL(url);
    e.target.value = "";
    alert("Could not read that image.");
  };
  img.src = url;
}

export const RELAY = {
  peer: null,
  hostConn: null,
  conns: new Map(),
  joined: false,
  joinTimer: null,
  joiningRoom: "",
  pendingPwd: "",
  ice: null,
  retry: 0,
};

export function relaySettings() {
  const s = Object.assign({}, versusLobbyState.vs);
  delete s.players;
  s.seed = onlineSessionState.onlineSeed;
  s.pwdH = roomPwdH();
  return s;
}
