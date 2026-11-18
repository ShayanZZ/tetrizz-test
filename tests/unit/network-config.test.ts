import { describe, expect, it } from "vitest";
import {
  DEFAULT_MQTT_BROKERS,
  DEFAULT_SCRIPTS,
  backendOrder,
  connectSources,
  defaultNetworkConfig,
  isOnlineBackend,
  mergeNetworkConfig,
  neverCacheHosts,
  networkConfigFromEnv,
  normalizeServerUrl,
  normalizeSupabaseUrl,
  parseNetworkConfig,
} from "../../apps/web/src/core/network-config";

const KEY = "sb_publishable_0123456789012345678901234567890123456789";
const URL_OK = "https://abcdefgh.supabase.co";

describe("defaults", () => {
  it("has no Supabase project, no server and the three public brokers", () => {
    const cfg = defaultNetworkConfig();
    expect(cfg.supabase).toBeNull();
    expect(cfg.server).toBeNull();
    expect(cfg.mqttBrokers).toEqual(DEFAULT_MQTT_BROKERS);
    expect(cfg.scripts).toEqual(DEFAULT_SCRIPTS);
  });

  it("pins both CDN libraries to an exact version", () => {
    expect(DEFAULT_SCRIPTS.supabase).toMatch(/supabase-js@\d+\.\d+\.\d+\//);
    expect(DEFAULT_SCRIPTS.mqtt).toMatch(/mqtt@\d+\.\d+\.\d+\//);
  });

  it("returns an independent copy each time", () => {
    const a = defaultNetworkConfig();
    a.mqttBrokers.pop();
    expect(defaultNetworkConfig().mqttBrokers).toHaveLength(3);
  });
});

describe("environment variables", () => {
  it("turns Supabase on only when both the address and the key are given", () => {
    expect(networkConfigFromEnv({}).supabase).toBeNull();
    expect(networkConfigFromEnv({ TETRIZZ_SUPABASE_URL: URL_OK }).supabase).toBeNull();
    expect(networkConfigFromEnv({ TETRIZZ_SUPABASE_KEY: KEY }).supabase).toBeNull();
    expect(
      networkConfigFromEnv({ TETRIZZ_SUPABASE_URL: URL_OK, TETRIZZ_SUPABASE_KEY: KEY }).supabase,
    ).toEqual({ url: URL_OK, anonKey: KEY });
  });

  it("trims whitespace and a trailing slash or path from the address", () => {
    const cfg = networkConfigFromEnv({
      TETRIZZ_SUPABASE_URL: `  ${URL_OK}/rest/v1/  `,
      TETRIZZ_SUPABASE_KEY: ` ${KEY} `,
    });
    expect(cfg.supabase).toEqual({ url: URL_OK, anonKey: KEY });
  });

  it("rejects a key that is too short", () => {
    expect(
      networkConfigFromEnv({ TETRIZZ_SUPABASE_URL: URL_OK, TETRIZZ_SUPABASE_KEY: "short" })
        .supabase,
    ).toBeNull();
  });

  it("replaces the broker list, or turns it off", () => {
    const own = networkConfigFromEnv({
      TETRIZZ_MQTT_BROKERS: "wss://mqtt.example.org:8084/mqtt, not a url, ws://10.0.0.5:9001",
    });
    expect(own.mqttBrokers).toEqual([
      { label: "mqtt.example.org", url: "wss://mqtt.example.org:8084/mqtt" },
      { label: "10.0.0.5", url: "ws://10.0.0.5:9001" },
    ]);
    expect(networkConfigFromEnv({ TETRIZZ_MQTT_BROKERS: "OFF" }).mqttBrokers).toEqual([]);
  });

  it("reads the server address", () => {
    expect(
      networkConfigFromEnv({ TETRIZZ_SERVER_URL: "https://play.example.org/" }).server,
    ).toEqual({ url: "https://play.example.org" });
    expect(networkConfigFromEnv({ TETRIZZ_SERVER_URL: "javascript:alert(1)" }).server).toBeNull();
  });
});

describe("normalizing addresses", () => {
  it("accepts https Supabase addresses, and http only for a local one", () => {
    expect(normalizeSupabaseUrl(URL_OK)).toBe(URL_OK);
    expect(normalizeSupabaseUrl("http://localhost:54321")).toBe("http://localhost:54321");
    expect(normalizeSupabaseUrl("http://abcdefgh.supabase.co")).toBeNull();
    expect(normalizeSupabaseUrl("https://user:pw@abcdefgh.supabase.co")).toBeNull();
    expect(normalizeSupabaseUrl(42)).toBeNull();
    expect(normalizeSupabaseUrl("")).toBeNull();
  });

  it("accepts a server as a full address or a path on the page's own origin", () => {
    expect(normalizeServerUrl("wss://play.example.org/ws/")).toBe("wss://play.example.org/ws");
    expect(normalizeServerUrl("/ws/")).toBe("/ws");
    expect(normalizeServerUrl("//evil.example")).toBeNull();
    expect(normalizeServerUrl("ftp://play.example.org")).toBeNull();
  });
});

describe("merging a runtime config.json", () => {
  const base = networkConfigFromEnv({ TETRIZZ_SUPABASE_URL: URL_OK, TETRIZZ_SUPABASE_KEY: KEY });

  it("ignores anything that is not an object", () => {
    for (const raw of [null, undefined, "x", 7, [], true]) {
      expect(mergeNetworkConfig(base, raw)).toBe(base);
    }
  });

  it("keeps every part it does not mention", () => {
    const merged = mergeNetworkConfig(base, { server: { url: "/ws" } });
    expect(merged.supabase).toEqual(base.supabase);
    expect(merged.mqttBrokers).toEqual(base.mqttBrokers);
    expect(merged.server).toEqual({ url: "/ws" });
  });

  it("lets the file switch Supabase off", () => {
    expect(mergeNetworkConfig(base, { supabase: null }).supabase).toBeNull();
  });

  it("drops a part that is present but invalid instead of keeping half of it", () => {
    expect(
      mergeNetworkConfig(base, { supabase: { url: "nope", anonKey: KEY } }).supabase,
    ).toBeNull();
    expect(mergeNetworkConfig(base, { server: { url: "ftp://x" } }).server).toBeNull();
    expect(mergeNetworkConfig(base, { mqttBrokers: ["bad", 3, null] }).mqttBrokers).toEqual([]);
  });

  it("only takes library addresses from the allowed CDN", () => {
    const evil = mergeNetworkConfig(base, {
      scripts: {
        supabase: "https://evil.example/x.js",
        mqtt: "https://cdn.jsdelivr.net/npm/mqtt@5.16.2/dist/mqtt.min.js",
      },
    });
    expect(evil.scripts.supabase).toBe(base.scripts.supabase);
    expect(evil.scripts.mqtt).toBe("https://cdn.jsdelivr.net/npm/mqtt@5.16.2/dist/mqtt.min.js");
  });

  it("survives a JSON round trip of its own output, as the build embeds it", () => {
    expect(parseNetworkConfig(JSON.parse(JSON.stringify(base)))).toEqual(base);
  });
});

describe("backend order", () => {
  const all = parseNetworkConfig({
    supabase: { url: URL_OK, anonKey: KEY },
    server: { url: "/ws" },
  });
  const supabaseOnly = parseNetworkConfig({ supabase: { url: URL_OK, anonKey: KEY } });

  it("auto: own server, then Supabase, then the public relay", () => {
    expect(backendOrder(all)).toEqual(["server", "supabase", "mqtt"]);
  });

  it("auto without a server: Supabase, then the relay", () => {
    expect(backendOrder(supabaseOnly)).toEqual(["supabase", "mqtt"]);
  });

  it("auto with nothing configured: the relay alone", () => {
    expect(backendOrder(defaultNetworkConfig())).toEqual(["mqtt"]);
  });

  it("a pick goes first and the others stay as fallbacks, even on a server build", () => {
    expect(backendOrder(all, "supabase")).toEqual(["supabase", "server", "mqtt"]);
    expect(backendOrder(all, "mqtt")).toEqual(["mqtt", "server", "supabase"]);
  });

  it("a pick that is not available is ignored", () => {
    expect(backendOrder(supabaseOnly, "server")).toEqual(["supabase", "mqtt"]);
  });

  it("recognises the four choices", () => {
    for (const v of ["auto", "server", "supabase", "mqtt"]) expect(isOnlineBackend(v)).toBe(true);
    expect(isOnlineBackend("lan")).toBe(false);
    expect(isOnlineBackend(null)).toBe(false);
  });
});

describe("Content Security Policy sources and the service worker list", () => {
  it("has no project host when nothing is configured", () => {
    const src = connectSources(defaultNetworkConfig());
    expect(src.join(" ")).not.toContain("supabase");
    expect(src).toContain("'self'");
    expect(src).toContain("wss://broker.emqx.io:8084");
  });

  it("allows exactly the configured project and its realtime socket", () => {
    const src = connectSources(parseNetworkConfig({ supabase: { url: URL_OK, anonKey: KEY } }));
    expect(src).toContain(URL_OK);
    expect(src).toContain("wss://abcdefgh.supabase.co");
    expect(src.join(" ")).not.toContain("*");
  });

  it("allows a server on another origin over both http and socket, and a same-origin path needs nothing", () => {
    const remote = connectSources(
      parseNetworkConfig({ server: { url: "https://play.example.org" } }),
    );
    expect(remote).toContain("https://play.example.org");
    expect(remote).toContain("wss://play.example.org");
    const same = connectSources(parseNetworkConfig({ server: { url: "/ws" } }));
    expect(same).toEqual(connectSources(defaultNetworkConfig()));
  });

  it("lists every network host for the service worker, once", () => {
    const hosts = neverCacheHosts(
      parseNetworkConfig({
        supabase: { url: URL_OK, anonKey: KEY },
        server: { url: "wss://play.example.org/ws" },
      }),
    );
    expect(hosts).toEqual([
      "abcdefgh.supabase.co",
      "broker.emqx.io",
      "broker.hivemq.com",
      "test.mosquitto.org",
      "play.example.org",
    ]);
  });
});
