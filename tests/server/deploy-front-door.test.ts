/**
 * In the VPS stack Caddy answers `/config.json` itself and forwards a few paths to the server. The
 * page turns the address in that file into its socket URL (`serverSocketUrl` adds the socket path),
 * so the two have to agree: the path the page ends up connecting to must be one Caddy forwards. If
 * they drift apart every part still passes its own checks and the page just cannot reach its server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_SOCKET_PATH } from "@tetrizz/protocol";
import { defaultNetworkConfig, mergeNetworkConfig } from "../../apps/web/src/core/network-config";
import { serverSocketUrl } from "../../apps/web/src/net/server-socket";

const CADDYFILE = readFileSync(join(__dirname, "..", "..", "deploy", "Caddyfile"), "utf8");

/** The JSON body Caddy answers `/config.json` with. */
function servedConfig(): unknown {
  const match = /respond `(\{.*\})` 200/.exec(CADDYFILE);
  expect(match, "no `respond` for /config.json in deploy/Caddyfile").not.toBeNull();
  return JSON.parse(match![1]!);
}

/** The paths the Caddyfile hands to the server, as written (`/ws`, `/api/v1/*`...). */
function forwardedPaths(): string[] {
  return [...CADDYFILE.matchAll(/^\s*handle (\/\S+) \{\s*\n\s*reverse_proxy/gm)].map((m) => m[1]!);
}

describe("the Caddy front door and the page", () => {
  it("forwards the socket path the server listens on", () => {
    expect(forwardedPaths()).toContain(SERVER_SOCKET_PATH);
  });

  it("serves a config.json that leads the page to a path Caddy forwards", () => {
    const config = mergeNetworkConfig(defaultNetworkConfig(), servedConfig());
    expect(config.server, "the served config.json has no usable server address").not.toBeNull();
    const socket = new URL(serverSocketUrl(config.server!.url, "https://play.example.org"));
    expect(socket.origin).toBe("wss://play.example.org");
    expect(forwardedPaths()).toContain(socket.pathname);
  });
});
