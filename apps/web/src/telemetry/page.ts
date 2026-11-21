/**
 * The telemetry client with the page's real dependencies, and the page events it listens to. Every
 * browser object comes in through `PageEnv`, so a test can stand in for all of them.
 */
import {
  createTelemetryClient,
  type HttpRequest,
  type HttpResponse,
  type KeyValue,
  type TelemetryClient,
} from "./client";
import { createMemoryStore, type TelemetryStore } from "./queue";
import { createIndexedDbStore } from "./idb-store";
import { telemetryBase } from "./address";
import type { TelemetryDevice } from "@tetrizz/protocol";

const REQUEST_TIMEOUT_MS = 10_000;

export interface PageEnv {
  /** This page's id and secret key; null when the identity could not be made. */
  identity: { id: string; key: string } | null;
  /** The configured own server's address, read each time (the runtime config can arrive late). */
  configuredServer(): string | null;
  origin: string;
  appVersion: string;
  indexedDB?: IDBFactory | undefined;
  fetch: typeof fetch;
  sendBeacon?: ((url: string, data: string) => boolean) | undefined;
  storage: KeyValue;
  /** Wall-clock milliseconds since 1970. */
  now(): number;
  /** `count` random bytes from a cryptographic source, or null when there is none. */
  randomBytes(count: number): Uint8Array | null;
  later(task: () => void, ms: number): () => void;
  online(): boolean;
  warn(scope: string, error: unknown): void;
  device(): Promise<TelemetryDevice | undefined>;
  requestTimeoutMs?: number;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function pickStore(env: PageEnv): TelemetryStore {
  if (!env.indexedDB) return createMemoryStore();
  try {
    return createIndexedDbStore(env.indexedDB);
  } catch (error) {
    env.warn("telemetry/page.store", error);
    return createMemoryStore();
  }
}

/** Reads and writes that never throw: blocked storage must not stop the game. */
function safeStorage(env: PageEnv): KeyValue {
  return {
    get(key) {
      try {
        return env.storage.get(key);
      } catch (error) {
        env.warn("telemetry/page.storage", error);
        return null;
      }
    },
    set(key, value) {
      try {
        env.storage.set(key, value);
      } catch (error) {
        env.warn("telemetry/page.storage", error);
      }
    },
    remove(key) {
      try {
        env.storage.remove(key);
      } catch (error) {
        env.warn("telemetry/page.storage", error);
      }
    },
  };
}

async function send(env: PageEnv, request: HttpRequest): Promise<HttpResponse> {
  const controller = new AbortController();
  const cancel = env.later(() => controller.abort(), env.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await env.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const wait = Number(res.headers.get("retry-after"));
    return {
      status: res.status,
      body,
      ...(res.headers.get("retry-after") !== null && Number.isFinite(wait) && wait >= 0
        ? { retryAfterSeconds: wait }
        : {}),
    };
  } finally {
    cancel();
  }
}

export function createPageTelemetry(env: PageEnv): TelemetryClient {
  const sendBeacon = env.sendBeacon;
  return createTelemetryClient({
    identity: env.identity,
    base: () => telemetryBase(env.configuredServer(), env.origin),
    store: pickStore(env),
    kv: safeStorage(env),
    http: (request) => send(env, request),
    ...(sendBeacon ? { beacon: (url: string, body: string) => sendBeacon(url, body) } : {}),
    now: env.now,
    random() {
      const bytes = env.randomBytes(4);
      if (!bytes) return 0.5;
      const n =
        (bytes[0] ?? 0) * 2 ** 24 +
        (bytes[1] ?? 0) * 2 ** 16 +
        (bytes[2] ?? 0) * 2 ** 8 +
        (bytes[3] ?? 0);
      return n / 2 ** 32;
    },
    newId() {
      const bytes = env.randomBytes(16);
      return bytes
        ? hex(bytes)
        : `t${env.now().toString(36)}${Math.floor(env.now() % 1e6).toString(36)}`;
    },
    later: env.later,
    online: env.online,
    warn: env.warn,
    appVersion: env.appVersion,
    device: env.device,
  });
}

export interface PageEvents {
  addEventListener(type: string, listener: () => void): void;
}

/**
 * Connects the client to the page: back online means try the queue, and a page that is hidden or
 * closing hands what is queued to the browser to send.
 */
export function watchPage(
  client: TelemetryClient,
  win: PageEvents,
  doc: PageEvents & { readonly visibilityState: string },
): void {
  win.addEventListener("online", () => client.online());
  win.addEventListener("pagehide", () => client.flushOnHide());
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "hidden") client.flushOnHide();
  });
}
