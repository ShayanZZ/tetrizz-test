/**
 * Test players. The server knows a player by an id derived from a secret key, so a test that talks
 * to it needs real ids. The tests are easier to read with names, so this keeps both: a client speaks
 * in names (`"A"`, `"host"`), the wire carries derived ids and keys, and every frame is translated
 * on the way in and out. Only `target` and `newHost` hold a player on the way out; every id that
 * comes back is turned into its name.
 */
import { playerIdFromKey, sha256Hex } from "../../packages/protocol/src";

export interface TestPlayer {
  name: string;
  id: string;
  key: string;
}

const byName = new Map<string, TestPlayer>();
const nameById = new Map<string, string>();

/** The same player for the same name, in every test. */
export function player(name: string): TestPlayer {
  let found = byName.get(name);
  if (!found) {
    const key = sha256Hex(`test-player:${name}`);
    found = { name, id: playerIdFromKey(key), key };
    byName.set(name, found);
    nameById.set(found.id, name);
  }
  return found;
}

/** A `hello` for the named player, with the key that proves its id. */
export function helloFor(
  name: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const who = player(name);
  return { t: "hello", v: 1, app: "test", id: who.id, key: who.key, name, ...over };
}

/** A message with the names it holds for players turned into ids. */
export function toWire<T extends object>(message: T): T {
  const out: Record<string, unknown> = { ...message };
  for (const field of ["target", "newHost"]) {
    const value = out[field];
    if (typeof value === "string" && byName.has(value)) out[field] = player(value).id;
  }
  return out as T;
}

/** A frame with every player id it holds turned into the player's name. */
export function fromWire(text: string): string {
  let out = text;
  for (const [id, name] of nameById) out = out.split(id).join(name);
  return out;
}
