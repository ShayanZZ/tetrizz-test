/**
 * What a game page sends to the server's `/api/v1` so the owner can see how the game is used.
 *
 * One request carries a batch: who is sending, when the page's clock said it was, optionally the
 * session and the coarse device description, and the raw events, finished games and history lines
 * collected since the last upload. Every item has an id the page made up, so sending the same item
 * twice (a retry after a lost answer) changes nothing on the server.
 *
 * `parseTelemetryBatch` is the one reader of this format. It is strict about the structure of the
 * request and forgiving about single items: an item that does not fit is counted in `rejected`
 * and left out, so one bad event can never make a page retry the same batch for ever. Nothing here
 * touches the DOM, the network or any other package.
 */

export const TELEMETRY_VERSION = 1;

export const TELEMETRY_PATH = "/api/v1/telemetry";
/** `PUT <this>/<player id>/telemetry` sets the opt-out; `DELETE <this>/<player id>` erases the player. */
export const PLAYERS_PATH = "/api/v1/players";

/** Largest request body the server reads, in bytes. */
export const TELEMETRY_MAX_BODY_BYTES = 256 * 1024;
export const TELEMETRY_MAX_EVENTS = 200;
export const TELEMETRY_MAX_GAMES = 20;
export const TELEMETRY_MAX_HISTORY = 50;
/** Largest `payload` of one event, as JSON text. */
export const TELEMETRY_MAX_PAYLOAD_BYTES = 2048;
export const TELEMETRY_MAX_GAME_PLAYERS = 16;

export type TelemetryDeviceClass = "desktop" | "mobile" | "tablet" | "unknown";
export type TelemetryDisplayMode = "browser" | "pwa" | "single-file";
export type TelemetryResult = "win" | "loss" | "draw" | "finished" | "quit";

/** Coarse facts about a device. Every field is optional; nothing here identifies a person. */
export interface TelemetryDevice {
  deviceClass?: TelemetryDeviceClass;
  os?: string;
  osVersion?: string;
  browser?: string;
  browserVersion?: string;
  engine?: string;
  /** A size bucket such as `360x800`. */
  screen?: string;
  dpr?: number;
  cores?: number;
  memoryGb?: number;
  language?: string;
  displayMode?: TelemetryDisplayMode;
  model?: string;
}

export interface TelemetrySession {
  id: string;
  startedAt: number;
  endedAt?: number;
  appVersion?: string;
  displayMode?: TelemetryDisplayMode;
  deviceClass?: TelemetryDeviceClass;
  /** The session began while the page had no connection. */
  offline?: boolean;
}

export interface TelemetryEvent {
  id: string;
  /** Lower-case words joined by underscores, for example `game_start` or `js_error`. */
  kind: string;
  /** When it happened, by the page's clock (milliseconds since the epoch). */
  at: number;
  sessionId?: string;
  /** Recorded while the page had no connection. */
  offline?: boolean;
  payload?: unknown;
}

export interface TelemetryGamePlayer {
  /** Only the sender's own row is stored; rows for other players are rejected. Every human player of a match reports their own row under the match's one game id. */
  playerId: string;
  seat?: number;
  result: TelemetryResult;
  lines: number;
  score: number;
  pieces: number;
  pps?: number;
  apm?: number;
}

export interface TelemetryGame {
  id: string;
  sessionId?: string;
  mode: string;
  startedAt: number;
  durationMs: number;
  bots?: number;
  botLevel?: number;
  appVersion?: string;
  deviceClass?: TelemetryDeviceClass;
  offline?: boolean;
  players: TelemetryGamePlayer[];
}

export interface TelemetryHistoryEntry {
  id: string;
  /** For example `personal_best`. */
  kind: string;
  value?: number;
  detail?: unknown;
  at: number;
}

export interface TelemetryBatch {
  v: number;
  playerId: string;
  /** The page's clock when the request was made; the server uses it to correct clock skew. */
  sentAt: number;
  device?: TelemetryDevice;
  session?: TelemetrySession;
  events: TelemetryEvent[];
  games: TelemetryGame[];
  history: TelemetryHistoryEntry[];
}

