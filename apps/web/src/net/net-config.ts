import { log } from "../core/logger";
import { mergeNetworkConfig, parseNetworkConfig, type NetworkConfig } from "../core/network-config";

/**
 * The network settings in use. They start as what the build put into the page (from build
 * environment variables, see `docs/DEPLOYMENT.md`) and, on a page served over http(s), a
 * `config.json` next to it is read once and laid over them, so one build can serve any server.
 */
export const netConfig: { current: NetworkConfig } = {
  current: parseNetworkConfig(__NETWORK_CONFIG__),
};

const RUNTIME_CONFIG_URL = "./config.json";
const RUNTIME_CONFIG_TIMEOUT_MS = 2500;

async function loadRuntimeNetworkConfig(): Promise<void> {
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  try {
    const signal =
      typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(RUNTIME_CONFIG_TIMEOUT_MS)
        : undefined;
    const res = await fetch(RUNTIME_CONFIG_URL, { cache: "no-store", signal });
    if (!res.ok) return;
    netConfig.current = mergeNetworkConfig(netConfig.current, await res.json());
  } catch (error) {
    log.debug("net/net-config.loadRuntimeNetworkConfig", error);
  }
}

let ready: Promise<void> | null = null;

/** Resolves once the optional `config.json` has been read (or found missing). Safe to call often. */
export function networkConfigReady(): Promise<void> {
  ready ??= loadRuntimeNetworkConfig();
  return ready;
}
