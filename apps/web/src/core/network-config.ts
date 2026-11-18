/**
 * Network configuration: where online play connects to.
 *
 * Nothing here touches the DOM or Node, so the Vite build (to write the Content Security Policy
 * and the service worker's no-cache list) and the browser app (to connect) share one set of rules.
 * No project address or key is stored in the source: they come from build environment variables
 * (see `docs/DEPLOYMENT.md`) or from a `config.json` served beside the page.
 */

export interface RelayBroker {
  label: string;
  url: string;
}

export interface NetworkConfig {
  /** Supabase project used for rooms, players and realtime messages; null when not configured. */
  supabase: { url: string; anonKey: string } | null;
  /** Public MQTT brokers of the fallback relay, tried in order. */
  mqttBrokers: RelayBroker[];
  /** TetriZZ's own server (a VPS); null when there is none. */
  server: { url: string } | null;
  /** Pinned addresses of the two libraries that are loaded from the CDN on demand. */
  scripts: { supabase: string; mqtt: string };
}

/** Which backend the player picked. `auto` follows `backendOrder`. */
export type OnlineBackend = "auto" | "server" | "supabase" | "mqtt";
export type BackendName = Exclude<OnlineBackend, "auto">;

export const ONLINE_BACKENDS: readonly OnlineBackend[] = ["auto", "server", "supabase", "mqtt"];

/** Public relay brokers. These are shared public infrastructure, not credentials. */
export const DEFAULT_MQTT_BROKERS: readonly RelayBroker[] = [
  { label: "EMQX public", url: "wss://broker.emqx.io:8084/mqtt" },
  { label: "HiveMQ public", url: "wss://broker.hivemq.com:8884/mqtt" },
  { label: "Mosquitto public", url: "wss://test.mosquitto.org:8081" },
];

/** Exact versions: a newer release is only used after it has been looked at and tested. */
export const DEFAULT_SCRIPTS = {
  supabase: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js",
  mqtt: "https://cdn.jsdelivr.net/npm/mqtt@5.16.1/dist/mqtt.min.js",
} as const;

/** The CDN host the page may load scripts from; also in the Content Security Policy. */
export const CDN_ORIGIN = "https://cdn.jsdelivr.net";

const MIN_KEY_LENGTH = 40;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/** `https://host` (or http for localhost, used by a local Supabase), without path or trailing slash. */
export function normalizeSupabaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = asUrl(value.trim());
  if (!url || url.username || url.password) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  return url.origin;
}

function normalizeBroker(value: unknown): RelayBroker | null {
  const raw = typeof value === "string" ? { url: value } : value;
  if (!isRecord(raw) || typeof raw.url !== "string") return null;
  const url = asUrl(raw.url.trim());
  if (!url || (url.protocol !== "wss:" && url.protocol !== "ws:")) return null;
  if (url.username || url.password) return null;
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : url.hostname;
  return { label: label.slice(0, 40), url: raw.url.trim() };
}

/**
 * The own server's address: a full http(s) or ws(s) URL, or a path on the page's own origin
 * (for a server that serves the page itself). Returned without a trailing slash.
 */
export function normalizeServerUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.startsWith("/") && !v.startsWith("//")) return v.replace(/\/+$/, "") || "/";
  const url = asUrl(v);
  if (!url || url.username || url.password) return null;
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
  return url.href.replace(/\/+$/, "");
}

export function defaultNetworkConfig(): NetworkConfig {
  return {
    supabase: null,
    mqttBrokers: DEFAULT_MQTT_BROKERS.map((b) => ({ ...b })),
    server: null,
    scripts: { ...DEFAULT_SCRIPTS },
  };
}

function parseScriptUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const url = asUrl(value.trim());
  return url && url.origin === CDN_ORIGIN ? url.href : fallback;
}

/**
 * Turns whatever was supplied (an object from `config.json`, the build's own output) into a valid
 * configuration. Parts that are missing keep `base`; parts that are present but invalid are
 * dropped, so a typo can never leave the game with a half-working address.
 */
