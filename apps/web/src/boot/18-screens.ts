// @ts-nocheck
import { clock } from "../core/clock";
import { storage } from "../core/storage";
import { setDVH } from "../core/config";
import { game } from "../game/state";
import { $, cancelRestartHold, layoutSoon, layoutState } from "../ui/layout";
import { gameState, saveSession } from "../game/game";
import {
  closePieceModal,
  editPointerDown,
  editPointerMove,
  editPointerUp,
  openPieceModal,
} from "../practice/practice";
import { stopStepHold } from "../practice/snapshot";
import { swipeDown, swipeMove, swipeUp } from "../ui/controls";
import {
  MP_RULES_HTML,
  VSM_GRID_HTML,
  hideTip,
  scheduleVisibleFrame,
  screensState,
  showTip,
  startHiddenLoop,
  stopHiddenLoop,
} from "../ui/screens";
import { onlineSessionState } from "../net/online-session";
import { netSend } from "../net/transport";

window.addEventListener("pointerdown", swipeDown, { passive: false });

window.addEventListener(
  "pointerdown",
  () => {
    gameState._ptrInput = true;
  },
  true,
);

window.addEventListener("pointermove", swipeMove, { passive: false });

window.addEventListener("pointerup", swipeUp);

window.addEventListener("pointercancel", swipeUp);

layoutState.wrap.addEventListener("pointerdown", editPointerDown, { passive: false });

layoutState.wrap.addEventListener("pointermove", editPointerMove, { passive: false });

window.addEventListener("pointerup", editPointerUp);

window.addEventListener("pointercancel", editPointerUp);

layoutState.wrap.addEventListener("contextmenu", (e) => {
  if (game.editMode) e.preventDefault();
});

layoutState.holdCv.addEventListener("pointerdown", (e) => {
  if (!game.editMode) return;
  e.preventDefault();
  e.stopPropagation();
  openPieceModal("hold", 0);
});

layoutState.nextCvs.forEach((cv, i) => {
  cv.addEventListener("pointerdown", (e) => {
    if (!game.editMode) return;
    e.preventDefault();
    e.stopPropagation();
    openPieceModal("next", i);
  });
});

$("pieceModal").addEventListener("pointerdown", (e) => {
  if (e.target.id === "pieceModal") closePieceModal();
});

