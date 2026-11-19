/**
 * The page's connection to TetriZZ's own server: opens the WebSocket, introduces the player,
 * matches answers to requests and hands everything else to listeners. It knows the wire protocol of
 * `@tetrizz/protocol` and nothing about the lobby or the game; the socket, timers and version it
 * uses are passed in, so it runs under test without a network.
 */
import {
  checkPeerVersion,
  parseServerMessage,
  PROTOCOL_VERSION,
  SERVER_SEAT_GRACE_MS,
  SERVER_SOCKET_PATH,
  type ClientToServer,
  type ServerToClient,
} from "@tetrizz/protocol";

/** The part of a browser `WebSocket` this module uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export const SOCKET_OPEN = 1;

export const CONNECT_TIMEOUT_MS = 5000;
export const REQUEST_TIMEOUT_MS = 8000;

/**
 * The WebSocket address for the configured server: an http(s) or ws(s) URL, or a path on the page's
 * own origin (`origin` is that origin, such as `https://example.org`), with the socket path added.
 */
export function serverSocketUrl(configured: string, origin: string): string {
  const url = new URL(configured.startsWith("/") ? origin + configured : configured);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  url.pathname = url.pathname.replace(/\/+$/, "") + SERVER_SOCKET_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export interface ServerSocketDeps {
  /** The socket address, read when a connection is made (the settings can change before that). */
  url(): string;
  createSocket(url: string): SocketLike;
  /** Runs `task` after `ms`; returns the function that cancels it. */
  later(task: () => void, ms: number): () => void;
  /** The build's version, sent in `hello` for the server's records. */
  appVersion: string;
  /** The player key that proves the id in `hello` (`identity.ts`); read at each connection. */
  key(): string;
  warn(scope: string, error: unknown): void;
}

export type ConnectResult = "ok" | "unreachable" | "version" | "identity";

/** What a request ends with: the server's answer, or the reason none came. */
export type RequestResult =
  | Extract<ServerToClient, { t: "created" | "joined" | "refused" }>
  | { t: "lost"; reason: "timeout" | "closed" };

type RoomRequest = Extract<ClientToServer, { t: "create" | "join" }>;
type WithoutRid<T> = T extends unknown ? Omit<T, "rid"> : never;

export interface ServerSocket {
  /** Opens the connection and introduces the player. Settles `ok` once the server has welcomed. */
  connect(identity: { id: string; name: string }): Promise<ConnectResult>;
  /** Sends a room request and waits for the answer carrying its id. Never rejects. */
  request(message: WithoutRid<RoomRequest>): Promise<RequestResult>;
  /** Sends a one-way message; dropped when the connection is not open. */
  send(message: ClientToServer): void;
  /** Hears every message that is not the answer to a request. Returns the way to stop. */
  onMessage(handler: (message: ServerToClient) => void): () => void;
  /** Runs when an established connection ends, for any reason. Returns the way to stop. */
  onClose(handler: () => void): () => void;
  isOpen(): boolean;
  /**
   * How long the server holds the seat of a player who dropped, in milliseconds: what it said when
   * it last welcomed this page, or the protocol's default before that.
   */
  graceMs(): number;
  /** Ends the connection. Safe to call twice. */
  close(): void;
}

export function createServerSocket(deps: ServerSocketDeps): ServerSocket {
  let socket: SocketLike | null = null;
  let greeted = false;
  let connecting: Promise<ConnectResult> | null = null;
  let nextRid = 1;
  let seatGraceMs = SERVER_SEAT_GRACE_MS;
  const pending = new Map<number, (result: RequestResult) => void>();
  let messageHandlers: Array<(message: ServerToClient) => void> = [];
  let closeHandlers: Array<() => void> = [];

  const failPending = (reason: "timeout" | "closed"): void => {
    for (const settle of [...pending.values()]) settle({ t: "lost", reason });
    pending.clear();
  };

  function endConnection(): void {
    const was = socket;
    const wasGreeted = greeted;
    socket = null;
    greeted = false;
    connecting = null;
    if (was) {
      was.onopen = was.onmessage = was.onclose = was.onerror = null;
      try {
        was.close();
      } catch (error) {
        deps.warn("net/server-socket.close", error);
      }
    }
    failPending("closed");
    if (wasGreeted) for (const handler of closeHandlers.slice()) handler();
  }

  function onFrame(data: unknown): void {
    const message = parseServerMessage(data);
    if (!message) return;
    if ("rid" in message && typeof message.rid === "number") {
      const settle = pending.get(message.rid);
      if (!settle) return;
      pending.delete(message.rid);
      if (message.t === "created" || message.t === "joined" || message.t === "refused") {
        settle(message);
      }
      return;
    }
    for (const handler of messageHandlers.slice()) handler(message);
  }

  return {
    connect(identity) {
      if (greeted && socket) return Promise.resolve("ok");
      if (connecting) return connecting;
      connecting = new Promise<ConnectResult>((resolve) => {
        let settled = false;
        let cancelTimer: () => void = () => {};
        const settle = (result: ConnectResult): void => {
          if (settled) return;
          settled = true;
          cancelTimer();
          if (result !== "ok") endConnection();
          resolve(result);
        };
        let created: SocketLike;
        try {
          created = deps.createSocket(deps.url());
        } catch (error) {
          deps.warn("net/server-socket.connect", error);
          settle("unreachable");
          return;
        }
        socket = created;
        cancelTimer = deps.later(() => settle("unreachable"), CONNECT_TIMEOUT_MS);
        created.onopen = () => {
          created.send(
            JSON.stringify({
              t: "hello",
              v: PROTOCOL_VERSION,
              app: deps.appVersion,
              id: identity.id,
              key: deps.key(),
              name: identity.name,
            }),
          );
        };
        created.onmessage = (event) => {
          if (!greeted) {
            const message = parseServerMessage(event.data);
            if (message?.t === "welcome") {
              if (checkPeerVersion(message.v) !== "ok") return settle("version");
              greeted = true;
              if (typeof message.grace === "number" && message.grace >= 0) {
                seatGraceMs = Math.round(message.grace * 1000);
              }
              settle("ok");
            } else if (message?.t === "refused") {
              if (message.reason === "identity") {
                deps.warn(
                  "net/server-socket.identity",
                  new Error("the server refused the player key"),
                );
                settle("identity");
              } else {
                settle(message.reason === "version" ? "version" : "unreachable");
              }
            }
            return;
          }
          onFrame(event.data);
        };
        created.onclose = () => {
          if (settled) endConnection();
          else settle("unreachable");
        };
        created.onerror = () => {
          if (!settled) settle("unreachable");
        };
      });
      return connecting;
    },
    request(message) {
      return new Promise<RequestResult>((resolve) => {
        if (!socket || !greeted || socket.readyState !== SOCKET_OPEN) {
          resolve({ t: "lost", reason: "closed" });
          return;
        }
        const rid = nextRid++;
        const cancelTimer = deps.later(() => {
          if (pending.delete(rid)) resolve({ t: "lost", reason: "timeout" });
        }, REQUEST_TIMEOUT_MS);
        pending.set(rid, (result) => {
          cancelTimer();
          resolve(result);
        });
        try {
          socket.send(JSON.stringify({ ...message, rid }));
        } catch (error) {
          deps.warn("net/server-socket.request", error);
          pending.delete(rid);
          cancelTimer();
          resolve({ t: "lost", reason: "closed" });
        }
      });
    },
    send(message) {
      if (!socket || !greeted || socket.readyState !== SOCKET_OPEN) return;
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        deps.warn("net/server-socket.send", error);
      }
    },
    onMessage(handler) {
      messageHandlers.push(handler);
      return () => {
        messageHandlers = messageHandlers.filter((h) => h !== handler);
      };
    },
    onClose(handler) {
      closeHandlers.push(handler);
      return () => {
        closeHandlers = closeHandlers.filter((h) => h !== handler);
      };
    },
    isOpen: () => !!socket && greeted && socket.readyState === SOCKET_OPEN,
    graceMs: () => seatGraceMs,
    close: endConnection,
  };
}
