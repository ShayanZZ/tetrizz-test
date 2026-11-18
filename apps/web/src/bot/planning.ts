/**
 * Where bot planning runs. A plan is a pure function of a small data object, so it can be computed
 * by a pool of web workers while the page keeps drawing, or, when workers are unavailable or
 * switched off, by stepping the same generator on the page's own thread.
 *
 * `tetris_botworker` selects the mode: `0` keeps planning on the page thread, a number from 1 to 4
 * sets the pool size, and anything else sizes the pool from the processor count.
 *
 * While the page is hidden planning always runs on the page thread: a worker's answer can only be
 * handled between two ticks of the background timer, which would limit a bot to about one piece
 * per tick however fast it is set to play.
 */
import {
  createPlanGen,
  type PlanConfig,
  type PlanContext,
  type PlanKind,
  type PlanResponse,
  type PlanResult,
} from "@tetrizz/bot";
import BotWorker from "./worker-entry?worker&inline";
import { clock } from "../core/clock";
import { log } from "../core/logger";
import { recordWorkerPlan } from "../core/metrics";
import { storage } from "../core/storage";

/** A planning request that is either waiting for a worker or handed back to the page thread. */
export interface PlanHandle {
  readonly kind: PlanKind;
  readonly cfg: PlanConfig;
  /** Filled when a worker answers. */
  result: PlanResult | null;
  /** Set when the worker could not finish: step it on the page thread like any generator. */
  gen: Generator<unknown, PlanResult> | null;
  readonly startedAt: number;
}

/** How long a worker may take before its request is moved back to the page thread. */
const WORKER_PATIENCE_MS = 3000;
const MAX_POOL_SIZE = 4;

interface PoolWorker {
  worker: Worker;
  inFlight: number;
}

const pool = {
  workers: [] as PoolWorker[],
  pending: new Map<number, { handle: PlanHandle; owner: PoolWorker }>(),
  nextId: 1,
  /** `unset` until the first request, then `on` or `off`. */
  state: "unset" as "unset" | "on" | "off",
};

function poolSizeFromSettings(): number {
  let setting: string | null = null;
  try {
    setting = storage.get("tetris_botworker");
  } catch (error) {
    log.debug("planning.poolSize", error);
  }
  if (setting === "0") return 0;
  const asked = Number(setting);
  if (Number.isInteger(asked) && asked >= 1) return Math.min(asked, MAX_POOL_SIZE);
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(cores - 1, 3));
}

function giveBack(handle: PlanHandle): void {
  if (!handle.gen && !handle.result) handle.gen = createPlanGen(handle.kind, handle.cfg);
}

/** Stops using workers for the rest of the session and returns every waiting request. */
function disablePool(reason: string, detail?: unknown): void {
  log.warn("planning.disable", reason, detail);
  pool.state = "off";
  for (const { handle } of pool.pending.values()) giveBack(handle);
  pool.pending.clear();
  for (const { worker } of pool.workers) worker.terminate();
  pool.workers.length = 0;
}

function onWorkerMessage(event: MessageEvent<PlanResponse>): void {
  const answer = event.data;
  const entry = pool.pending.get(answer.id);
  if (!entry) return;
  pool.pending.delete(answer.id);
  entry.owner.inFlight--;
  if (answer.ok) {
    entry.handle.result = answer.res;
    recordWorkerPlan(clock.now() - entry.handle.startedAt);
  } else {
    log.warn("planning.worker", answer.error);
    giveBack(entry.handle);
  }
}

function startPool(): void {
  const size = typeof Worker === "undefined" ? 0 : poolSizeFromSettings();
  if (size === 0) {
    pool.state = "off";
    return;
  }
  try {
    for (let i = 0; i < size; i++) {
      const worker = new BotWorker({ name: "tetrizz-bot-" + i });
      worker.onmessage = onWorkerMessage;
      worker.onerror = (event) => disablePool("worker error", event.message);
      worker.onmessageerror = () => disablePool("unreadable worker message");
      pool.workers.push({ worker, inFlight: 0 });
    }
    pool.state = "on";
  } catch (error) {
    disablePool("workers could not start", error);
  }
}

/** True when new plans are computed by workers. Starts the pool the first time it is asked. */
export function botPlanningOffloaded(): boolean {
  if (pool.state === "unset") startPool();
  return pool.state === "on" && !(typeof document !== "undefined" && document.hidden);
}

/**
 * Starts computing a plan. With workers the handle's `result` fills in later; without them the
 * handle carries a generator that the caller steps within its own time budget.
 */
export function startPlan(kind: PlanKind, cfg: PlanConfig, ctx: PlanContext): PlanHandle {
  const handle: PlanHandle = { kind, cfg, result: null, gen: null, startedAt: clock.now() };
  if (!botPlanningOffloaded()) {
    handle.gen = createPlanGen(kind, cfg);
    return handle;
  }
  const owner = pool.workers.reduce((best, w) => (w.inFlight < best.inFlight ? w : best));
  const id = pool.nextId++;
  pool.pending.set(id, { handle, owner });
  owner.inFlight++;
  owner.worker.postMessage({ id, kind, cfg, ctx });
  return handle;
}

/**
 * Moves a request that has waited too long back to the page thread and stops using workers, so a
 * stuck worker can never freeze a bot.
 */
export function checkPlanHandle(handle: PlanHandle): void {
  if (handle.result || handle.gen) return;
  if (clock.now() - handle.startedAt > WORKER_PATIENCE_MS) disablePool("worker too slow");
}

/** Counts of requests still waiting for a worker, for the debug metrics. */
export function planningStats(): { workers: number; waiting: number } {
  return { workers: pool.workers.length, waiting: pool.pending.size };
}
