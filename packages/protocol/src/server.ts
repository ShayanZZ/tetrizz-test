/**
 * The conversation between a game page and TetriZZ's own server, over one WebSocket.
 *
 * Every frame is one JSON text message with a `t` field naming its kind. The page speaks first
 * (`hello`, with its player id and the key that id derives from, see `identity.ts`); the server
 * answers `welcome` or refuses the connection. After that the page asks for a
 * room (`create`, `join`) with a request id (`rid`) and the server answers with the same `rid`;
 * everything else is a one-way message.
 *
 * The server keeps the roster, the host and the room's rules (seats, roles, password, who is host),
 * and relays game events between the players. It never looks inside an event's payload.
 *
 * Nothing here touches the DOM, the network or any other package.
 */
/** Path of the socket on the server, after its base address. */
export const SERVER_SOCKET_PATH = "/ws";

/** Players seated before further arrivals become spectators. */
export const SERVER_PLAYER_LIMIT = 4;

/**
 * How long the server holds the seat of a player whose connection dropped, in milliseconds. The
 * seat keeps its role, ready flag and (for the host) the host role; the player takes it back by
 * joining the same room again with the same player id. The server may use another value and says
 * which in `welcome`.
 */
export const SERVER_SEAT_GRACE_MS = 30_000;

/** The ceiling for one frame; a larger one is dropped by the server and the connection is closed. */
export const SERVER_MAX_FRAME_BYTES = 64 * 1024;

/** Longest accepted player name and room code, after trimming. */
export const SERVER_MAX_NAME = 16;
export const SERVER_MAX_ROOM_CODE = 12;
export const SERVER_MAX_PASSWORD = 16;

/** A seat as the roster lists it. */
export interface ServerSeat {
  id: string;
  username: string;
  state: {
    role: "player" | "spec";
    joined: number;
    ready?: boolean;
    /** Set by the server while the seat is held for a player whose connection dropped. */
    away?: boolean;
    [key: string]: unknown;
  };
}

/** Why a request was refused. */
export type ServerRefusal =
  | "not-found"
  | "password"
  | "wrong-password"
  | "version"
  | "identity"
  | "exists"
  | "full"
  | "busy"
  | "invalid";

/** Page to server. */
export type ClientToServer =
  | { t: "hello"; v: number; app: string; id: string; key: string; name: string }
  | {
      t: "create";
      rid: number;
      room: string;
      name: string;
      settings: Record<string, unknown>;
      password: string;
    }
  | { t: "join"; rid: number; room: string; name: string; password: string }
  | { t: "ev"; event: string; payload?: unknown }
  | { t: "settings"; settings: Record<string, unknown>; password?: string }
  | { t: "state"; state: Record<string, unknown> }
  | { t: "host"; newHost: string }
  | { t: "kick"; target: string }
  | { t: "leave" };

/** Server to page. */
export type ServerToClient =
  | { t: "welcome"; v: number; grace?: number }
  | { t: "refused"; rid?: number; reason: ServerRefusal; v?: number }
  | { t: "created"; rid: number; room: string; host: string }
  | {
      t: "joined";
      rid: number;
      room: string;
      host: string;
      isHost: boolean;
      seed: number;
      settings: Record<string, unknown>;
    }
  | { t: "ev"; from: string; event: string; payload?: unknown }
  | { t: "roster"; host: string; players: ServerSeat[] }
  | { t: "host"; host: string }
  | { t: "kicked" }
  | { t: "closed" };

const CLIENT_KINDS = new Set([
  "hello",
  "create",
  "join",
  "ev",
  "settings",
  "state",
  "host",
  "kick",
  "leave",
]);
const SERVER_KINDS = new Set([
  "welcome",
  "refused",
  "created",
  "joined",
  "ev",
  "roster",
  "host",
  "kicked",
  "closed",
]);

function parseObject(text: unknown, kinds: Set<string>): Record<string, unknown> | null {
  if (typeof text !== "string" || text.length > SERVER_MAX_FRAME_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = (value as { t?: unknown }).t;
  return typeof kind === "string" && kinds.has(kind) ? (value as Record<string, unknown>) : null;
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * A frame from a page as a message, or null when it is not valid. Only the fields the server relies
 * on are checked: event payloads stay opaque.
 */
export function parseClientMessage(text: unknown): ClientToServer | null {
  const m = parseObject(text, CLIENT_KINDS);
  if (!m) return null;
  switch (m.t) {
    case "hello":
      return typeof m.v === "number" &&
        isText(m.app, 32) &&
        isText(m.id, 64) &&
        m.id.length > 0 &&
        // A missing or wrong key is the server's to refuse (`identity`), so a page that sends none
        // is told why instead of being dropped.
        (m.key === undefined || isText(m.key, 128)) &&
        isText(m.name, SERVER_MAX_NAME * 4)
        ? (m as ClientToServer)
        : null;
    case "create":
      return Number.isInteger(m.rid) &&
        isText(m.room, SERVER_MAX_ROOM_CODE) &&
        isText(m.name, SERVER_MAX_NAME * 4) &&
        isRecord(m.settings) &&
        isText(m.password, SERVER_MAX_PASSWORD)
        ? (m as ClientToServer)
        : null;
    case "join":
      return Number.isInteger(m.rid) &&
        isText(m.room, SERVER_MAX_ROOM_CODE) &&
        isText(m.name, SERVER_MAX_NAME * 4) &&
        isText(m.password, SERVER_MAX_PASSWORD)
        ? (m as ClientToServer)
        : null;
    case "ev":
      return isText(m.event, 40) && m.event.length > 0 ? (m as ClientToServer) : null;
    case "settings":
      return isRecord(m.settings) &&
        (m.password === undefined || isText(m.password, SERVER_MAX_PASSWORD))
        ? (m as ClientToServer)
        : null;
    case "state":
      return isRecord(m.state) ? (m as ClientToServer) : null;
    case "host":
      return isText(m.newHost, 64) ? (m as ClientToServer) : null;
    case "kick":
      return isText(m.target, 64) ? (m as ClientToServer) : null;
    default:
      return m.t === "leave" ? { t: "leave" } : null;
  }
}

/** A frame from the server as a message, or null when it is not one this build understands. */
export function parseServerMessage(text: unknown): ServerToClient | null {
  const m = parseObject(text, SERVER_KINDS);
  if (!m) return null;
  switch (m.t) {
    case "welcome":
      return typeof m.v === "number" && (m.grace === undefined || typeof m.grace === "number")
        ? (m as ServerToClient)
        : null;
    case "refused":
      return typeof m.reason === "string" ? (m as ServerToClient) : null;
    case "created":
      return Number.isInteger(m.rid) && typeof m.room === "string" && typeof m.host === "string"
        ? (m as ServerToClient)
        : null;
    case "joined":
      return Number.isInteger(m.rid) &&
        typeof m.room === "string" &&
        typeof m.host === "string" &&
        typeof m.isHost === "boolean" &&
        typeof m.seed === "number" &&
        isRecord(m.settings)
        ? (m as ServerToClient)
        : null;
    case "ev":
      return typeof m.from === "string" && typeof m.event === "string"
        ? (m as ServerToClient)
        : null;
    case "roster":
      return typeof m.host === "string" && Array.isArray(m.players) ? (m as ServerToClient) : null;
    case "host":
      return typeof m.host === "string" ? (m as ServerToClient) : null;
    default:
      return m.t === "kicked" || m.t === "closed" ? ({ t: m.t } as ServerToClient) : null;
  }
}
