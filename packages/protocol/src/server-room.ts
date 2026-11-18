/**
 * The room rules of TetriZZ's own server, as a small in-memory model that speaks the wire protocol
 * of `server.ts`. It is the written-down behaviour the real server must show, and the stand-in the
 * client adapter is tested against.
 *
 * What the model decides: who may enter (room code, password, version), who is a player and who a
 * spectator, who is host and who takes over, which events reach whom, how long a dropped player's
 * seat is held, when a room ends. What it leaves to the real server: sockets, limits per address,
 * heartbeats, the database and logging. The password check is a hook (`passwords`): the model
 * compares plain text, the real server plugs in a salted hash.
 *
 * Nothing here touches the DOM, the network or any other package.
 */
import { nextHostCandidate } from "./room";
import {
  parseClientMessage,
  SERVER_PLAYER_LIMIT,
  SERVER_SEAT_GRACE_MS,
  type ClientToServer,
  type ServerRefusal,
  type ServerSeat,
  type ServerToClient,
} from "./server";
import { checkPeerVersion, PROTOCOL_VERSION } from "./version";

export interface ReferenceServerOptions {
  /** Wall-clock milliseconds, written into a seat as `joined`. */
  now?: () => number;
  /** A fresh match seed for a room whose creator sent none. */
  newSeed?: () => number;
  /** Rooms open at once; a further `create` is refused as `busy`. */
  maxRooms?: number;
  /**
   * How long the seat of a player whose connection dropped is held, in milliseconds (default
   * `SERVER_SEAT_GRACE_MS`). Zero removes the seat at once.
   */
  graceMs?: number;
  /** Runs `task` after `ms`; returns the function that cancels it. Defaults to `setTimeout`. */
  later?: (task: () => void, ms: number) => () => void;
  /** How a room's password is stored and checked. Defaults to plain text. */
  passwords?: PasswordRules;
}

/** Storing and checking room passwords; a real server keeps only a salted hash. */
export interface PasswordRules {
  /** The form to keep for a typed password (never called with an empty one). */
  hash(plain: string): string;
  /** Whether a typed password matches what `hash` returned. */
  verify(plain: string, stored: string): boolean;
}

const plainPasswords: PasswordRules = {
  hash: (plain) => plain,
  verify: (plain, stored) => plain === stored,
};

/** One connected page, as the transport under the server sees it. */
export interface ServerLink {
  /** A text frame arrived from the page. */
  receive(text: string): void;
  /** The connection ended. Safe to call twice. */
  close(): void;
}

export interface ReferenceServer {
  /** A page connected. `send` writes a text frame to it; `onClosed` runs when the server ends it. */
  connect(send: (text: string) => void, onClosed?: () => void): ServerLink;
  roomCount(): number;
  /** The seats of one room as a roster would list them, or null when the room does not exist. */
  seatsOf(code: string): ServerSeat[] | null;
}

interface Connection {
  id: string;
  name: string;
  greeted: boolean;
  open: boolean;
  room: Room | null;
  send(message: ServerToClient): void;
  end(): void;
}

/** One seat of a room: its roster entry, and the connection that holds it (null while it is held). */
interface Entry {
  seat: ServerSeat;
  conn: Connection | null;
  /** Cancels the end of the hold; set only while `conn` is null. */
  cancelHold: (() => void) | null;
}

interface Room {
  code: string;
  hostId: string;
  seed: number;
  settings: Record<string, unknown>;
  /** The stored form of the password; empty when the room has none. */
  password: string;
  seats: Map<string, Entry>;
}

const DEFAULT_MAX_ROOMS = 200;

