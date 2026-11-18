import { describe, expect, it } from "vitest";
import {
  backendChoices,
  effectiveBackendChoice,
  nextBackendChoice,
  parseBackendChoice,
  roomBackendKinds,
  runnableBackends,
} from "../../apps/web/src/net/backend-choice";
import { defaultNetworkConfig, type NetworkConfig } from "../../apps/web/src/core/network-config";

const KEY = "k".repeat(48);

function config(parts: Partial<NetworkConfig>): NetworkConfig {
  return { ...defaultNetworkConfig(), ...parts };
}

const relayOnly = config({});
const supabaseAndRelay = config({ supabase: { url: "https://x.supabase.co", anonKey: KEY } });
const everything = config({
  supabase: { url: "https://x.supabase.co", anonKey: KEY },
  server: { url: "https://play.example.com" },
});
const noRelay = config({
  supabase: { url: "https://x.supabase.co", anonKey: KEY },
  mqttBrokers: [],
});

describe("room backends to try", () => {
  it("is the relay alone when nothing else is configured", () => {
    expect(roomBackendKinds(relayOnly)).toEqual(["relay"]);
  });

  it("tries Supabase first and the relay after it, as the lobby always did", () => {
    expect(roomBackendKinds(supabaseAndRelay)).toEqual(["supabase", "relay"]);
  });

  it("puts the picked backend first and keeps the others as fallbacks", () => {
    expect(roomBackendKinds(supabaseAndRelay, "mqtt")).toEqual(["relay", "supabase"]);
    expect(roomBackendKinds(supabaseAndRelay, "supabase")).toEqual(["supabase", "relay"]);
  });

  it("leaves the relay out when no broker is configured", () => {
    expect(roomBackendKinds(noRelay)).toEqual(["supabase"]);
  });

  it("tries the own server first under auto, then the others as fallbacks", () => {
    expect(runnableBackends(everything)).toEqual(["server", "supabase", "mqtt"]);
    expect(roomBackendKinds(everything)).toEqual(["server", "supabase", "relay"]);
    expect(roomBackendKinds(everything, "supabase")).toEqual(["supabase", "server", "relay"]);
  });

  it("leaves the own server out when none is configured", () => {
    expect(roomBackendKinds(supabaseAndRelay)).toEqual(["supabase", "relay"]);
    expect(roomBackendKinds(supabaseAndRelay, "server")).toEqual(["supabase", "relay"]);
  });

  it("is empty when there is nothing to connect to", () => {
    expect(roomBackendKinds(config({ mqttBrokers: [] }))).toEqual([]);
  });
});

describe("the picker", () => {
  it("is hidden when there is only one backend", () => {
    expect(backendChoices(relayOnly)).toEqual([]);
    expect(backendChoices(noRelay)).toEqual([]);
  });

  it("offers auto and each usable backend when there are two or more", () => {
    expect(backendChoices(supabaseAndRelay)).toEqual(["auto", "supabase", "mqtt"]);
    expect(backendChoices(everything)).toEqual(["auto", "server", "supabase", "mqtt"]);
  });

  it("steps through the choices and wraps around", () => {
    expect(nextBackendChoice(supabaseAndRelay, "auto")).toBe("supabase");
    expect(nextBackendChoice(supabaseAndRelay, "supabase")).toBe("mqtt");
    expect(nextBackendChoice(supabaseAndRelay, "mqtt")).toBe("auto");
  });

  it("starts again from auto when the current pick is not offered", () => {
    expect(nextBackendChoice(supabaseAndRelay, "server")).toBe("auto");
    expect(nextBackendChoice(relayOnly, "mqtt")).toBe("auto");
  });

  it("shows a pick that is not offered as auto", () => {
    expect(effectiveBackendChoice(supabaseAndRelay, "mqtt")).toBe("mqtt");
    expect(effectiveBackendChoice(supabaseAndRelay, "server")).toBe("auto");
    expect(effectiveBackendChoice(relayOnly, "supabase")).toBe("auto");
  });

  it("reads stored and imported values, anything unknown meaning auto", () => {
    expect(parseBackendChoice("supabase")).toBe("supabase");
    expect(parseBackendChoice("lan")).toBe("auto");
    expect(parseBackendChoice(undefined)).toBe("auto");
    expect(parseBackendChoice(null)).toBe("auto");
  });
});
