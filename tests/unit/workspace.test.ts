import { describe, expect, it } from "vitest";
import * as core from "@tetrizz/core";
import * as bot from "@tetrizz/bot";
import { PROTOCOL_VERSION } from "@tetrizz/protocol";

describe("workspace", () => {
  it("resolves every shared package", () => {
    expect(core).toBeDefined();
    expect(bot).toBeDefined();
  });

  it("exposes a positive integer protocol version", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
