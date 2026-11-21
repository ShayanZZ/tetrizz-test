/**
 * Where the page finds the server's telemetry API, and the id that every human player of one online
 * match shares so the server can keep one game with one row per player.
 */
import { sha256Hex } from "@tetrizz/protocol";

/**
 * The http(s) address of the own server for the telemetry API, without a trailing slash, from the
 * configured server address: an http(s) or ws(s) URL, or a path on the page's own origin. `null`
 * when no server is configured or the address cannot be read, which switches telemetry off.
 */
export function telemetryBase(
  configured: string | null | undefined,
  origin: string,
): string | null {
  const value = (configured ?? "").trim();
  if (value === "") return null;
  try {
    const url = new URL(value.startsWith("/") ? origin + value : value);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export interface MatchParts {
  /** The room's id, the same for everyone in it. */
  room: string;
  /** The host's clock when the match was started, sent to everyone in the start message. */
  stamp: number;
  /** The players of the match, in the host's order. */
  order: readonly string[];
}

/**
 * The game id of an online match: the same on every page that played it, different for the next
 * match of the same room (the start stamp differs) and valid for the server's id format. `null`
 * when a part is missing, so the page reports its own game under its own id instead.
 */
export function matchGameId(parts: MatchParts): string | null {
  if (parts.room === "" || !Number.isFinite(parts.stamp) || parts.stamp <= 0) return null;
  if (parts.order.length === 0) return null;
  const text = [
    "tetrizz-match-v1",
    encodeURIComponent(parts.room),
    String(Math.trunc(parts.stamp)),
    parts.order.map((id) => encodeURIComponent(id)).join(","),
  ].join("|");
  return `m${sha256Hex(text).slice(0, 31)}`;
}
