/**
 * What a network backend does for a room besides carrying messages: open it, join it, leave it, drop
 * out of it, record a new host or a seat's state, remove a player. Opening and joining answer with a
 * result the lobby turns into screens and notes, so a backend never touches the page.
 * Nothing here touches the DOM, the network or any other package.
 */
import type { MemoryHub, Transport, TransportKind } from "./transport";

/** A seat in the room as the lobby keeps it. */
export interface RoomPlayer {
  id: string;
  username: string;
  state?: { role?: string; joined?: number; ready?: boolean; [key: string]: unknown } | null;
}

/** Which room, and which player is asking. `roomId` is null when no room is open. */
export interface RoomRef {
  roomId: string | null;
  myId: string;
}

export interface LeaveRequest extends RoomRef {
  myName: string;
  isHost: boolean;
  /** Tell the others (`left`) before going. False when the page is closing or the room is gone. */
  announce: boolean;
  /** The roster the game holds now; backends without a database pick the next host from it. */
  players: readonly RoomPlayer[];
}

export interface SetHostRequest extends RoomRef {
  newHost: string;
}

export interface SetPasswordRequest extends RoomRef {
  /** The new password; empty removes it. */
  password: string;
  /** The room's rules as the host publishes them now, sent along so that they stay in step. */
  settings: Record<string, unknown>;
}

export interface SaveStateRequest {
  myId: string;
  /** The seat's `state` object as the lobby holds it (role, joined, ready). */
  state: unknown;
}

export interface KickRequest extends RoomRef {
  targetId: string;
}

export interface CreateRoomRequest extends RoomRef {
  /** The code the caller chose for the room. */
  roomId: string;
  myName: string;
  /** The lobby's rules without the player list; `seed` and `pwdH` (hash of the password) included. */
  settings: Record<string, unknown>;
  /** What the host typed for a protected room; empty for an open one. Backends that keep the password themselves check it from this. */
  password?: string;
  /** Wall-clock milliseconds, written into the seat as `joined`. */
  now: number;
}

export type CreateRoomResult =
  | { ok: true; roomId: string; hostId: string }
  | {
      ok: false;
      /**
       * `unavailable`: this backend is not set up here. `failed`: it refused or errored. `manual`: the
       * room is made by hand outside this interface (a LAN room is made in the LAN panel).
       */
      reason: "unavailable" | "failed" | "manual";
    };

export interface JoinRoomRequest extends RoomRef {
  roomId: string;
  myName: string;
  /** What the player typed for a protected room; empty when nothing was asked yet. */
  password: string;
  /** The caller already compared the password with the room's hash (backends that cannot check it). */
  passwordChecked: boolean;
  now: number;
}

/** What a player learns when a room accepts them. */
export interface JoinedRoom {
  roomId: string;
  hostId: string;
  isHost: boolean;
  seed: number;
  /** The room's rules as the host published them, `seed` and `pwdH` included. */
  settings: Record<string, unknown>;
}

export type JoinRoomResult =
  | ({ ok: true } & JoinedRoom)
  | {
      ok: false;
      /**
       * `not-found`: no room answered. `password`: the room is protected (`pwdH` is its hash where the
       * backend can tell; `wrongPassword` when the password given was refused). `version`: the other
       * side runs a protocol this build cannot share. `unreachable`: no server could be reached.
       * `unavailable`, `failed` and `manual` as for `CreateRoomResult`.
       */
      reason:
        "not-found" | "password" | "version" | "unreachable" | "unavailable" | "failed" | "manual";
      wrongPassword?: boolean;
      pwdH?: string;
    };

export interface RoomBackend {
  readonly kind: TransportKind;
  /** The message path of this backend; closing the room closes it. */
  readonly transport: Transport;
  /** Open a room with the caller as host. Never throws: a refusal is a result. */
  create(request: CreateRoomRequest): Promise<CreateRoomResult>;
  /** Enter a room. Never throws; settles once the room accepts the player or refuses. */
  join(request: JoinRoomRequest): Promise<JoinRoomResult>;
  /**
   * Leave on purpose: say goodbye, hand the room on or close it, then close the transport. A backend
   * with nothing to wait for returns nothing, so that the caller carries on in the same tick.
   */
  leave(request: LeaveRequest): void | Promise<void>;
  /** Go without a goodbye (kicked, or the host closed the room): close the transport. */
  drop(request: RoomRef): void;
  /** Record a new host where the backend keeps one (a database row); elsewhere nothing to do. */
  setHost(request: SetHostRequest): void;
  /**
   * Change the room's password where the backend checks it itself (the own server). Backends that
   * leave the check to the players' pages do not have it: the host's new rules carry the change.
   */
  setPassword?(request: SetPasswordRequest): void;
  /** Record this seat's state where the backend keeps seats; elsewhere nothing to do. */
  saveMyState(request: SaveStateRequest): void;
  /** Remove another player's connection or seat; the `kick` message itself is sent by the caller. */
  kick(request: KickRequest): void;
}

/** Who takes over when the host leaves: the first seated player who is not a spectator or the leaver. */
export function nextHostCandidate(
  players: readonly RoomPlayer[],
  leaverId: string,
): RoomPlayer | null {
  for (const player of players) {
    if (player.id === leaverId) continue;
    if (player.state && player.state.role === "spec") continue;
    return player;
  }
  return null;
}

export interface MemoryRoomPeer {
  readonly id: string;
  readonly backend: RoomBackend;
  /** The roster this peer holds, in seat order. */
  roster(): RoomPlayer[];
  hostId(): string | null;
  isHost(): boolean;
  /** The host closed the room. */
  closed(): boolean;
  /** This peer was kicked. */
  removed(): boolean;
  setReady(ready: boolean): void;
  /** Host only: remove a player. */
  kick(targetId: string): void;
  leave(announce?: boolean): void | Promise<void>;
}

