import { describe, expect, it } from "vitest";
import { createScryptPasswords, DEFAULT_SCRYPT_COST } from "../../apps/server/src/passwords";

describe("scrypt room passwords", () => {
  const rules = createScryptPasswords();

  it("checks the right password and refuses a wrong one", () => {
    const stored = rules.hash("s3cret");
    expect(rules.verify("s3cret", stored)).toBe(true);
    expect(rules.verify("s3cret ", stored)).toBe(false);
    expect(rules.verify("S3cret", stored)).toBe(false);
    expect(rules.verify("", stored)).toBe(false);
  });

  it("stores a salted hash, never the text", () => {
    const a = rules.hash("s3cret");
    const b = rules.hash("s3cret");
    expect(a).not.toBe(b);
    expect(a).not.toContain("s3cret");
    const [kind, n, r, p, salt, key] = a.split("$");
    expect(kind).toBe("scrypt");
    expect([Number(n), Number(r), Number(p)]).toEqual([
      DEFAULT_SCRYPT_COST.N,
      DEFAULT_SCRYPT_COST.r,
      DEFAULT_SCRYPT_COST.p,
    ]);
    expect(Buffer.from(salt ?? "", "base64")).toHaveLength(16);
    expect(Buffer.from(key ?? "", "base64")).toHaveLength(32);
  });

  it("still checks a hash made with another cost, so the cost can be raised later", () => {
    const old = createScryptPasswords({ N: 1024, r: 8, p: 1 }).hash("pw");
    expect(old.startsWith("scrypt$1024$8$1$")).toBe(true);
    expect(rules.verify("pw", old)).toBe(true);
    expect(rules.verify("other", old)).toBe(false);
  });

  it("refuses a stored value that is malformed or asks for absurd work, without throwing", () => {
    const good = rules.hash("pw");
    const parts = good.split("$");
    const swap = (i: number, value: string): string =>
      parts.map((x, j) => (j === i ? value : x)).join("$");
    for (const bad of [
      "",
      "plain",
      "scrypt$16384$8$1$abc",
      swap(0, "argon2"),
      swap(1, "16383"),
      swap(1, "4294967296"),
      swap(2, "0"),
      swap(3, "99"),
      swap(4, ""),
      swap(5, "AAAA"),
    ]) {
      expect(rules.verify("pw", bad), bad).toBe(false);
    }
  });
});
