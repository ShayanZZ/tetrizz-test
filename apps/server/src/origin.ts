/**
 * Which web pages may open a socket to the server.
 *
 * Browsers always send an `Origin` header on a WebSocket handshake, and a page cannot change it, so
 * this keeps other people's sites from using the server's capacity. It is not a login: a program
 * that is not a browser can send any `Origin` it likes.
 */
export interface OriginPolicy {
  /** Exact origins (`https://play.example`, scheme and host, no path) that may connect. */
  allowed: ReadonlySet<string>;
  /** A page served from the same host the socket is opened on (the `Host` header) may connect. */
  allowSameOrigin: boolean;
  /**
   * The `null` origin, which the single-file build opened from disk (`file://`) sends. Sandboxed
   * frames and some redirects send it too, so it is off unless the operator turns it on.
   */
  allowFile: boolean;
  /** A handshake without any `Origin` header (a script, not a browser). */
  allowMissing: boolean;
}

export function isOriginAllowed(
  policy: OriginPolicy,
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined) return policy.allowMissing;
  if (origin === "null") return policy.allowFile;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (policy.allowed.has(url.origin)) return true;
  return policy.allowSameOrigin && host !== undefined && url.host === host.toLowerCase();
}
