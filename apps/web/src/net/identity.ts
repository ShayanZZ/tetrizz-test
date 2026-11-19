/**
 * The page's player identity: one secret key that stays on this device, and the player id derived
 * from it (`@tetrizz/protocol`, `identity.ts`). The id is public and goes into every room of every
 * backend; the key is sent to TetriZZ's own server only, to prove the id is this page's, and never
 * into a room message, a replay, an export or a log.
 *
 * The key lives in the tab's own storage and in the browser's storage, like the old random id did,
 * so a reload keeps the same player and a page opened with its own key (a test page, for one) keeps
 * that one.
 */
import { isPlayerKey, playerIdFromKey } from "@tetrizz/protocol";

/** Storage key of the player key. It must stay out of settings exports and bug reports. */
export const PLAYER_KEY_STORAGE = "tetris_pkey";

/** Storage key of the random id earlier builds used; removed once the identity is made. */
const OLD_PLAYER_ID_STORAGE = "tetris_pid";

export interface PlayerIdentity {
  /** The public player id. */
  id: string;
  /** The secret it derives from. */
  key: string;
}

interface Store {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface IdentityDeps {
  /** Storage of this tab only. */
  tab: Store;
  /** Storage shared by the tabs of this browser. */
  local: Store & { remove(key: string): void };
  /** `count` random bytes from a cryptographic source; throws when there is none. */
  randomBytes(count: number): Uint8Array;
  warn(scope: string, error: unknown): void;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function readKey(store: Store, deps: IdentityDeps): string | null {
  try {
    const value = store.get(PLAYER_KEY_STORAGE);
    return isPlayerKey(value) ? value : null;
  } catch (error) {
    deps.warn("net/identity.read", error);
    return null;
  }
}

function keep(store: Store, key: string, deps: IdentityDeps): void {
  try {
    store.set(PLAYER_KEY_STORAGE, key);
  } catch (error) {
    deps.warn("net/identity.write", error);
  }
}

/**
 * The identity of this page: the stored key's, or a new one's when there is none (or what is stored
 * is not a key). Throws only when a new key is needed and no cryptographic randomness exists.
 */
export function loadIdentity(deps: IdentityDeps): PlayerIdentity {
  const key = readKey(deps.tab, deps) ?? readKey(deps.local, deps) ?? hex(deps.randomBytes(32));
  keep(deps.local, key, deps);
  keep(deps.tab, key, deps);
  try {
    deps.local.remove(OLD_PLAYER_ID_STORAGE);
  } catch (error) {
    deps.warn("net/identity.cleanup", error);
  }
  return { id: playerIdFromKey(key), key };
}

let current: PlayerIdentity | null = null;

/** Makes the page's identity and remembers it for `playerKey`. Called once, at start. */
export function startIdentity(deps: IdentityDeps): PlayerIdentity {
  current = loadIdentity(deps);
  return current;
}

/** The secret for the own server's `hello`; empty when the identity could not be made. */
export function playerKey(): string {
  return current?.key ?? "";
}