// This package is built without DOM or Node types; the default timer is the host's own.
declare function setTimeout(task: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

export function createReferenceServer(options: ReferenceServerOptions = {}): ReferenceServer {
  const now = options.now ?? (() => Date.now());
  const newSeed = options.newSeed ?? (() => Math.floor(Math.random() * 0x7fffffff));
  const maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;
  const graceMs = Math.max(0, options.graceMs ?? SERVER_SEAT_GRACE_MS);
  const passwords = options.passwords ?? plainPasswords;
  const later =
    options.later ??
    ((task: () => void, ms: number): (() => void) => {
      const handle = setTimeout(task, ms);
      return () => clearTimeout(handle);
    });
  const rooms = new Map<string, Room>();
  const byId = new Map<string, Connection>();
  /** The room that holds the seat of each player whose connection dropped. */
  const heldIn = new Map<string, Room>();

  const rosterOf = (room: Room): ServerSeat[] =>
    [...room.seats.values()]
      .map((entry) => entry.seat)
      .sort((a, b) => {
        const ah = a.id === room.hostId ? 0 : 1;
        const bh = b.id === room.hostId ? 0 : 1;
        return ah - bh || a.state.joined - b.state.joined;
      });

  const toAll = (room: Room, message: ServerToClient, exceptId?: string): void => {
    for (const [id, entry] of room.seats)
      if (entry.conn && id !== exceptId) entry.conn.send(message);
  };

  const pushRoster = (room: Room): void =>
    toAll(room, { t: "roster", host: room.hostId, players: rosterOf(room) });

  const playerCount = (room: Room): number =>
    [...room.seats.values()].filter((e) => e.seat.state.role === "player").length;

  /** Ends the room for everyone left in it: connected seats are told, held seats are forgotten. */
  function closeRoom(room: Room): void {
    toAll(room, { t: "closed" });
    for (const [id, entry] of room.seats) {
      entry.cancelHold?.();
      entry.cancelHold = null;
      if (entry.conn) entry.conn.room = null;
      if (heldIn.get(id) === room) heldIn.delete(id);
    }
    room.seats.clear();
    rooms.delete(room.code);
  }

  /** Takes a seat out of its room for good and hands the room on, or ends it. */
  function removeSeat(room: Room, id: string): void {
    const entry = room.seats.get(id);
    if (!entry) return;
    entry.cancelHold?.();
    entry.cancelHold = null;
    if (entry.conn) entry.conn.room = null;
    if (heldIn.get(id) === room) heldIn.delete(id);
    room.seats.delete(id);
    if (!room.seats.size) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === id) {
      // A seat that is only held cannot take the room over: it may never come back.
      const present = rosterOf(room).filter((seat) => !seat.state.away);
      const next = nextHostCandidate(present, id);
      if (!next) return closeRoom(room);
      room.hostId = next.id;
      toAll(room, { t: "host", host: next.id });
    }
    pushRoster(room);
  }

  /** The connection of a seat ended: hold the seat for the grace period, or drop it at once. */
  function loseConnection(conn: Connection): void {
    const room = conn.room;
    if (!room) return;
    conn.room = null;
    const entry = room.seats.get(conn.id);
    if (!entry || entry.conn !== conn) return;
    if (graceMs <= 0) return removeSeat(room, conn.id);
    entry.conn = null;
    entry.seat = { ...entry.seat, state: { ...entry.seat.state, away: true } };
    heldIn.set(conn.id, room);
    entry.cancelHold = later(() => {
      if (room.seats.get(conn.id) === entry && !entry.conn) removeSeat(room, conn.id);
    }, graceMs);
    pushRoster(room);
  }

  /** A player who asks for another room gives up the seat held in the old one. */
  function releaseHeldSeat(id: string, except?: Room): void {
    const room = heldIn.get(id);
    if (room && room !== except) removeSeat(room, id);
  }

  function refuse(conn: Connection, rid: number | undefined, reason: ServerRefusal): void {
    conn.send({ t: "refused", rid, reason });
  }

  /** Seats the connection: takes back its own held seat, or adds a new one. */
  function seatIn(room: Room, conn: Connection, name: string): void {
    const known = room.seats.get(conn.id);
    if (known) {
      known.cancelHold?.();
      known.cancelHold = null;
      const state = { ...known.seat.state };
      delete state.away;
      known.seat = { ...known.seat, username: name, state };
      known.conn = conn;
      if (heldIn.get(conn.id) === room) heldIn.delete(conn.id);
    } else {
      room.seats.set(conn.id, {
        seat: {
          id: conn.id,
          username: name,
          state: {
            role: playerCount(room) < SERVER_PLAYER_LIMIT ? "player" : "spec",
            joined: now(),
          },
        },
        conn,
        cancelHold: null,
      });
    }
    conn.room = room;
  }

  function onCreate(conn: Connection, m: Extract<ClientToServer, { t: "create" }>): void {
    if (conn.room) return refuse(conn, m.rid, "busy");
    const code = m.room.trim().toUpperCase();
    if (!code) return refuse(conn, m.rid, "invalid");
    if (rooms.has(code)) return refuse(conn, m.rid, "exists");
    if (rooms.size >= maxRooms) return refuse(conn, m.rid, "busy");
    releaseHeldSeat(conn.id);
    const seed = typeof m.settings.seed === "number" ? m.settings.seed : newSeed();
    const room: Room = {
      code,
      hostId: conn.id,
      seed,
      settings: { ...m.settings, seed },
      password: m.password ? passwords.hash(m.password) : "",
      seats: new Map(),
    };
    rooms.set(code, room);
    seatIn(room, conn, m.name);
    conn.send({ t: "created", rid: m.rid, room: code, host: conn.id });
    pushRoster(room);
  }

  function onJoin(conn: Connection, m: Extract<ClientToServer, { t: "join" }>): void {
    if (conn.room) return refuse(conn, m.rid, "busy");
    const room = rooms.get(m.room.trim().toUpperCase());
    if (!room) return refuse(conn, m.rid, "not-found");
    // A player who already has a seat here (held or not) was let in once, so is not asked again.
    if (room.password && !room.seats.has(conn.id)) {
      if (!m.password) return refuse(conn, m.rid, "password");
      if (!passwords.verify(m.password, room.password))
        return refuse(conn, m.rid, "wrong-password");
    }
    releaseHeldSeat(conn.id, room);
    seatIn(room, conn, m.name);
    conn.send({
      t: "joined",
      rid: m.rid,
      room: room.code,
      host: room.hostId,
      isHost: room.hostId === conn.id,
      seed: room.seed,
      settings: room.settings,
    });
    pushRoster(room);
  }

  function onMessage(conn: Connection, m: ClientToServer): void {
    const room = conn.room;
    switch (m.t) {
      case "hello":
        return;
      case "create":
        return onCreate(conn, m);
      case "join":
        return onJoin(conn, m);
      case "leave":
        if (room) removeSeat(room, conn.id);
        return;
      default:
    }
    if (!room) return;
    switch (m.t) {
      case "ev":
        toAll(room, { t: "ev", from: conn.id, event: m.event, payload: m.payload }, conn.id);
        return;
      case "settings":
        if (room.hostId !== conn.id) return;
        // The password travels beside the rules, never inside them: players are not told it.
        if (m.password !== undefined) room.password = m.password ? passwords.hash(m.password) : "";
        room.settings = { ...m.settings, seed: room.seed };
        toAll(room, { t: "ev", from: conn.id, event: "settings", payload: room.settings }, conn.id);
        return;
      case "state": {
        const entry = room.seats.get(conn.id);
        if (!entry) return;
        const next = { ...entry.seat.state, ...m.state } as ServerSeat["state"];
        // `away` belongs to the server; a connected seat is never away.
        delete next.away;
        const wantsSeat = next.role === "player" && entry.seat.state.role !== "player";
        if (
          (next.role !== "player" && next.role !== "spec") ||
          (wantsSeat && playerCount(room) >= SERVER_PLAYER_LIMIT)
        ) {
          next.role = entry.seat.state.role;
        }
        entry.seat = { ...entry.seat, state: next };
        pushRoster(room);
        return;
      }
      case "host":
        if (room.hostId !== conn.id || !room.seats.has(m.newHost) || m.newHost === conn.id) return;
        room.hostId = m.newHost;
        toAll(room, { t: "host", host: m.newHost });
        pushRoster(room);
        return;
      case "kick": {
        const target = room.seats.get(m.target);
        if (room.hostId !== conn.id || !target || m.target === conn.id) return;
        target.conn?.send({ t: "kicked" });
        removeSeat(room, m.target);
        return;
      }
      default:
    }
  }

  return {
    connect(send, onClosed) {
      const conn: Connection = {
        id: "",
        name: "",
        greeted: false,
        open: true,
        room: null,
        send: (message) => {
          if (conn.open) send(JSON.stringify(message));
        },
        end: () => {
          if (!conn.open) return;
          loseConnection(conn);
          conn.open = false;
          if (conn.id && byId.get(conn.id) === conn) byId.delete(conn.id);
          onClosed?.();
        },
      };
      return {
        receive(text) {
          if (!conn.open) return;
          const m = parseClientMessage(text);
          if (!m) return conn.end();
          if (!conn.greeted) {
            if (m.t !== "hello") return conn.end();
            if (checkPeerVersion(m.v) !== "ok") {
              conn.send({ t: "refused", reason: "version", v: PROTOCOL_VERSION });
              return conn.end();
            }
            byId.get(m.id)?.end();
            conn.id = m.id;
            conn.name = m.name;
            conn.greeted = true;
            byId.set(conn.id, conn);
            conn.send({ t: "welcome", v: PROTOCOL_VERSION, grace: Math.round(graceMs / 1000) });
            return;
          }
          onMessage(conn, m);
        },
        close: () => conn.end(),
      };
    },
    roomCount: () => rooms.size,
    seatsOf: (code) => {
      const room = rooms.get(code);
      return room ? rosterOf(room) : null;
    },
  };
}
