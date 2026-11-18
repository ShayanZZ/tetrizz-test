/** The wire-compatibility version and the rule for comparing it with a peer's. Imports nothing. */

/**
 * Increases whenever messages change in a way older clients cannot understand. Two builds with
 * different versions do not share a room, so a bump is a deliberate, rare decision.
 */
export const PROTOCOL_VERSION = 1;

/** The oldest wire version this build still talks to. */
export const PROTOCOL_MIN_VERSION = 1;

/** What a peer that sends no version is taken to speak: every build before the field existed. */
export const LEGACY_PROTOCOL_VERSION = 1;

export type PeerVersionStatus = "ok" | "peer-too-new" | "peer-too-old";

/** The version a peer announced; a missing or malformed value counts as the legacy version. */
export function peerVersion(announced: unknown): number {
  return typeof announced === "number" && Number.isInteger(announced) && announced >= 1
    ? announced
    : LEGACY_PROTOCOL_VERSION;
}

/** Whether this build can share a room with a peer that announced `announced`. */
export function checkPeerVersion(announced: unknown): PeerVersionStatus {
  const version = peerVersion(announced);
  if (version > PROTOCOL_VERSION) return "peer-too-new";
  if (version < PROTOCOL_MIN_VERSION) return "peer-too-old";
  return "ok";
}
