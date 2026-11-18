import { createMessageBus, type TransportAdapter } from "@tetrizz/protocol";

export interface RelayDeps {
  /** Direct connections to the other players (the original peer-to-peer path). */
  sendDirect(event: string, payload: unknown): void;
  /** The shared MQTT topic. */
  sendBroker(event: string, payload: unknown): void;
  isOpen(): boolean;
  close(): void;
}

/** Sends every event on both paths, direct connections first, then the broker topic. */
export function createRelayTransport(deps: RelayDeps): TransportAdapter {
  const bus = createMessageBus();
  return {
    kind: "relay",
    isOpen: () => deps.isOpen(),
    send(event, payload) {
      deps.sendDirect(event, payload);
      deps.sendBroker(event, payload);
    },
    onMessage: (handler) => bus.subscribe(handler),
    receive: (event, payload) => bus.emit(event, payload),
    close: () => deps.close(),
  };
}
