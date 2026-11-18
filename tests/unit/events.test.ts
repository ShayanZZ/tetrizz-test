import { describe, expect, it, vi } from "vitest";
import {
  emitBefore,
  emitEvent,
  intercept,
  isIntercepted,
  onBefore,
  onEvent,
} from "../../apps/web/src/core/events";

describe("event bus", () => {
  it("calls handlers in registration order with the payload", () => {
    const calls: string[] = [];
    const offA = onEvent("fxSpin", (p) => calls.push(`a${p.dir}`));
    const offB = onEvent("fxSpin", (p) => calls.push(`b${p.dir}`));
    emitEvent("fxSpin", { dir: 1 });
    offA();
    emitEvent("fxSpin", { dir: -1 });
    offB();
    expect(calls).toEqual(["a1", "b1", "b-1"]);
  });

  it("isolates a throwing handler", () => {
    const after = vi.fn();
    const off1 = onEvent("gameOver", () => {
      throw new Error("boom");
    });
    const off2 = onEvent("gameOver", after);
    emitEvent("gameOver");
    off1();
    off2();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("passes the action's arguments to before-handlers", () => {
    const seen: number[] = [];
    const off = onBefore("vsRoundEnd", (winner) => seen.push(winner));
    emitBefore("vsRoundEnd", 2);
    off();
    emitBefore("vsRoundEnd", 3);
    expect(seen).toEqual([2]);
  });

  it("reports an interception as soon as one handler returns true", () => {
    const later = vi.fn(() => true);
    const off1 = intercept("tick", (ts) => ts > 100);
    const off2 = intercept("tick", later);
    expect(isIntercepted("tick", 50)).toBe(true);
    expect(later).toHaveBeenCalledTimes(1);
    expect(isIntercepted("tick", 500)).toBe(true);
    expect(later).toHaveBeenCalledTimes(1);
    off1();
    off2();
    expect(isIntercepted("tick", 500)).toBe(false);
  });

  it("is not intercepted when no handler is registered", () => {
    expect(isIntercepted("togglePause")).toBe(false);
  });
});
