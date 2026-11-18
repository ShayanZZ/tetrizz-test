import type { RoomBackend, Transport } from "@tetrizz/protocol";
import type { ChannelLike } from "../transports/lan-transport";

/** Wiring for the LAN room; the connections live in `lan.ts`. */
export interface LanRoomDeps {
  transport: Transport;
  /** A guest's channel to the host (`lanDC`). */
  uplink(): ChannelLike | null | undefined;
  debug(scope: string, error: unknown): void;
}

export function createLanRoom(deps: LanRoomDeps): RoomBackend {
  return {
    kind: "lan",
    transport: deps.transport,
    // A LAN room is made by hand in the LAN panel (QR codes), so the lobby never asks for one here.
    async create() {
      return { ok: false, reason: "manual" };
    },
    async join() {
      return { ok: false, reason: "manual" };
    },
    leave(request) {
      const uplink = deps.uplink();
      if (request.announce && uplink && uplink.readyState === "open") {
        try {
          uplink.send(JSON.stringify({ t: "bye", from: request.myId }));
        } catch (error) {
          deps.debug("net/backends/lan-room.leave", error);
        }
      }
      deps.transport.close();
    },
    drop() {
      deps.transport.close();
    },
    setHost() {},
    saveMyState() {},
    // Over a LAN the guest leaves when it hears `kick`; the host holds no seat table to edit.
    kick() {},
  };
}
