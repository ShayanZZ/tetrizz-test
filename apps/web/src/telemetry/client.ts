/**
 * The telemetry client: notes what happens in the page, keeps it until the server has confirmed
 * it, and sends it to TetriZZ's own server in batches.
 *
 * Rules the rest of the page relies on:
 * - Nothing is noted or sent unless the page has an identity, the server's address is known and
 *   the player has not switched telemetry off. Off means nothing is queued and what was queued is
 *   thrown away.
 * - Noting an item never waits and never throws; the game loop calls it freely.
 * - A batch is only forgotten once the server answered it. A lost answer means the same items go
 *   again, and the server dedupes them by their ids.
 * - The player's choices (off, erase my data) are also told to the server; if that fails they are
 *   remembered and tried again, so a choice made offline still reaches the server.
 * - The key travels in the body of a batch and in `Authorization` on the other calls, and nowhere
 *   else; it is never queued, logged or put into an item.
 */
import {
  PLAYERS_PATH,
  TELEMETRY_MAX_EVENTS,
  TELEMETRY_MAX_GAMES,
  TELEMETRY_MAX_HISTORY,
  TELEMETRY_PATH,
  TELEMETRY_VERSION,
  type TelemetryBatch,
  type TelemetryDevice,
  type TelemetryEvent,
  type TelemetryGame,
  type TelemetryHistoryEntry,
  type TelemetrySession,
} from "@tetrizz/protocol";
import { createQueue, DEFAULT_QUEUE_LIMITS, type QueueItem, type TelemetryStore } from "./queue";

/** Storage keys of the player's choice and of what still has to be told to the server. */
export const TELEMETRY_ENABLED_KEY = "tetris_telemetry";
export const TELEMETRY_TODO_KEY = "tetris_telemetry_todo";

const KIND = /^[a-z][a-z0-9_]{0,39}$/;
const GAME_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_PAYLOAD_BYTES = 2000;
const BATCH_BYTES = 200_000;
const BEACON_BYTES = 60_000;
const FLUSH_DELAY_MS = 20_000;
const FLUSH_SOON_MS = 1_000;
const FLUSH_SOON_ITEMS = 50;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 900_000;
const BATCHES_PER_FLUSH = 5;

export interface HttpRequest {
  url: string;
  method: "POST" | "PUT" | "DELETE";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** The parsed JSON answer, or undefined when it was not JSON. */
  body: unknown;
  /** Seconds from a `Retry-After` header. */
  retryAfterSeconds?: number | undefined;
}

export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface TelemetryDeps {
  /** This page's id and secret key; null when there is no cryptographic randomness. */
  identity: { id: string; key: string } | null;
  /** The server's address without a trailing slash; null when no server is configured. */
  base(): string | null;
  store: TelemetryStore;
  kv: KeyValue;
  /** Resolves with the answer; rejects when there was none (no connection, timeout). */
  http(request: HttpRequest): Promise<HttpResponse>;
  /** `navigator.sendBeacon`: queues the request for the browser to send, even as the page closes. */
  beacon?(url: string, body: string): boolean;
  /** Wall-clock milliseconds since 1970. */
  now(): number;
  /** A number from 0 up to but not including 1. */
  random(): number;
  newId(): string;
  later(task: () => void, ms: number): () => void;
  online(): boolean;
  warn(scope: string, error: unknown): void;
  appVersion: string;
  /** Coarse device facts, read once. */
  device(): Promise<TelemetryDevice | undefined>;
}

export type GameReport = Omit<
  TelemetryGame,
  "id" | "sessionId" | "appVersion" | "deviceClass" | "offline"
> & {
  /**
   * The game's id. Every human player of one match gives the same id and only their own row, so the
   * server keeps one game with one row per player. Left out (or not a valid id) for a game of one
   * person: the client makes one up.
   */
  id?: string;
};

export interface TelemetryStatus {
  /** There is an identity and a server address. */
  available: boolean;
  enabled: boolean;
  queued: number;
  /** The server has no telemetry (no `/api/v1`); nothing is noted for the rest of this page load. */
  serverHasNone: boolean;
  /** The server refused this page's key; nothing is sent for the rest of this page load. */
  refused: boolean;
  /** The player's choice has not reached the server yet. */
  pendingSync: boolean;
  failures: number;
}

