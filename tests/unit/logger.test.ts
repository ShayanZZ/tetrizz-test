import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearLogs,
  getLogLevel,
  log,
  recentLogs,
  setLogLevel,
  swallow,
} from "../../apps/web/src/core/logger";

afterEach(() => {
  setLogLevel("warn");
  clearLogs();
  vi.restoreAllMocks();
});

describe("logger", () => {
  it("drops debug output at the default level", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    log.debug("scope", "hidden");
    expect(spy).not.toHaveBeenCalled();
    expect(recentLogs()).toHaveLength(0);
  });

  it("records and prints warnings", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    log.warn("net", "lost", 3);
    expect(spy).toHaveBeenCalledWith("[net]", "lost", 3);
    expect(recentLogs()[0]).toMatchObject({ level: "warn", scope: "net", message: "lost 3" });
  });

  it("honours the configured level and ignores unknown values", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    setLogLevel("debug");
    expect(getLogLevel()).toBe("debug");
    log.debug("s", "shown");
    expect(recentLogs()).toHaveLength(1);
    setLogLevel("nonsense");
    expect(getLogLevel()).toBe("debug");
  });

  it("keeps only the most recent entries", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let i = 0; i < 250; i++) log.error("s", String(i));
    const entries = recentLogs();
    expect(entries).toHaveLength(200);
    expect(entries[0]?.message).toBe("50");
  });

  it("swallow() returns a handler that logs at debug level", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    setLogLevel("debug");
    swallow("promise")(new Error("nope"));
    expect(recentLogs()[0]?.scope).toBe("promise");
  });
});
