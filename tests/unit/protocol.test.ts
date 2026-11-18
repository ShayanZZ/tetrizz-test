import { describe, expect, it } from "vitest";
import {
  checkPeerVersion,
  LEGACY_PROTOCOL_VERSION,
  NET_EVENTS,
  PROTOCOL_MIN_VERSION,
  PROTOCOL_VERSION,
  peerVersion,
} from "@tetrizz/protocol";

describe("protocol version", () => {
  it("keeps the first wire format as version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(LEGACY_PROTOCOL_VERSION).toBe(1);
    expect(PROTOCOL_MIN_VERSION).toBeLessThanOrEqual(PROTOCOL_VERSION);
  });

  it("treats a peer that sends no version as the legacy version", () => {
    for (const missing of [undefined, null, "", "2", 0, -3, 1.5, NaN, {}, []]) {
      expect(peerVersion(missing)).toBe(LEGACY_PROTOCOL_VERSION);
      expect(checkPeerVersion(missing)).toBe("ok");
    }
  });

  it("accepts the current version and refuses a newer one", () => {
    expect(checkPeerVersion(PROTOCOL_VERSION)).toBe("ok");
    expect(checkPeerVersion(PROTOCOL_VERSION + 1)).toBe("peer-too-new");
    expect(checkPeerVersion(PROTOCOL_VERSION + 40)).toBe("peer-too-new");
  });
});

describe("event names", () => {
  it("lists every event once", () => {
    expect(new Set(NET_EVENTS).size).toBe(NET_EVENTS.length);
  });
});
