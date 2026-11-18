import { describe, expect, it } from "vitest";
import { isOriginAllowed, type OriginPolicy } from "../../apps/server/src/origin";

const policy = (over: Partial<OriginPolicy> = {}): OriginPolicy => ({
  allowed: new Set(["https://play.example"]),
  allowSameOrigin: true,
  allowFile: false,
  allowMissing: false,
  ...over,
});

describe("origin allowlist", () => {
  it("lets a listed origin in, with any case or default port spelling", () => {
    expect(isOriginAllowed(policy(), "https://play.example", "api.example")).toBe(true);
    expect(isOriginAllowed(policy(), "https://PLAY.example:443", "api.example")).toBe(true);
  });

  it("refuses an origin that is not listed or differs in scheme or port", () => {
    expect(isOriginAllowed(policy(), "https://evil.example", "api.example")).toBe(false);
    expect(isOriginAllowed(policy(), "http://play.example", "api.example")).toBe(false);
    expect(isOriginAllowed(policy(), "https://play.example:8443", "api.example")).toBe(false);
    expect(isOriginAllowed(policy(), "https://play.example.evil.example", "x")).toBe(false);
  });

  it("allows the page's own host when same-origin is on, and not when it is off", () => {
    expect(isOriginAllowed(policy(), "https://api.example", "api.example")).toBe(true);
    expect(isOriginAllowed(policy(), "http://127.0.0.1:8787", "127.0.0.1:8787")).toBe(true);
    expect(isOriginAllowed(policy(), "https://api.example", "API.example")).toBe(true);
    expect(isOriginAllowed(policy(), "https://api.example", "other.example")).toBe(false);
    expect(isOriginAllowed(policy(), "https://api.example", undefined)).toBe(false);
    expect(
      isOriginAllowed(policy({ allowSameOrigin: false }), "https://api.example", "api.example"),
    ).toBe(false);
  });

  it("answers the null origin and a missing header only when the operator allows them", () => {
    expect(isOriginAllowed(policy(), "null", "api.example")).toBe(false);
    expect(isOriginAllowed(policy({ allowFile: true }), "null", "api.example")).toBe(true);
    expect(isOriginAllowed(policy(), undefined, "api.example")).toBe(false);
    expect(isOriginAllowed(policy({ allowMissing: true }), undefined, "api.example")).toBe(true);
  });

  it("refuses values that are not http(s) origins", () => {
    for (const bad of [
      "",
      "garbage",
      "file:///tmp/x.html",
      "chrome-extension://abc",
      "javascript:1",
    ]) {
      expect(isOriginAllowed(policy({ allowFile: true }), bad, "api.example"), bad).toBe(false);
    }
  });
});