screensState.ONLINE_LOBBY_INNER = `<div class="sticky-bar"><button class="back-btn" id="onlineLobbyBackBtn" type="button">‹ BACK</button><span class="bar-title">Online</span><span class="bar-right"><button class="save-btn" id="onlineLeaveBtn" type="button" style="background:var(--red);display:none">LEAVE</button></span></div><div class="screen-body"><div id="onlineReconnecting" style="display:none;text-align:center;padding:46px 20px"><svg class="rc-spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9.2" stroke="rgba(255,210,63,.16)" stroke-width="2.6"/><path d="M21.2 12a9.2 9.2 0 0 0-9.2-9.2" stroke="var(--gold)" stroke-width="2.6" stroke-linecap="round"/></svg><div id="rcTitle" style="font:700 22px/1.3 'Chakra Petch',sans-serif;letter-spacing:.12em;color:var(--gold);text-shadow:0 0 16px rgba(255,210,63,.4);margin-bottom:12px">RECONNECTING…</div><div id="rcSub" style="font:500 13px/1.6 'IBM Plex Mono',monospace;color:var(--mut2)">Restoring your match. Please wait.</div><div id="rcNote" class="dev-note" style="min-height:16px;margin-top:10px"></div><div class="rc-btns"><button class="menu-btn" id="btnRetryReconnect" style="display:none;width:auto;min-width:150px;padding:12px 22px" type="button">RETRY</button><button class="menu-btn danger" id="btnCancelReconnect" style="width:auto;min-width:150px;padding:12px 22px" type="button">CANCEL</button></div></div><div id="onlineSetup" class="settings"><div class="grp-title">Profile</div><div class="step"><span class="lb">USERNAME</span><span class="ctl"><input type="text" id="onlineUsername" class="tp-name" maxlength="12" placeholder="PLAYER" value="${storage.get("tetris_username") || ""}"></span></div><div class="grp-title">Create a Room</div><div class="step"><span class="lb">ENABLE PASSWORD</span><span class="ctl"><button class="tgl off" id="tglOnlinePwd" type="button">OFF</button></span></div><div class="step" id="stepOnlinePwd" style="display:none"><span class="lb">PASSWORD</span><span class="ctl"><input type="password" id="onlineRoomPassword" class="tp-name" maxlength="16" placeholder="ENTER PASSWORD"></span></div><div class="start-wrap" style="margin-top:min(1.8vh,14px)"><button class="menu-btn primary ol-action-btn" id="btnCreateRoom" type="button">CREATE ROOM</button></div><div class="grp-title">Join a Room</div><div class="step"><span class="lb">ROOM CODE</span><span class="ctl"><input type="text" id="onlineRoomCodeInput" class="tp-name online-code-input" maxlength="6" placeholder="ABCDEF"></span></div><div class="start-wrap" style="margin-top:min(1.8vh,14px)"><button class="menu-btn primary ol-action-btn" id="btnConfirmJoin" type="button">JOIN ROOM</button></div><div class="dev-note ol-note" id="onlineStatusNote" style="margin-top:min(1.2vh,10px)"></div></div><div id="onlineLobby" style="display:none"><div class="settings"><div class="start-wrap"><button class="menu-btn primary" id="btnStartOnlineGame" type="button" style="display:none">START MATCH</button><div id="onlineWaitingMsg" class="dev-note" style="text-align:center;display:none">Waiting for host to start the match…</div></div><div class="online-lobby-box"><div style="text-align:center;color:var(--mut2);letter-spacing:.1em;font-size:12px">ROOM CODE</div><div class="room-code" id="displayRoomCode">----</div><div class="ol-row"><button class="copy-btn" id="btnCopyCode">COPY CODE</button><button class="share-btn" id="btnShareLink">SHARE LINK</button></div></div><div class="online-lobby-box" id="olPwdBox" style="display:none"><div style="text-align:center;color:var(--mut2);letter-spacing:.1em;font-size:12px">ROOM PASSWORD</div><div class="room-code" id="displayRoomPwd" style="font-size:22px;letter-spacing:6px">----</div><div class="ol-row"><button class="copy-btn" id="btnChangePwd" type="button">CHANGE PASSWORD</button></div></div><div id="onlineProgressBox" style="display:none;background:linear-gradient(180deg,rgba(255,210,63,.08),rgba(255,210,63,.02));border:1px solid rgba(255,210,63,.35);border-radius:12px;padding:16px 18px;margin-bottom:14px;text-align:center;box-shadow:0 0 20px -8px rgba(255,210,63,.4)"></div><div class="grp-title">Players</div><div id="onlinePlayerList" class="bindList" style="margin-bottom:10px"></div><div class="start-wrap" style="margin:0 0 14px"><button class="save-btn" id="btnToPlayer" type="button" style="display:none">JOIN AS PLAYER</button></div><div class="grp-title">Spectators</div><div id="onlineSpecList" class="bindList" style="margin-bottom:10px"></div><div class="start-wrap" style="margin:0 0 14px"><button class="save-btn" id="btnToSpec" type="button" style="display:none">MOVE TO SPECTATORS</button></div><div id="onlineHostControls" style="display:none"><div class="grp-title">Game Mode</div>${VSM_GRID_HTML}${MP_RULES_HTML}</div><div class="dev-note warn" data-editnote></div></div></div></div>`;

document.addEventListener(
  "pointerdown",
  (e) => {
    if (e.pointerType === "mouse") return;
    const lb = e.target.closest && e.target.closest(".lb");
    if (lb && lb.hasAttribute("title") && lb.closest(".overlay")) {
      showTip(lb);
      return;
    }
  },
  true,
);

document.addEventListener("scroll", hideTip, true);

document.addEventListener("visibilitychange", () => {
  cancelRestartHold();
  stopStepHold();

  if (document.hidden) {
    saveSession();
    startHiddenLoop();
  } else {
    stopHiddenLoop();
    setDVH();
    game.lastTs = clock.now();
    scheduleVisibleFrame();
    layoutSoon(120);
    if (onlineSessionState.onlineRoomId) netSend("hb", { sender: onlineSessionState.myPlayerId });
  }
});
