// @ts-nocheck
import { clock } from "../core/clock";
import { log, swallow } from "../core/logger";
import { storage } from "../core/storage";
import { setDVH } from "../core/config";
import { game } from "../game/state";
import { $, layout } from "../ui/layout";
import { clearSession, openOverlay, syncContinueBtn } from "../game/game";
import { frame } from "../ui/screens";
import { onlineSessionState } from "../net/online-session";
import { isStandalone, replayState } from "../replay/replay";
import {
  closeInstallPop,
  installDismiss,
  installPopShown,
  openInstallPop,
  runInstallFlow,
} from "../ui/install";

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  replayState._installEvt = e;
  const b = $("installBtn");
  if (b) b.style.display = "";
  if (installPopShown()) {
    const s = $("ipopSteps"),
      sub = $("ipopSub"),
      btn = $("ipopInstall");
    if (s) s.classList.remove("show");
    if (btn) btn.textContent = "INSTALL APP";
    if (sub)
      sub.textContent =
        "Install the app for full screen, offline play and its own home-screen icon.";
  }
});

window.addEventListener("appinstalled", () => {
  replayState._installEvt = null;
  const b = $("installBtn");
  if (b) b.style.display = "none";
  closeInstallPop();
});

document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "installPop") {
    closeInstallPop();
    installDismiss(1);
    return;
  }
  const t = e.target.closest ? e.target.closest("button") : null;
  if (!t) return;
  if (t.id === "ipopInstall") {
    if (replayState._installEvt) runInstallFlow();
    else {
      closeInstallPop();
      installDismiss(7);
    }
    return;
  }
});

if (isStandalone()) {
  const _ib = $("installBtn");
  if (_ib) _ib.style.display = "none";
}

setTimeout(() => {
  if (isStandalone()) return;
  if (onlineSessionState.onlineRoomId !== undefined && onlineSessionState.onlineRoomId) return;
  if (replayState._autoRoom !== undefined && replayState._autoRoom) return;
  let until = 0;
  try {
    until = parseInt(storage.get("tetris_ipop")) || 0;
  } catch (_) {
    log.debug("boot/36-install", _);
  }
  if (clock.wall() < until) return;
  openInstallPop();
}, 1200);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(swallow("boot/install.serviceWorker"));
}

requestAnimationFrame((ts) => {
  game.lastTs = ts;
  requestAnimationFrame(frame);
});

setTimeout(function () {
  setDVH();
  layout();
}, 350);

if (replayState._autoRoom) clearSession();

openOverlay($("ovStart"));

syncContinueBtn();

(function () {
  const rows = [...document.querySelectorAll(".lib-row")];
  function fit(r) {
    r.classList.remove("split");
    let over = false;
    r.querySelectorAll(".menu-btn").forEach((b) => {
      if (b.scrollWidth > b.clientWidth + 1) over = true;
    });
    if (over) r.classList.add("split");
  }
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver((es) => es.forEach((e) => fit(e.target)));
    rows.forEach((r) => ro.observe(r));
  }
  addEventListener("resize", () => rows.forEach(fit));
  rows.forEach(fit);
})();

document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("[data-nbstep]");
  if (!b) return;
  const p = b.dataset.nbstep.split(":"),
    inp = $(p[0] === "W" ? "nbW" : "nbH");
  if (!inp) return;
  const mn = +inp.min || 4,
    mx = +inp.max || 40;
  inp.value = Math.max(mn, Math.min(mx, (parseInt(inp.value, 10) || mn) + +p[1]));
});