export interface ParsedTelemetry {
  batch: TelemetryBatch;
  /** Items that did not fit the format and were left out. */
  rejected: number;
  /** The sender's player key, to be checked against `batch.playerId` and never stored or logged. */
  key: string;
}

export type TelemetryParseResult =
  { ok: true; value: ParsedTelemetry } | { ok: false; error: string };

/** The answer to a telemetry request. */
export interface TelemetryAck {
  v: number;
  ok: true;
  /** The player switched telemetry off; nothing was stored. */
  optedOut?: boolean;
  stored: { events: number; games: number; history: number };
  /** Items the server already had; the page can forget them. */
  duplicates: { events: number; games: number; history: number };
  /** Games that already existed (another player of the same match reported first) and that got this player's row. Left out when none. */
  joined?: number;
  rejected: number;
  /** Events too old to keep (older than the retention period); the page can forget them. */
  stale: number;
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const KIND = /^[a-z][a-z0-9_]{0,39}$/;
const MODE = /^[a-z0-9_-]{1,24}$/;
const VERSION = /^[0-9A-Za-z.+_-]{1,24}$/;
const PLAIN = /^[\x20-\x7e]{1,40}$/;
const SCREEN = /^\d{2,5}x\d{2,5}$/;

/** 2000-01-01 and 2100-01-01 in milliseconds: anything outside is a broken clock or a bad field. */
const MIN_TIME = 946_684_800_000;
const MAX_TIME = 4_102_444_800_000;
const DAY_MS = 86_400_000;

const RESULTS: readonly string[] = ["win", "loss", "draw", "finished", "quit"];
const DEVICE_CLASSES: readonly string[] = ["desktop", "mobile", "tablet", "unknown"];
const DISPLAY_MODES: readonly string[] = ["browser", "pwa", "single-file"];

type Bag = Record<string, unknown>;

const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, pattern: RegExp): string | undefined =>
  typeof v === "string" && pattern.test(v) ? v : undefined;
const whole = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
const real = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
const oneOf = <T extends string>(v: unknown, list: readonly string[]): T | undefined =>
  typeof v === "string" && list.includes(v) ? (v as T) : undefined;
const when = (v: unknown): number | undefined => whole(v, MIN_TIME, MAX_TIME);

/** JSON text of a value, or null when it cannot be written or is larger than `limit` bytes. */
function jsonWithin(value: unknown, limit: number): string | null {
  try {
    const out = JSON.stringify(value);
    return out !== undefined && utf8Length(out) <= limit ? out : null;
  } catch {
    return null;
  }
}

