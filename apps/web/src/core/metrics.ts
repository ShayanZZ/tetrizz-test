/**
 * Frame-time and bot-think metrics, and the controller that lowers effects when frames are slow.
 * Recording is a few array writes per frame; the numbers are only worked out when something asks
 * for them (the debug overlay, or the adaptive quality check once a second).
 */

const WINDOW = 120;

const gaps = new Float32Array(WINDOW);
const works = new Float32Array(WINDOW);
const thinks = new Float32Array(WINDOW);
const scratch = new Float32Array(WINDOW);

const meter = {
  filled: 0,
  head: 0,
  /** Bot thinking done on the page thread since the last frame was recorded. */
  thinkAcc: 0,
  /** Smoothed time from sending a plan to a worker until its answer arrives. */
  workerTripMs: 0,
  workerPlans: 0,
  pagePlans: 0,
};

export interface FrameStats {
  frames: number;
  fps: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  /** Mean time spent inside the frame callback. */
  workMs: number;
  /** Mean bot thinking time on the page thread per frame. */
  thinkMs: number;
}

/** Records one frame: the time since the previous frame and the time spent in the frame callback. */
export function recordFrame(gapMs: number, workMs: number): void {
  gaps[meter.head] = gapMs;
  works[meter.head] = workMs;
  thinks[meter.head] = meter.thinkAcc;
  meter.thinkAcc = 0;
  meter.head = (meter.head + 1) % WINDOW;
  if (meter.filled < WINDOW) meter.filled++;
}

/** Adds time a bot spent planning on the page thread during the current frame. */
export function recordPageThink(ms: number): void {
  meter.thinkAcc += ms;
}

/** Counts a plan finished on the page thread. */
export function recordPagePlan(): void {
  meter.pagePlans++;
}

/** Records a plan a worker answered, with the time it took from request to answer. */
export function recordWorkerPlan(tripMs: number): void {
  meter.workerPlans++;
  meter.workerTripMs = meter.workerPlans === 1 ? tripMs : meter.workerTripMs * 0.9 + tripMs * 0.1;
}

export function planCounts(): { page: number; worker: number; workerTripMs: number } {
  return { page: meter.pagePlans, worker: meter.workerPlans, workerTripMs: meter.workerTripMs };
}

function mean(values: Float32Array, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i] ?? 0;
  return n > 0 ? sum / n : 0;
}

/** The value below which `share` (0 to 1) of the first `n` samples fall. Sorts a scratch copy. */
function percentile(values: Float32Array, n: number, share: number): number {
  if (n === 0) return 0;
  scratch.set(values.subarray(0, n));
  const view = scratch.subarray(0, n);
  view.sort();
  return view[Math.min(n - 1, Math.floor(share * n))] ?? 0;
}

export function frameStats(): FrameStats {
  const n = meter.filled;
  const medianMs = percentile(gaps, n, 0.5);
  return {
    frames: n,
    fps: medianMs > 0 ? 1000 / medianMs : 0,
    medianMs,
    p95Ms: percentile(gaps, n, 0.95),
    maxMs: percentile(gaps, n, 1),
    workMs: mean(works, n),
    thinkMs: mean(thinks, n),
  };
}

/** Forgets recorded frames, for example when a new match starts. */
export function resetFrameStats(): void {
  meter.filled = 0;
  meter.head = 0;
  meter.thinkAcc = 0;
}

export interface AdaptiveOptions {
  /** Frames slower than this (median, ms) count as slow. */
  slowMs: number;
  /** Frames faster than this (median, ms) count as fast again. */
  fastMs: number;
  /** Consecutive slow checks before the tier goes up. */
  slowChecks: number;
  /** Consecutive fast checks before the tier comes back down. */
  fastChecks: number;
  maxTier: number;
}

export const ADAPTIVE_DEFAULTS: AdaptiveOptions = {
  slowMs: 26,
  fastMs: 20,
  slowChecks: 3,
  fastChecks: 12,
  maxTier: 2,
};

/**
 * Decides how many effects to drop. Tier 0 is full quality; each step up removes more. It reacts
 * slowly in both directions so one long frame or a short dip never flips it.
 */
export function createAdaptiveController(options: AdaptiveOptions = ADAPTIVE_DEFAULTS) {
  let tier = 0;
  let slow = 0;
  let fast = 0;
  return {
    get tier(): number {
      return tier;
    },
    /** Feed the median frame time once per check (about once a second); returns the tier. */
    check(medianMs: number): number {
      if (medianMs > options.slowMs) {
        fast = 0;
        if (++slow >= options.slowChecks && tier < options.maxTier) {
          tier++;
          slow = 0;
        }
      } else if (medianMs < options.fastMs) {
        slow = 0;
        if (++fast >= options.fastChecks && tier > 0) {
          tier--;
          fast = 0;
        }
      } else {
        slow = 0;
        fast = 0;
      }
      return tier;
    },
    reset(): void {
      tier = 0;
      slow = 0;
      fast = 0;
    },
  };
}

export const perfState = {
  /** 0 = full quality, 1 = fewer particles and no floating background, 2 = no particles or bounce. */
  tier: 0,
  /** Whether the tier may change at all; off keeps full quality. */
  adaptive: true,
};
