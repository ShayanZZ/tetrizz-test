// @ts-nocheck
import { clock } from "../core/clock";
import { log, swallow } from "../core/logger";
import { storage } from "../core/storage";
import { $ } from "./layout";
import { isStandalone, replayState } from "../replay/replay";

export function installDismiss(days) {
  try {
    storage.set("tetris_ipop", String(clock.wall() + days * 864e5));
  } catch (_) {
    log.debug("ui/install.installDismiss", _);
  }
}

export function installPopShown() {
  const el = $("installPop");
  return !!el && !el.classList.contains("hidden");
}

export function openInstallPop() {
  const el = $("installPop");
  if (!el || isStandalone()) return;
  const steps = $("ipopSteps"),
    sub = $("ipopSub"),
    btn = $("ipopInstall");
  steps.classList.remove("show");
  steps.innerHTML = "";
  if (replayState._installEvt) {
    sub.textContent = "Install the app for full screen, offline play and its own home-screen icon.";
    btn.textContent = "INSTALL APP";
  } else {
    const ua = navigator.userAgent || "";
    const ios =
      /iphone|ipad|ipod/i.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    btn.textContent = "GOT IT";
    if (ios) {
      sub.textContent = "iOS can't install automatically from the browser — add it manually:";
      steps.innerHTML =
        "1. Tap the <b>Share</b> button <b>⬆</b> in the bottom bar<br>2. Scroll and tap <b>Add to Home Screen</b> <b>➕</b><br>3. Tap <b>Add</b> — done!";
      steps.classList.add("show");
    } else if (/android/i.test(ua)) {
      sub.textContent = "Your browser doesn't offer automatic install here — add it manually:";
      steps.innerHTML =
        "1. Tap the browser <b>menu ⋮</b> (top right)<br>2. Tap <b>Install app</b> or <b>Add to Home screen</b><br>3. Confirm — done!";
      steps.classList.add("show");
    } else {
      sub.textContent = "Your browser doesn't offer automatic install here — add it manually:";
      steps.innerHTML =
        "1. Look for the <b>install icon ⊕</b> on the <b>right side of the address bar</b><br>2. If you don't see it, open the browser <b>menu</b> and choose <b>Install TetriZZ…</b> / <b>Save page as app</b>";
      steps.classList.add("show");
    }
  }
  el.classList.remove("hidden");
}

export function closeInstallPop() {
  const el = $("installPop");
  if (el) el.classList.add("hidden");
}

export function runInstallFlow() {
  if (isStandalone()) return;
  if (replayState._installEvt) {
    replayState._installEvt.prompt();
    replayState._installEvt.userChoice
      .then(() => {
        replayState._installEvt = null;
        const b = $("installBtn");
        if (b) b.style.display = "none";
        closeInstallPop();
        installDismiss(30);
      })
      .catch(swallow("ui/install.promptResult"));
  } else {
    openInstallPop();
  }
}
