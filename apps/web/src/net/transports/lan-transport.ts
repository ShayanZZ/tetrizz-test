import { createMessageBus, type TransportAdapter } from "@tetrizz/protocol";

/** The part of an RTCDataChannel the transport uses. */
export interface ChannelLike {
  readyState: string;
  send(data: string): void;
}

export interface LanDeps {
  /** The host's channels, one per guest. */
  peers(): Iterable<ChannelLike> | null | undefined;
  /** A guest's channel to the host. */
  uplink(): ChannelLike | null | undefined;
  warn(message: string, error: unknown): void;
  close(): void;
}

const isOpen = (channel: ChannelLike): boolean => channel.readyState === "open";

/** Sends one JSON line per event over every open data channel. */
export function createLanTransport(deps: LanDeps): TransportAdapter {
  const bus = createMessageBus();
  return {
    kind: "lan",
    isOpen() {
      for (const channel of deps.peers() ?? []) if (isOpen(channel)) return true;
      const uplink = deps.uplink();
      return !!uplink && isOpen(uplink);
    },
    send(event, payload) {
      const text = JSON.stringify({ event, payload });
      for (const channel of deps.peers() ?? []) {
        if (!isOpen(channel)) continue;
        try {
          channel.send(text);
        } catch (error) {
          deps.warn("[LAN] Failed to send to peer:", error);
        }
      }
      const uplink = deps.uplink();
      if (uplink && isOpen(uplink)) {
        try {
          uplink.send(text);
        } catch (error) {
          deps.warn("[LAN] Failed to send via lanDC:", error);
        }
      }
    },
    onMessage: (handler) => bus.subscribe(handler),
    receive: (event, payload) => bus.emit(event, payload),
    close: () => deps.close(),
  };
}