export interface MemoryRoom {
  /** Opens the room with this peer as host; `settings` are what a joining peer is told. */
  create(peerId: string, name: string, settings?: Record<string, unknown>): MemoryRoomPeer;
  /** Seats a peer (a player unless `role` says otherwise); the host announces the new roster. */
  join(peerId: string, name: string, role?: string): MemoryRoomPeer;
  /** A peer on the hub that is in no room yet: its backend's `create` and `join` do the entering. */
  peer(peerId: string, name: string, role?: string): MemoryRoomPeer;
}

export const MEMORY_ROOM_ID = "MEMORY";

interface Seat {
  peer: MemoryRoomPeer;
  /** The seat's row in a roster. */
  row: RoomPlayer;
  roster(): RoomPlayer[];
  admit(player: RoomPlayer): void;
  followHost(hostId: string): void;
  sendRoster(): void;
}

/**
 * A room on the in-memory hub that follows the relay's rules: the host admits players and sends the
 * roster, everyone else learns of leaves, kicks, ready flags and host changes from the same events the
 * real backends carry. It exists so the room lifecycle can be tested without a network, and as the
 * reference a new backend is compared with.
 */
export function createMemoryRoom(hub: MemoryHub): MemoryRoom {
  let host: Seat | null = null;
  let seatCount = 0;
  let settings: Record<string, unknown> = { seed: 0 };

  function open(me: Seat, rules: Record<string, unknown>): void {
    me.followHost(me.peer.id);
    me.admit(me.row);
    host = me;
    settings = rules;
  }

  function admit(me: Seat, request: { passwordChecked: boolean }): JoinRoomResult {
    if (!host) return { ok: false, reason: "not-found" };
    const pwdH = typeof settings.pwdH === "string" ? settings.pwdH : "";
    if (pwdH && !request.passwordChecked) return { ok: false, reason: "password", pwdH };
    me.followHost(host.peer.id);
    host.admit(me.row);
    host.sendRoster();
    return {
      ok: true,
      roomId: MEMORY_ROOM_ID,
      hostId: host.peer.id,
      isHost: false,
      seed: typeof settings.seed === "number" ? settings.seed : 0,
      settings,
    };
  }

  function seat(id: string, name: string, role: string): Seat {
    const transport = hub.join(id);
    const row: RoomPlayer = {
      id,
      username: name.toUpperCase(),
      state: { role, joined: ++seatCount },
    };
    let roster: RoomPlayer[] = [];
    let hostId: string | null = null;
    let closed = false;
    let removed = false;

    const backend: RoomBackend = {
      kind: "memory",
      transport,
      async create(request) {
        open(self, request.settings);
        return { ok: true, roomId: MEMORY_ROOM_ID, hostId: id };
      },
      async join(request) {
        return admit(self, request);
      },
      async leave(request) {
        if (!request.roomId) return;
        if (request.announce)
          transport.send("left", { sender: request.myId, name: request.myName });
        if (request.isHost) {
          const next = nextHostCandidate(request.players, request.myId);
          if (next) transport.send("host-xfer", { newHost: next.id, from: request.myId });
          else transport.send("closed", {});
        }
        transport.close();
      },
      drop() {
        transport.close();
      },
      setHost() {},
      saveMyState() {},
      kick() {},
    };

    const self: Seat = {
      row,
      roster: () => roster,
      admit: (player) => roster.push(player),
      followHost: (next) => {
        hostId = next;
      },
      sendRoster: () => transport.send("roster", { players: roster }),
      peer: {
        id,
        backend,
        roster: () => roster.map((p) => ({ ...p, state: p.state ? { ...p.state } : p.state })),
        hostId: () => hostId,
        isHost: () => hostId === id,
        closed: () => closed,
        removed: () => removed,
        setReady(ready) {
          const me = roster.find((p) => p.id === id);
          if (me) me.state = { ...me.state, ready };
          transport.send("ready", { sender: id, ready });
        },
        kick(targetId) {
          if (hostId !== id || targetId === id) return;
          transport.send("kick", { target: targetId });
          roster = roster.filter((p) => p.id !== targetId);
          self.sendRoster();
        },
        leave: (announce = true) =>
          backend.leave({
            roomId: MEMORY_ROOM_ID,
            myId: id,
            myName: name,
            isHost: hostId === id,
            announce,
            players: roster,
          }),
      },
    };

    transport.onMessage((event, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      switch (event) {
        case "roster":
          roster = (p.players as RoomPlayer[]) ?? [];
          break;
        case "left":
          roster = roster.filter((x) => x.id !== p.sender);
          break;
        case "ready": {
          const who = roster.find((x) => x.id === p.sender);
          if (who) who.state = { ...who.state, ready: !!p.ready };
          break;
        }
        case "kick":
          roster = roster.filter((x) => x.id !== p.target);
          if (p.target === id) {
            removed = true;
            backend.drop({ roomId: MEMORY_ROOM_ID, myId: id });
          }
          break;
        case "host-xfer":
          hostId = p.newHost as string;
          if (hostId === id) host = self;
          break;
        case "closed":
          closed = true;
          break;
      }
    });

    return self;
  }

  return {
    peer(peerId, name, role = "player") {
      return seat(peerId, name, role).peer;
    },
    create(peerId, name, rules = { seed: 0 }) {
      const me = seat(peerId, name, "player");
      open(me, rules);
      return me.peer;
    },
    join(peerId, name, role = "player") {
      if (!host) throw new Error("no room to join");
      const me = seat(peerId, name, role);
      admit(me, { passwordChecked: true });
      return me.peer;
    },
  };
}
