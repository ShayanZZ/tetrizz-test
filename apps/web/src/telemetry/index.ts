/**
 * The page's one telemetry client. `startPageTelemetry` is called once at boot; the rest of the
 * page reaches the client through `pageTelemetry`, which is null until then.
 */
import { playerIdFromKey } from "@tetrizz/protocol";
import { clock } from "../core/clock";
import { log } from "../core/logger";
import { storage } from "../core/storage";
import { APP_VERSION } from "../core/version";
import { playerKey } from "../net/identity";
import { netConfig, networkConfigReady } from "../net/net-config";
import type { TelemetryClient } from "./client";
import { collectDevice, type UserAgentDataLike } from "./device";
import { createPageTelemetry, watchPage } from "./page";

let client: TelemetryClient | null = null;

export function pageTelemetry(): TelemetryClient | null {
  return client;
}

interface NavigatorExtras {
  userAgentData?: UserAgentDataLike;
  deviceMemory?: number;
  standalone?: boolean;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function randomBytes(count: number): Uint8Array | null {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") return null;
  return crypto.getRandomValues(new Uint8Array(count));
}

/** The client exists as soon as it is made, but the rest of the page only gets it once it has started. */
let prepared: TelemetryClient | null = null;

function prepare(): TelemetryClient {
  if (prepared) return prepared;
  const key = playerKey();
  const nav = navigator as Navigator & NavigatorExtras;
  const made = createPageTelemetry({
    identity: key ? { id: playerIdFromKey(key), key } : null,
    configuredServer: () => netConfig.current.server?.url ?? null,
    origin: location.origin,
    appVersion: APP_VERSION,
    indexedDB: typeof indexedDB === "undefined" ? undefined : indexedDB,
    fetch: (input, init) => fetch(input, init),
    sendBeacon:
      typeof nav.sendBeacon === "function" ? (url, data) => nav.sendBeacon(url, data) : undefined,
    storage,
    now: () => clock.wall(),
    randomBytes,
    later(task, ms) {
      const timer = setTimeout(task, ms);
      return () => clearTimeout(timer);
    },
    online: () => nav.onLine !== false,
    warn: (scope, error) => log.warn(scope, error),
    device: () =>
      collectDevice({
        userAgentData: nav.userAgentData,
        maxTouchPoints: nav.maxTouchPoints,
        coarsePointer: window.matchMedia?.("(pointer: coarse)").matches,
        screenWidth: screen.width,
        screenHeight: screen.height,
        devicePixelRatio: window.devicePixelRatio,
        hardwareConcurrency: nav.hardwareConcurrency,
        deviceMemory: nav.deviceMemory,
        language: nav.language,
        standalone:
          window.matchMedia?.("(display-mode: standalone)").matches === true ||
          nav.standalone === true,
        protocol: location.protocol,
        withTimeout,
      }),
  });
  prepared = made;
  return made;
}

/**
 * Starts the client at boot. Nothing starts when the page has no identity or no server address
 * that takes telemetry (a copy of the game with no server sends nothing).
 */
export async function startPageTelemetry(): Promise<"unavailable" | "started"> {
  if (client) return "started";
  const made = prepare();
  await networkConfigReady();
  if (!made.status().available) return "unavailable";
  client = made;
  watchPage(made, window, document);
  await made.start();
  return "started";
}