/** UTF-8 length without `Buffer`, which the browser does not have. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Keeps only the fields that are present and valid. Never fails: a device is optional detail. */
export function parseTelemetryDevice(raw: unknown): TelemetryDevice | undefined {
  if (!isBag(raw)) return undefined;
  const out: TelemetryDevice = {};
  const set = <K extends keyof TelemetryDevice>(key: K, value: TelemetryDevice[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  set("deviceClass", oneOf<TelemetryDeviceClass>(raw.deviceClass, DEVICE_CLASSES));
  set("os", text(raw.os, PLAIN));
  set("osVersion", text(raw.osVersion, PLAIN));
  set("browser", text(raw.browser, PLAIN));
  set("browserVersion", text(raw.browserVersion, PLAIN));
  set("engine", text(raw.engine, PLAIN));
  set("screen", text(raw.screen, SCREEN));
  set("dpr", real(raw.dpr, 0.5, 10));
  set("cores", whole(raw.cores, 1, 256));
  set("memoryGb", real(raw.memoryGb, 0.1, 1024));
  set("language", text(raw.language, PLAIN));
  set("displayMode", oneOf<TelemetryDisplayMode>(raw.displayMode, DISPLAY_MODES));
  set("model", text(raw.model, PLAIN));
  return Object.keys(out).length ? out : undefined;
}

function parseSession(raw: unknown): TelemetrySession | undefined {
  if (!isBag(raw)) return undefined;
  const id = text(raw.id, ID);
  const startedAt = when(raw.startedAt);
  if (id === undefined || startedAt === undefined) return undefined;
  const out: TelemetrySession = { id, startedAt };
  const endedAt = when(raw.endedAt);
  if (endedAt !== undefined && endedAt >= startedAt) out.endedAt = endedAt;
  const appVersion = text(raw.appVersion, VERSION);
  if (appVersion !== undefined) out.appVersion = appVersion;
  const displayMode = oneOf<TelemetryDisplayMode>(raw.displayMode, DISPLAY_MODES);
  if (displayMode !== undefined) out.displayMode = displayMode;
  const deviceClass = oneOf<TelemetryDeviceClass>(raw.deviceClass, DEVICE_CLASSES);
  if (deviceClass !== undefined) out.deviceClass = deviceClass;
  if (raw.offline === true) out.offline = true;
  return out;
}

function parseEvent(raw: unknown): TelemetryEvent | undefined {
  if (!isBag(raw)) return undefined;
  const id = text(raw.id, ID);
  const kind = text(raw.kind, KIND);
  const at = when(raw.at);
  if (id === undefined || kind === undefined || at === undefined) return undefined;
  const out: TelemetryEvent = { id, kind, at };
  if (raw.sessionId !== undefined) {
    const sessionId = text(raw.sessionId, ID);
    if (sessionId === undefined) return undefined;
    out.sessionId = sessionId;
  }
  if (raw.offline === true) out.offline = true;
  if (raw.payload !== undefined) {
    if (jsonWithin(raw.payload, TELEMETRY_MAX_PAYLOAD_BYTES) === null) return undefined;
    out.payload = raw.payload;
  }
  return out;
}

function parseGamePlayer(raw: unknown): TelemetryGamePlayer | undefined {
  if (!isBag(raw)) return undefined;
  const playerId = text(raw.playerId, ID);
  const result = oneOf<TelemetryResult>(raw.result, RESULTS);
  const lines = whole(raw.lines, 0, 100_000);
  const score = whole(raw.score, 0, 2_000_000_000);
  const pieces = whole(raw.pieces, 0, 1_000_000);
  if (
    playerId === undefined ||
    result === undefined ||
    lines === undefined ||
    score === undefined ||
    pieces === undefined
  ) {
    return undefined;
  }
  const out: TelemetryGamePlayer = { playerId, result, lines, score, pieces };
  const seat = whole(raw.seat, 0, 15);
  if (seat !== undefined) out.seat = seat;
  const pps = real(raw.pps, 0, 100);
  if (pps !== undefined) out.pps = pps;
  const apm = real(raw.apm, 0, 2000);
  if (apm !== undefined) out.apm = apm;
  return out;
}

function parseGame(raw: unknown): TelemetryGame | undefined {
  if (!isBag(raw) || !Array.isArray(raw.players)) return undefined;
  const id = text(raw.id, ID);
  const mode = text(raw.mode, MODE);
  const startedAt = when(raw.startedAt);
  const durationMs = whole(raw.durationMs, 0, DAY_MS);
  if (id === undefined || mode === undefined || startedAt === undefined) return undefined;
  if (durationMs === undefined) return undefined;
  if (raw.players.length === 0 || raw.players.length > TELEMETRY_MAX_GAME_PLAYERS) return undefined;
  const players: TelemetryGamePlayer[] = [];
  for (const entry of raw.players) {
    const player = parseGamePlayer(entry);
    if (!player) return undefined;
    players.push(player);
  }
  const out: TelemetryGame = { id, mode, startedAt, durationMs, players };
  if (raw.sessionId !== undefined) {
    const sessionId = text(raw.sessionId, ID);
    if (sessionId === undefined) return undefined;
    out.sessionId = sessionId;
  }
  const bots = whole(raw.bots, 0, 15);
  if (bots !== undefined) out.bots = bots;
  const botLevel = whole(raw.botLevel, 1, 10);
  if (botLevel !== undefined) out.botLevel = botLevel;
  const appVersion = text(raw.appVersion, VERSION);
  if (appVersion !== undefined) out.appVersion = appVersion;
  const deviceClass = oneOf<TelemetryDeviceClass>(raw.deviceClass, DEVICE_CLASSES);
  if (deviceClass !== undefined) out.deviceClass = deviceClass;
  if (raw.offline === true) out.offline = true;
  return out;
}

function parseHistory(raw: unknown): TelemetryHistoryEntry | undefined {
  if (!isBag(raw)) return undefined;
  const id = text(raw.id, ID);
  const kind = text(raw.kind, KIND);
  const at = when(raw.at);
  if (id === undefined || kind === undefined || at === undefined) return undefined;
  const out: TelemetryHistoryEntry = { id, kind, at };
  if (raw.value !== undefined) {
    const value = real(raw.value, -1e12, 1e12);
    if (value === undefined) return undefined;
    out.value = value;
  }
  if (raw.detail !== undefined) {
    if (jsonWithin(raw.detail, TELEMETRY_MAX_PAYLOAD_BYTES) === null) return undefined;
    out.detail = raw.detail;
  }
  return out;
}

function parseList<T>(raw: unknown, max: number, one: (x: unknown) => T | undefined) {
  if (raw === undefined) return { items: [] as T[], rejected: 0 };
  if (!Array.isArray(raw) || raw.length > max) return null;
  const items: T[] = [];
  let rejected = 0;
  for (const entry of raw) {
    const item = one(entry);
    if (item === undefined) rejected++;
    else items.push(item);
  }
  return { items, rejected };
}

/** Reads a request body (already parsed from JSON). */
export function parseTelemetryBatch(body: unknown): TelemetryParseResult {
  if (!isBag(body)) return { ok: false, error: "body must be an object" };
  const v = whole(body.v, 1, 1_000_000);
  if (v === undefined) return { ok: false, error: "v is missing" };
  if (v > TELEMETRY_VERSION) return { ok: false, error: "newer format" };
  const playerId = text(body.playerId, ID);
  if (playerId === undefined) return { ok: false, error: "playerId is not valid" };
  // Not part of the batch: the server checks it against the id and then forgets it.
  const key = body.key;
  if (typeof key !== "string" || key.length > 128) return { ok: false, error: "key is missing" };
  const sentAt = when(body.sentAt);
  if (sentAt === undefined) return { ok: false, error: "sentAt is not valid" };

  const events = parseList(body.events, TELEMETRY_MAX_EVENTS, parseEvent);
  if (!events)
    return { ok: false, error: `events must be a list of at most ${TELEMETRY_MAX_EVENTS}` };
  const games = parseList(body.games, TELEMETRY_MAX_GAMES, parseGame);
  if (!games) return { ok: false, error: `games must be a list of at most ${TELEMETRY_MAX_GAMES}` };
  const history = parseList(body.history, TELEMETRY_MAX_HISTORY, parseHistory);
  if (!history) {
    return { ok: false, error: `history must be a list of at most ${TELEMETRY_MAX_HISTORY}` };
  }

  const batch: TelemetryBatch = {
    v,
    playerId,
    sentAt,
    events: events.items,
    games: games.items,
    history: history.items,
  };
  const device = parseTelemetryDevice(body.device);
  if (device) batch.device = device;
  let rejected = events.rejected + games.rejected + history.rejected;
  if (body.session !== undefined) {
    const session = parseSession(body.session);
    if (session) batch.session = session;
    else rejected++;
  }
  return { ok: true, value: { batch, rejected, key } };
}

/** Whether `value` looks like a player id (also the shape of the id in `/api/v1/players/<id>`). */
export function isPlayerId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
