import { createMessageBus, type TransportAdapter } from "@tetrizz/protocol";
import type { ServerSocket } from "../server-socket";

export interface ServerTransportDeps {
  socket: Pick<ServerSocket, "send" | "isOpen" | "onMessage" | "close">;
  /** This player's id, for the `kick` event a `kicked` message becomes. */
  myId(): string;
}

/**
 * Game events over the own server's socket. The server relays an event to everyone else in the
 * room, and its own announcements reach the game as the events the relay's host would have sent
 * (`roster`, `host-xfer`, `kick`, `closed`). The host's `settings` go as their own message so that the
 * server keeps them for players who arrive later.
 */
export function createServerTransport(deps: ServerTransportDeps): TransportAdapter {
  const bus = createMessageBus();
  // One listener for the life of the page: the socket is reused for every room, so leaving a room
  // closes the connection but must not stop the transport from hearing the next one.
  deps.socket.onMessage((message) => {
    switch (message.t) {
      case "ev":
        bus.emit(message.event, message.payload);
        break;
      case "roster":
        bus.emit("roster", { players: message.players, host: message.host });
        break;
      case "host":
        bus.emit("host-xfer", { newHost: message.host, from: "" });
        break;
      case "kicked":
        bus.emit("kick", { target: deps.myId() });
        break;
      case "closed":
        bus.emit("closed", {});
        break;
      default:
    }
  });
  return {
    kind: "server",
    isOpen: () => deps.socket.isOpen(),
    send(event, payload) {
      if (event === "settings" && payload && typeof payload === "object") {
        deps.socket.send({ t: "settings", settings: payload as Record<string, unknown> });
      } else {
        deps.socket.send({ t: "ev", event, payload });
      }
    },
    onMessage: (handler) => bus.subscribe(handler),
    receive: (event, payload) => bus.emit(event, payload),
    close() {
      deps.socket.close();
    },
  };
}
