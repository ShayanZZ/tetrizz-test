import { beforeEach, describe, expect, it } from "vitest";
import {
  ADAPTIVE_DEFAULTS,
  createAdaptiveController,
  frameStats,
  planCounts,
  recordFrame,
  recordPageThink,
  recordWorkerPlan,
  resetFrameStats,
} from "../../apps/web/src/core/metrics";

describe("frame statistics", () => {
  beforeEach(() => resetFrameStats());

  it("reports median, p95 and max of the recorded gaps", () => {
    for (let i = 1; i <= 100; i++) recordFrame(i, 2);
    const stats = frameStats();
    expect(stats.frames).toBe(100);
    expect(stats.medianMs).toBe(51);
    expect(stats.p95Ms).toBe(96);
    expect(stats.maxMs).toBe(100);
    expect(stats.workMs).toBeCloseTo(2);
  });

  it("keeps only the latest window of frames", () => {
    for (let i = 0; i < 500; i++) recordFrame(100, 1);
    for (let i = 0; i < 120; i++) recordFrame(10, 1);
    const stats = frameStats();
    expect(stats.frames).toBe(120);
    expect(stats.medianMs).toBe(10);
  });

  it("attributes page-thread thinking to the frame it happened in", () => {
    recordPageThink(3);
    recordPageThink(1);
    recordFrame(16, 5);
    recordFrame(16, 5);
    expect(frameStats().thinkMs).toBeCloseTo(2);
  });

  it("smooths the worker round trip", () => {
    const before = planCounts().worker;
    recordWorkerPlan(10);
    recordWorkerPlan(20);
    const counts = planCounts();
    expect(counts.worker).toBe(before + 2);
    expect(counts.workerTripMs).toBeGreaterThan(0);
  });
});

describe("adaptive quality controller", () => {
  const slow = ADAPTIVE_DEFAULTS.slowMs + 10;
  const fast = ADAPTIVE_DEFAULTS.fastMs - 5;

  it("stays at full quality while frames are fast", () => {
    const c = createAdaptiveController();
    for (let i = 0; i < 100; i++) c.check(fast);
    expect(c.tier).toBe(0);
  });

  it("goes up one tier after enough slow checks and no further than the maximum", () => {
    const c = createAdaptiveController();
    for (let i = 0; i < ADAPTIVE_DEFAULTS.slowChecks - 1; i++) c.check(slow);
    expect(c.tier).toBe(0);
    c.check(slow);
    expect(c.tier).toBe(1);
    for (let i = 0; i < 50; i++) c.check(slow);
    expect(c.tier).toBe(ADAPTIVE_DEFAULTS.maxTier);
  });

  it("is not moved by a single slow check in between fast ones", () => {
    const c = createAdaptiveController();
    for (let i = 0; i < 30; i++) {
      c.check(slow);
      c.check(fast);
    }
    expect(c.tier).toBe(0);
  });

  it("comes back down only after a long run of fast checks", () => {
    const c = createAdaptiveController();
    for (let i = 0; i < 50; i++) c.check(slow);
    expect(c.tier).toBe(ADAPTIVE_DEFAULTS.maxTier);
    for (let i = 0; i < ADAPTIVE_DEFAULTS.fastChecks - 1; i++) c.check(fast);
    expect(c.tier).toBe(ADAPTIVE_DEFAULTS.maxTier);
    c.check(fast);
    expect(c.tier).toBe(ADAPTIVE_DEFAULTS.maxTier - 1);
  });

  it("does not change in the middle band", () => {
    const c = createAdaptiveController();
    for (let i = 0; i < 50; i++) c.check(slow);
    const before = c.tier;
    const middle = (ADAPTIVE_DEFAULTS.slowMs + ADAPTIVE_DEFAULTS.fastMs) / 2;
    for (let i = 0; i < 100; i++) c.check(middle);
    expect(c.tier).toBe(before);
  });
});
