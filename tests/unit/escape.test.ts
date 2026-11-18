import { describe, expect, it } from "vitest";
import { escapeHtml } from "../../apps/web/src/core/escape";

describe("escapeHtml", () => {
  it("escapes the characters that can break out of text or a quoted attribute", () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe(
      "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(escapeHtml("PLAYER 1 · LV 3")).toBe("PLAYER 1 · LV 3");
  });

  it("converts non-strings", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(null)).toBe("null");
  });

  it("escapes each character exactly once", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});
