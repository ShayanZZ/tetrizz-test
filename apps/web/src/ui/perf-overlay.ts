/**
 * Debug overlay with frame times and bot thinking figures. Hidden by default; tapping the version
 * label five times within two seconds shows or hides it, and the choice is remembered.
 */
import { planningStats } from "../bot/planning";
import { clock } from "../core/clock";
import { log } from "../core/logger";
import { frameStats, perfState, planCounts } from "../core/metrics";
import { storage } from "../core/storage";
import { game } from "../game/state";
import { layoutState } from "./layout";

const TAPS_TO_TOGGLE = 5;
const TAP_WINDOW_MS = 2000;
const REFRESH_MS = 500;

let panel: HTMLElement | null = null;
let timer = 0;

function fixed(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function text(): string {
  const f = frameStats();
  const plans = planCounts();
  const pool = planningStats();
  return [
    `${fixed(f.fps, 0)} fps   median ${fixed(f.medianMs)}  p95 ${fixed(f.p95Ms)}  max ${fixed(f.maxMs)} ms`,
    `frame work ${fixed(f.workMs)} ms   page think ${fixed(f.thinkMs)} ms/frame`,
    `plans: page ${plans.page}  worker ${plans.worker} (${fixed(plans.workerTripMs, 0)} ms trip)`,
    `workers ${pool.workers}  waiting ${pool.waiting}   quality tier ${perfState.tier}`,
    `state ${game.state}   dpr ${fixed(layoutState.dpr, 2)}`,
  ].join("\n");
}

function refresh(): void {
  if (panel) panel.textContent = text();
}

function show(): void {
  if (panel) return;
  panel = document.createElement("pre");
  panel.id = "perfOverlay";
  panel.setAttribute("aria-hidden", "true");
  document.body.appendChild(panel);
  refresh();
  timer = window.setInterval(refresh, REFRESH_MS);
}

function hide(): void {
  window.clearInterval(timer);
  panel?.remove();
  panel = null;
}

function setVisible(visible: boolean): void {
  if (visible) show();
  else hide();
  try {
    storage.set("tetris_debug", visible ? "1" : "0");
  } catch (error) {
    log.debug("perfOverlay.save", error);
  }
}

export function initPerfOverlay(): void {
  let wanted = false;
  try {
    wanted = storage.get("tetris_debug") === "1";
  } catch (error) {
    log.debug("perfOverlay.load", error);
  }
  if (wanted) show();
  const label = document.getElementById("appVersion");
  if (!label) return;
  let taps = 0;
  let firstTap = 0;
  label.addEventListener("click", () => {
    const now = clock.wall();
    if (taps === 0 || now - firstTap > TAP_WINDOW_MS) {
      taps = 0;
      firstTap = now;
    }
    if (++taps >= TAPS_TO_TOGGLE) {
      taps = 0;
      setVisible(panel === null);
    }
  });
}
