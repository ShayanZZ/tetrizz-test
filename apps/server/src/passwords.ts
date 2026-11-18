/**
 * Room passwords. The server keeps a salted scrypt hash, never the text a player typed, so a
 * password is not in memory or in a core dump as typed. Rooms only live in memory, so there is no
 * stored copy to leak; the hash is defence in depth.
 *
 * The stored form is `scrypt$N$r$p$salt$hash` (salt and hash in base64), so the cost can be raised
 * later and old hashes still check. Hashing is synchronous (about 27 ms at the default cost), which
 * is why the app limits how many checks one address may ask for.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { PasswordRules } from "@tetrizz/protocol";

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_COST: ScryptCost = { N: 16384, r: 8, p: 1 };

const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** Room for N up to 2^17 at r = 8; the Node default (32 MiB) refuses N = 32768. */
const MAX_MEMORY = 256 * 1024 * 1024;

const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;

export function createScryptPasswords(cost: ScryptCost = DEFAULT_SCRYPT_COST): PasswordRules {
  return {
    hash(plain) {
      const salt = randomBytes(SALT_BYTES);
      const key = scryptSync(plain, salt, KEY_BYTES, { ...cost, maxmem: MAX_MEMORY });
      return [
        "scrypt",
        cost.N,
        cost.r,
        cost.p,
        salt.toString("base64"),
        key.toString("base64"),
      ].join("$");
    },
    verify(plain, stored) {
      const parts = stored.split("$");
      if (parts.length !== 6 || parts[0] !== "scrypt") return false;
      const N = Number(parts[1]);
      const r = Number(parts[2]);
      const p = Number(parts[3]);
      // Stored values come from this server, but a bad one must not turn into a huge allocation.
      if (!isPowerOfTwo(N) || N > 2 ** 17 || !(r >= 1 && r <= 32) || !(p >= 1 && p <= 16)) {
        return false;
      }
      try {
        const salt = Buffer.from(parts[4] ?? "", "base64");
        const expected = Buffer.from(parts[5] ?? "", "base64");
        if (!salt.length || expected.length !== KEY_BYTES) return false;
        const actual = scryptSync(plain, salt, KEY_BYTES, { N, r, p, maxmem: MAX_MEMORY });
        return timingSafeEqual(actual, expected);
      } catch {
        return false;
      }
    },
  };
}
