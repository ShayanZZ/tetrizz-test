import {
  nextHostCandidate,
  type JoinRoomResult,
  type RoomBackend,
  type Transport,
} from "@tetrizz/protocol";

/** Wiring for the relay room; the functions live in `relay.ts` and the session state. */
export interface RelayRoomDeps {
  transport: Transport;
  /** Starts hosting `roomId` on the broker; the connection is made in the background. */
  startHost(roomId: string): void;
  /** Connects as a guest and settles when the host accepts or refuses, or nobody answers. */
  startJoin(roomId: string, password: string): Promise<JoinRoomResult>;
  /** Publishes a control message on the broker topic (`mqPub`). */
  publishBroker(message: Record<string, unknown>): void;
  /** Takes a player off the roster the game holds. */
  removeFromRoster(playerId: string): void;
  /** Marks a player as gone so a late connection from them is refused. */
  markDead(playerId: string): void;
  /** Sends the host's roster to everyone. */
  pushRoster(): void;
  /** Closes the connection to one player. */
  destroyConnection(playerId: string): void;
  later(task: () => void, ms: number): void;
}

/** How long the goodbye gets to leave before the connection is torn down. */
export const RELAY_LEAVE_DELAY_MS = 150;

export function createRelayRoom(deps: RelayRoomDeps): RoomBackend {
  return {
    kind: "relay",
    transport: deps.transport,
    async create(request) {
      deps.startHost(request.roomId);
      return { ok: true, roomId: request.roomId, hostId: request.myId };
    },
    join(request) {
      return deps.startJoin(request.roomId, request.password);
    },
    leave(request) {
      if (!request.roomId) return;
      if (request.announce) {
        deps.transport.send("left", { sender: request.myId, name: request.myName });
      }
      if (request.isHost) {
        const next = nextHostCandidate(request.players, request.myId);
        if (next) {
          deps.publishBroker({ t: "host-transfer", newHost: next.id, from: request.myId });
        } else {
          deps.transport.send("closed", {});
        }
      }
      deps.later(() => deps.transport.close(), RELAY_LEAVE_DELAY_MS);
    },
    drop() {
      deps.transport.close();
    },
    setHost() {},
    saveMyState() {},
    kick(request) {
      deps.removeFromRoster(request.targetId);
      deps.markDead(request.targetId);
      deps.pushRoster();
      deps.destroyConnection(request.targetId);
    },
  };
}