export function mergeNetworkConfig(base: NetworkConfig, raw: unknown): NetworkConfig {
  if (!isRecord(raw)) return base;
  const out: NetworkConfig = {
    supabase: base.supabase,
    mqttBrokers: base.mqttBrokers,
    server: base.server,
    scripts: { ...base.scripts },
  };

  if ("supabase" in raw) {
    const s = raw.supabase;
    if (s === null) {
      out.supabase = null;
    } else if (isRecord(s)) {
      const url = normalizeSupabaseUrl(s.url);
      const key = typeof s.anonKey === "string" ? s.anonKey.trim() : "";
      out.supabase = url && key.length >= MIN_KEY_LENGTH ? { url, anonKey: key } : null;
    }
  }

  if ("mqttBrokers" in raw && Array.isArray(raw.mqttBrokers)) {
    out.mqttBrokers = raw.mqttBrokers
      .map(normalizeBroker)
      .filter((b): b is RelayBroker => b !== null);
  }

  if ("server" in raw) {
    const s = raw.server;
    if (s === null) {
      out.server = null;
    } else if (isRecord(s)) {
      const url = normalizeServerUrl(s.url);
      out.server = url ? { url } : null;
    }
  }

  if (isRecord(raw.scripts)) {
    out.scripts.supabase = parseScriptUrl(raw.scripts.supabase, base.scripts.supabase);
    out.scripts.mqtt = parseScriptUrl(raw.scripts.mqtt, base.scripts.mqtt);
  }
  return out;
}

export function parseNetworkConfig(raw: unknown): NetworkConfig {
  return mergeNetworkConfig(defaultNetworkConfig(), raw);
}

/**
 * Build-time settings from environment variables (all optional):
 * - `TETRIZZ_SUPABASE_URL` and `TETRIZZ_SUPABASE_KEY`: the project and its publishable key; both
 *   are needed, with only one the Supabase backend stays off.
 * - `TETRIZZ_SERVER_URL`: the TetriZZ server, for a build that talks to a VPS on another address.
 * - `TETRIZZ_MQTT_BROKERS`: comma-separated broker URLs replacing the public list, or `off` for none.
 */
export function networkConfigFromEnv(env: Record<string, string | undefined>): NetworkConfig {
  const raw: Record<string, unknown> = {};
  const url = (env.TETRIZZ_SUPABASE_URL ?? "").trim();
  const key = (env.TETRIZZ_SUPABASE_KEY ?? "").trim();
  if (url || key) raw.supabase = { url, anonKey: key };
  const server = (env.TETRIZZ_SERVER_URL ?? "").trim();
  if (server) raw.server = { url: server };
  const brokers = (env.TETRIZZ_MQTT_BROKERS ?? "").trim();
  if (brokers.toLowerCase() === "off") raw.mqttBrokers = [];
  else if (brokers) raw.mqttBrokers = brokers.split(",").map((s) => s.trim());
  return parseNetworkConfig(raw);
}

/**
 * Which backends to try, first to last. `auto` puts the own server first when there is one, then
 * Supabase when it is configured, and always ends with the public relay, which needs no setup.
 * A pick other than `auto` goes first and the others follow as fallbacks, so choosing Supabase on
 * a VPS build still works and still falls back to the relay if Supabase is down.
 */
export function backendOrder(cfg: NetworkConfig, choice: OnlineBackend = "auto"): BackendName[] {
  const available: BackendName[] = [];
  if (cfg.server) available.push("server");
  if (cfg.supabase) available.push("supabase");
  if (cfg.mqttBrokers.length) available.push("mqtt");
  if (choice === "auto" || !available.includes(choice)) return available;
  return [choice, ...available.filter((b) => b !== choice)];
}

export function isOnlineBackend(value: unknown): value is OnlineBackend {
  return typeof value === "string" && (ONLINE_BACKENDS as readonly string[]).includes(value);
}

const socketOrigin = (url: URL): string =>
  `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;

/** Hosts the page may open connections to, as Content Security Policy `connect-src` sources. */
export function connectSources(cfg: NetworkConfig): string[] {
  const out = new Set<string>(["'self'", CDN_ORIGIN]);
  if (cfg.supabase) {
    const url = new URL(cfg.supabase.url);
    out.add(url.origin);
    out.add(socketOrigin(url));
  }
  for (const b of cfg.mqttBrokers) {
    const url = new URL(b.url);
    out.add(`${url.protocol}//${url.host}`);
  }
  if (cfg.server && !cfg.server.url.startsWith("/")) {
    const url = new URL(cfg.server.url);
    if (url.protocol === "ws:" || url.protocol === "wss:") out.add(`${url.protocol}//${url.host}`);
    else {
      out.add(url.origin);
      out.add(socketOrigin(url));
    }
  }
  return [...out];
}

/** Hosts the service worker must always fetch from the network and never store. */
export function neverCacheHosts(cfg: NetworkConfig): string[] {
  const out = new Set<string>();
  if (cfg.supabase) out.add(new URL(cfg.supabase.url).hostname);
  for (const b of cfg.mqttBrokers) out.add(new URL(b.url).hostname);
  if (cfg.server && !cfg.server.url.startsWith("/")) out.add(new URL(cfg.server.url).hostname);
  return [...out];
}
