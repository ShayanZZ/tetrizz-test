import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isPlayerKey,
  keyMatchesId,
  PLAYER_ID_LENGTH,
  playerIdFromKey,
  sha256,
  sha256Hex,
} from "@tetrizz/protocol";
import {
  loadIdentity,
  PLAYER_KEY_STORAGE,
  type IdentityDeps,
} from "../../apps/web/src/net/identity";

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("SHA-256", () => {
  it("matches the known test vectors", () => {
    expect(hexOf(sha256(new Uint8Array()))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches Node's own hash for every length around the block boundaries", () => {
    for (let length = 0; length <= 200; length++) {
      const bytes = new Uint8Array(randomBytes(length));
      expect(hexOf(sha256(bytes))).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });
});

describe("player identity", () => {
  const key = "0123456789abcdef".repeat(4);

  it("accepts only 64 lowercase hex characters as a key", () => {
    expect(isPlayerKey(key)).toBe(true);
    for (const bad of [
      key.slice(1),
      key + "0",
      key.toUpperCase(),
      key.replace(/^0/, "g"),
      "",
      7,
      null,
    ]) {
      expect(isPlayerKey(bad)).toBe(false);
    }
  });

  it("derives a stable, public-safe id from a key", () => {
    const id = playerIdFromKey(key);
    expect(id).toMatch(new RegExp(`^[0-9a-f]{${PLAYER_ID_LENGTH}}$`));
    expect(playerIdFromKey(key)).toBe(id);
    expect(id).toBe(
      createHash("sha256").update(`tetrizz-player-id-v1:${key}`).digest("hex").slice(0, 32),
    );
    expect(id).not.toContain(key.slice(0, 8));
    expect(playerIdFromKey("f".repeat(64))).not.toBe(id);
  });

  it("recognises an id only with the key it came from", () => {
    const id = playerIdFromKey(key);
    expect(keyMatchesId(key, id)).toBe(true);
    expect(keyMatchesId("f".repeat(64), id)).toBe(false);
    expect(keyMatchesId(undefined, id)).toBe(false);
    expect(keyMatchesId(key, undefined)).toBe(false);
    expect(keyMatchesId(key, id.toUpperCase())).toBe(false);
    expect(keyMatchesId(id, id)).toBe(false);
  });
});

describe("the page's identity", () => {
  function setup(stored: { tab?: string; local?: string; oldId?: string } = {}) {
    const tab = new Map<string, string>(stored.tab ? [[PLAYER_KEY_STORAGE, stored.tab]] : []);
    const local = new Map<string, string>(stored.local ? [[PLAYER_KEY_STORAGE, stored.local]] : []);
    if (stored.oldId) local.set("tetris_pid", stored.oldId);
    const warnings: string[] = [];
    let counter = 1;
    const deps: IdentityDeps = {
      tab: { get: (k) => tab.get(k) ?? null, set: (k, v) => void tab.set(k, v) },
      local: {
        get: (k) => local.get(k) ?? null,
        set: (k, v) => void local.set(k, v),
        remove: (k) => void local.delete(k),
      },
      randomBytes: (count) => new Uint8Array(count).fill(counter++),
      warn: (scope) => void warnings.push(scope),
    };
    return { deps, tab, local, warnings };
  }

  it("makes a key on the first visit, keeps it in both stores and derives the id from it", () => {
    const { deps, tab, local } = setup({ oldId: "k3j2h1g0abcd" });
    const identity = loadIdentity(deps);
    expect(isPlayerKey(identity.key)).toBe(true);
    expect(identity.id).toBe(playerIdFromKey(identity.key));
    expect(tab.get(PLAYER_KEY_STORAGE)).toBe(identity.key);
    expect(local.get(PLAYER_KEY_STORAGE)).toBe(identity.key);
    expect(local.has("tetris_pid")).toBe(false);
  });

  it("is the same player on every later visit, and the tab's own key wins over the browser's", () => {
    const first = loadIdentity(setup().deps);
    const again = setup({ local: first.key });
    expect(loadIdentity(again.deps)).toEqual(first);

    const other = "ab".repeat(32);
    const both = setup({ tab: other, local: first.key });
    expect(loadIdentity(both.deps).key).toBe(other);
    expect(both.local.get(PLAYER_KEY_STORAGE)).toBe(other);
  });

  it("replaces a stored value that is not a key", () => {
    const { deps } = setup({ local: "pid-a", tab: "x".repeat(64) });
    expect(isPlayerKey(loadIdentity(deps).key)).toBe(true);
  });

  it("still gives an identity when storage refuses writes, and says so", () => {
    const { deps, warnings } = setup();
    const broken: IdentityDeps = {
      ...deps,
      local: {
        ...deps.local,
        set: () => {
          throw new Error("quota");
        },
      },
    };
    expect(isPlayerKey(loadIdentity(broken).key)).toBe(true);
    expect(warnings).toContain("net/identity.write");
  });

  it("throws, rather than make a weak key, when there is no cryptographic randomness", () => {
    const { deps } = setup();
    const none: IdentityDeps = {
      ...deps,
      randomBytes: () => {
        throw new Error("no crypto");
      },
    };
    expect(() => loadIdentity(none)).toThrow("no crypto");
  });
});
