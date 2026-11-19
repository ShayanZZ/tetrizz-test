/**
 * Who a player is, as far as TetriZZ's own server is concerned.
 *
 * A page makes one random secret, the player key, and keeps it. Its player id is derived from the
 * key with a one-way hash, so an id proves nothing by itself but can be checked against the key:
 * only whoever holds the key can present the id. The server therefore needs no table of who owns
 * which id; it recomputes the id from the key a page sends and compares. Ids stay public (they are
 * listed in every roster), keys never leave the page except to the server, over the connection to
 * it, and are never passed to another player, a relay, Supabase or the LAN hub.
 *
 * SHA-256 is written out here, not taken from the host, because the page needs the id at boot,
 * before anything asynchronous can run, and the server and the page must agree on it exactly.
 * `tests/unit/identity.test.ts` compares it with Node's own implementation.
 *
 * Nothing here touches the DOM, the network or any other package.
 */

/** A player key: 32 random bytes as 64 lowercase hex characters. */
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Prefix of the hashed text, so the id cannot double as a hash of the key used anywhere else. */
const ID_DOMAIN = "tetrizz-player-id-v1:";

/** Length of a derived player id, in hex characters (128 bits). */
export const PLAYER_ID_LENGTH = 32;

export function isPlayerKey(value: unknown): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

// prettier-ignore
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 of `bytes`. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      w[i] = w[i - 16]! + s0 + w[i - 7]! + s1;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + choose + ROUND_CONSTANTS[i]! + w[i]!) | 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a;
    h[1] = h[1]! + b;
    h[2] = h[2]! + c;
    h[3] = h[3]! + d;
    h[4] = h[4]! + e;
    h[5] = h[5]! + f;
    h[6] = h[6]! + g;
    h[7] = h[7]! + hh;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!);
  return out;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The bytes of a text made of ASCII characters only (a key that passed `isPlayerKey`, a prefix). */
const asciiBytes = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
};

/** The hex of the SHA-256 of an ASCII text. */
export const sha256Hex = (text: string): string => toHex(sha256(asciiBytes(text)));

/** The player id that belongs to a key. `key` must satisfy `isPlayerKey`. */
export function playerIdFromKey(key: string): string {
  return sha256Hex(ID_DOMAIN + key).slice(0, PLAYER_ID_LENGTH);
}

/**
 * Whether `key` is a valid player key and `id` is the id derived from it. Takes anything, because
 * both come off the wire; the comparison needs no constant-time care, as the id is public.
 */
export function keyMatchesId(key: unknown, id: unknown): boolean {
  return isPlayerKey(key) && typeof id === "string" && playerIdFromKey(key) === id;
}