export interface TelemetryClient {
  /** Loads the queue, starts the session and notes `app_start`. */
  start(): Promise<void>;
  record(kind: string, payload?: unknown): void;
  recordGame(game: GameReport): void;
  recordHistory(kind: string, value?: number, detail?: unknown): void;
  flush(): Promise<void>;
  /** The page is being hidden or closed: hands what is queued to the browser to send. */
  flushOnHide(): void;
  /** Switches telemetry on or off and tells the server. */
  setEnabled(enabled: boolean): Promise<void>;
  /** Asks the server to erase everything about this player and throws the local queue away. True when done. */
  eraseMyData(): Promise<boolean>;
  /** The connection is back: try the queue now. */
  online(): void;
  status(): TelemetryStatus;
}

interface Todo {
  optOut?: boolean;
  erase?: boolean;
}

export function createTelemetryClient(deps: TelemetryDeps): TelemetryClient {
  const { identity, kv } = deps;
  const queue = createQueue(deps.store, DEFAULT_QUEUE_LIMITS, deps.warn);

  let started = false;
  let sessionId = "";
  let sessionStartedAt = 0;
  let sessionOffline = false;
  let device: TelemetryDevice | undefined;
  let deviceSent = false;
  let serverHasNone = false;
  let refused = false;
  let failures = 0;
  let notBefore = 0;
  let sending = false;
  let cancelTimer: (() => void) | null = null;
  let timerAt = 0;
  let batchLimit = TELEMETRY_MAX_EVENTS;
  const beaconed = new Set<number>();

  const base = (): string | null => {
    const value = deps.base();
    return value === null || identity === null ? null : value.replace(/\/+$/, "");
  };
  const available = (): boolean => base() !== null;
  const enabled = (): boolean => kv.get(TELEMETRY_ENABLED_KEY) !== "off";
  const active = (): boolean => available() && enabled() && !serverHasNone && !refused;

  const readTodo = (): Todo => {
    try {
      const raw = kv.get(TELEMETRY_TODO_KEY);
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return {};
      const todo: Todo = {};
      const { optOut, erase } = parsed as Record<string, unknown>;
      if (typeof optOut === "boolean") todo.optOut = optOut;
      if (erase === true) todo.erase = true;
      return todo;
    } catch {
      return {};
    }
  };
  const writeTodo = (todo: Todo): void => {
    try {
      if (todo.optOut === undefined && todo.erase !== true) kv.remove(TELEMETRY_TODO_KEY);
      else kv.set(TELEMETRY_TODO_KEY, JSON.stringify(todo));
    } catch (error) {
      deps.warn("telemetry/client.todo", error);
    }
  };
  const pending = (): boolean => {
    const todo = readTodo();
    return todo.optOut !== undefined || todo.erase === true;
  };

  const backoff = (retryAfterSeconds?: number): void => {
    failures++;
    const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
    const wait = step * (0.75 + deps.random() * 0.5);
    const asked = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : 0;
    notBefore = deps.now() + Math.max(wait, Math.min(asked, BACKOFF_MAX_MS));
  };

  /** Runs `flush` after `ms`, or at the time a timer already set if that comes sooner. */
  const schedule = (ms: number): void => {
    const at = Math.max(deps.now() + ms, notBefore);
    if (cancelTimer) {
      if (timerAt <= at) return;
      cancelTimer();
    }
    timerAt = at;
    cancelTimer = deps.later(() => {
      cancelTimer = null;
      void flush();
    }, at - deps.now());
  };

  const nowSession = (): TelemetrySession => {
    const session: TelemetrySession = {
      id: sessionId,
      startedAt: sessionStartedAt,
      endedAt: Math.max(deps.now(), sessionStartedAt),
      appVersion: deps.appVersion,
    };
    if (device?.displayMode) session.displayMode = device.displayMode;
    if (device?.deviceClass) session.deviceClass = device.deviceClass;
    if (sessionOffline) session.offline = true;
    return session;
  };

  const makeBatch = (items: readonly QueueItem[]): TelemetryBatch & { key: string } => {
    const batch: TelemetryBatch & { key: string } = {
      v: TELEMETRY_VERSION,
      playerId: identity?.id ?? "",
      key: identity?.key ?? "",
      sentAt: deps.now(),
      session: nowSession(),
      events: [],
      games: [],
      history: [],
    };
    if (device && !deviceSent) batch.device = device;
    for (const item of items) {
      if (item.kind === "event") batch.events.push(item.value as TelemetryEvent);
      else if (item.kind === "game") batch.games.push(item.value as TelemetryGame);
      else batch.history.push(item.value as TelemetryHistoryEntry);
    }
    return batch;
  };

  const limitsFor = (events: number) => ({
    events,
    games: Math.min(TELEMETRY_MAX_GAMES, Math.max(1, events)),
    history: Math.min(TELEMETRY_MAX_HISTORY, Math.max(1, events)),
    bytes: BATCH_BYTES,
  });

  /** Tells the server what the player chose; true when nothing is left to tell. */
  async function syncTodo(): Promise<boolean> {
    const root = base();
    if (root === null || identity === null) return !pending();
    const auth = { Authorization: `Bearer ${identity.key}` };
    const todo = readTodo();
    try {
      if (todo.erase) {
        const res = await deps.http({
          url: `${root}${PLAYERS_PATH}/${identity.id}`,
          method: "DELETE",
          headers: auth,
        });
        if (res.status === 404) return finishTodo({});
        if (res.status !== 200) return failTodo(res);
        todo.erase = undefined;
        if (!enabled()) todo.optOut = true;
        writeTodo(todo);
      }
      if (todo.optOut !== undefined) {
        const res = await deps.http({
          url: `${root}${PLAYERS_PATH}/${identity.id}/telemetry`,
          method: "PUT",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ optOut: todo.optOut }),
        });
        if (res.status === 404) return finishTodo({});
        if (res.status !== 200) return failTodo(res);
        todo.optOut = undefined;
        writeTodo(todo);
      }
      failures = 0;
      return true;
    } catch (error) {
      deps.warn("telemetry/client.sync", error);
      backoff();
      return false;
    }
  }
  const finishTodo = (todo: Todo): boolean => {
    serverHasNone = true;
    writeTodo(todo);
    return true;
  };
  const failTodo = (res: HttpResponse): boolean => {
    if (res.status === 403) refused = true;
    else backoff(res.retryAfterSeconds);
    return false;
  };

  /** Sends one batch; "more" means the queue may hold further batches worth sending now. */
  async function deliver(items: readonly QueueItem[]): Promise<"more" | "stop"> {
    const root = base();
    if (root === null) return "stop";
    const batch = makeBatch(items);
    let res: HttpResponse;
    try {
      res = await deps.http({
        url: `${root}${TELEMETRY_PATH}`,
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(batch),
      });
    } catch (error) {
      deps.warn("telemetry/client.send", error);
      backoff();
      return "stop";
    }
    if (res.status === 200 && typeof res.body === "object" && res.body !== null) {
      const ack = res.body as { optedOut?: unknown };
      queue.remove(items);
      beaconed.clear();
      deviceSent = deviceSent || batch.device !== undefined;
      failures = 0;
      notBefore = 0;
      if (ack.optedOut === true && !pending() && enabled()) {
        kv.set(TELEMETRY_ENABLED_KEY, "off");
        queue.clear();
        return "stop";
      }
      return "more";
    }
    if (res.status === 403) {
      refused = true;
      queue.clear();
      deps.warn("telemetry/client.identity", new Error("the server refused this page's key"));
      return "stop";
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      serverHasNone = true;
      queue.clear();
      return "stop";
    }
    if (res.status === 400 || res.status === 413 || res.status === 415) {
      if (items.length > 1) batchLimit = Math.max(1, Math.floor(items.length / 2));
      else queue.remove(items);
      return "more";
    }
    backoff(res.retryAfterSeconds);
    return "stop";
  }

  async function flush(): Promise<void> {
    if (sending || !started || !available()) return;
    if (!deps.online() || deps.now() < notBefore) {
      if (queue.size() > 0 || pending()) schedule(FLUSH_DELAY_MS);
      return;
    }
    sending = true;
    try {
      if (pending() && !(await syncTodo())) return;
      for (let round = 0; round < BATCHES_PER_FLUSH && active(); round++) {
        const items = queue.take(limitsFor(batchLimit));
        if (items.length === 0) {
          batchLimit = TELEMETRY_MAX_EVENTS;
          return;
        }
        if ((await deliver(items)) === "stop") return;
      }
      if (active() && queue.size() > 0) schedule(FLUSH_SOON_MS);
    } finally {
      sending = false;
      if (active() && failures > 0 && (queue.size() > 0 || pending())) schedule(FLUSH_DELAY_MS);
    }
  }

  const note = (kind: "event" | "game" | "history", id: string, value: unknown): void => {
    if (!active()) return;
    if (queue.add(kind, id, value) && started) {
      schedule(queue.size() >= FLUSH_SOON_ITEMS ? FLUSH_SOON_MS : FLUSH_DELAY_MS);
    }
  };

  const payloadFits = (payload: unknown): boolean => {
    try {
      const text = JSON.stringify(payload);
      return text !== undefined && new TextEncoder().encode(text).length <= MAX_PAYLOAD_BYTES;
    } catch {
      return false;
    }
  };

  const record = (kind: string, payload?: unknown): void => {
    if (!KIND.test(kind) || !active()) return;
    const event: TelemetryEvent = { id: deps.newId(), kind, at: deps.now() };
    if (sessionId !== "") event.sessionId = sessionId;
    if (!deps.online()) event.offline = true;
    if (payload !== undefined && payloadFits(payload)) event.payload = payload;
    note("event", event.id, event);
  };

  return {
    async start() {
      if (started || identity === null) return;
      sessionId = deps.newId();
      sessionStartedAt = deps.now();
      sessionOffline = !deps.online();
      if (available()) await queue.load();
      started = true;
      try {
        device = await deps.device();
      } catch (error) {
        deps.warn("telemetry/client.device", error);
      }
      record("app_start");
      schedule(FLUSH_SOON_MS * 3);
    },

    record,

    recordGame(game) {
      if (!active()) return;
      const id = game.id !== undefined && GAME_ID.test(game.id) ? game.id : deps.newId();
      const full: TelemetryGame = { ...game, id, appVersion: deps.appVersion };
      if (sessionId !== "") full.sessionId = sessionId;
      if (device?.deviceClass) full.deviceClass = device.deviceClass;
      if (!deps.online()) full.offline = true;
      note("game", full.id, full);
    },

    recordHistory(kind, value, detail) {
      if (!KIND.test(kind) || !active()) return;
      const entry: TelemetryHistoryEntry = { id: deps.newId(), kind, at: deps.now() };
      if (value !== undefined && Number.isFinite(value)) entry.value = value;
      if (detail !== undefined && payloadFits(detail)) entry.detail = detail;
      note("history", entry.id, entry);
    },

    flush,

    flushOnHide() {
      if (!started || !active()) return;
      const root = base();
      if (root === null) return;
      const fresh = queue.take(limitsFor(TELEMETRY_MAX_EVENTS)).filter((i) => !beaconed.has(i.seq));
      const items: QueueItem[] = [];
      let bytes = 0;
      for (const item of fresh) {
        if (items.length > 0 && bytes + item.size > BEACON_BYTES) break;
        items.push(item);
        bytes += item.size;
      }
      const body = JSON.stringify(makeBatch(items));
      const url = `${root}${TELEMETRY_PATH}`;
      try {
        if (deps.beacon?.(url, body) === true) for (const item of items) beaconed.add(item.seq);
      } catch (error) {
        deps.warn("telemetry/client.beacon", error);
      }
    },

    async setEnabled(on) {
      if (on) kv.remove(TELEMETRY_ENABLED_KEY);
      else {
        kv.set(TELEMETRY_ENABLED_KEY, "off");
        queue.clear();
      }
      writeTodo({ ...readTodo(), optOut: !on });
      if (started && available()) await syncTodo();
    },

    async eraseMyData() {
      queue.clear();
      writeTodo({ ...readTodo(), erase: true });
      if (!available()) return false;
      await syncTodo();
      return !pending();
    },

    online() {
      if (started && active() && (queue.size() > 0 || pending())) {
        notBefore = 0;
        schedule(FLUSH_SOON_MS);
      }
    },

    status() {
      return {
        available: available(),
        enabled: enabled(),
        queued: queue.size(),
        serverHasNone,
        refused,
        pendingSync: pending(),
        failures,
      };
    },
  };
}
