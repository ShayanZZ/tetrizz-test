import type {
  CreateRoomResult,
  JoinRoomResult,
  RoomBackend,
  ServerRefusal,
  Transport,
} from "@tetrizz/protocol";
import type { ServerSocket } from "../server-socket";

/** Wiring for the own-server room; the socket and transport are built where the app starts. */
export interface ServerRoomDeps {
  socket: ServerSocket;
  transport: Transport;
  later(task: () => void, ms: number): void;
}

/** How long the goodbye gets to leave before the connection is closed. */
export const SERVER_LEAVE_DELAY_MS = 150;

function joinRefusal(reason: ServerRefusal): JoinRoomResult {
  switch (reason) {
    case "not-found":
      return { ok: false, reason: "not-found" };
    case "password":
      return { ok: false, reason: "password" };
    case "wrong-password":
      return { ok: false, reason: "password", wrongPassword: true };
    case "version":
      return { ok: false, reason: "version" };
    default:
      return { ok: false, reason: "failed" };
  }
}

/**
 * A room kept by TetriZZ's own server. The server holds the roster, the host and the password, so
 * entering a room is one request and a refusal is the server's answer, not a guess.
 */
export function createServerRoom(deps: ServerRoomDeps): RoomBackend {
  const { socket } = deps;
  return {
    kind: "server",
    transport: deps.transport,
    async create(request): Promise<CreateRoomResult> {
      const connected = await socket.connect({ id: request.myId, name: request.myName });
      if (connected !== "ok") return { ok: false, reason: "failed" };
      const answer = await socket.request({
        t: "create",
        room: request.roomId,
        name: request.myName,
        settings: request.settings,
        password: request.password ?? "",
      });
      if (answer.t === "created") return { ok: true, roomId: answer.room, hostId: answer.host };
      return { ok: false, reason: "failed" };
    },
    async join(request): Promise<JoinRoomResult> {
      const connected = await socket.connect({ id: request.myId, name: request.myName });
      if (connected === "version") return { ok: false, reason: "version" };
      if (connected !== "ok") return { ok: false, reason: "unreachable" };
      const answer = await socket.request({
        t: "join",
        room: request.roomId,
        name: request.myName,
        password: request.password,
      });
      if (answer.t === "joined") {
        return {
          ok: true,
          roomId: answer.room,
          hostId: answer.host,
          isHost: answer.isHost,
          seed: answer.seed,
          settings: answer.settings,
        };
      }
      if (answer.t === "refused") return joinRefusal(answer.reason);
      return { ok: false, reason: "unreachable" };
    },
    leave(request) {
      if (!request.roomId) return;
      if (request.announce) {
        deps.transport.send("left", { sender: request.myId, name: request.myName });
      }
      socket.send({ t: "leave" });
      deps.later(() => deps.transport.close(), SERVER_LEAVE_DELAY_MS);
    },
    drop() {
      deps.transport.close();
    },
    setHost(request) {
      socket.send({ t: "host", newHost: request.newHost });
    },
    setPassword(request) {
      socket.send({ t: "settings", settings: request.settings, password: request.password });
    },
    saveMyState(request) {
      const state = request.state;
      socket.send({
        t: "state",
        state: state && typeof state === "object" ? (state as Record<string, unknown>) : {},
      });
    },
    kick(request) {
      socket.send({ t: "kick", target: request.targetId });
    },
  };
}
