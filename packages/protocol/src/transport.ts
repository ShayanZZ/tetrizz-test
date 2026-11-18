/**
 * What every network backend offers the game: send an event to the room and hear events from it.
 * Room creation, joining and presence are not part of this interface yet; each backend still owns
 * them. Nothing here touches the DOM, the network or any other package.
 */
import type { NetEventName } from "./index";

export type TransportKind = "lan" | "relay" | "supabase" | "server" | "memory";

export type NetMessageHandler = (event: string, payload: unknown) => void;

export interface Transport {
  readonly kind: TransportKind;
  /** True while a message sent now has a chance to reach someone. */
  isOpen(): boolean;
  /** Sends to everyone else in the room. A send that cannot be made is dropped, never thrown. */
  send(event: string, payload: unknown): void;
  /** Hears every event that arrives from the room. Returns the function that stops listening. */
  onMessage(handler: NetMessageHandler): () => void;
  /** Stops sending and hearing. Safe to call twice. */
  close(): void;
}

/** The half of a backend that its connection code calls when something arrives. */
export interface TransportAdapter extends Transport {
  receive(event: string, payload: unknown): void;
}

/**
 * Events the Supabase room channel listens for. Room membership, readiness and settings travel
 * through database rows there, so `roster`, `settings`, `host-resume` and `closed` are never
 * broadcast on this transport.
 */
export const SUPABASE_EVENTS = [
  "attack",
  "state",
  "gameover",
  "left",
  "kick",
  "start",
  "progress",
  "host-xfer",
  "ping",
  "pong",
  "hb",
  "rejoin",
  "lobby-ok",
  "unleft",
  "rejoin-req",
  "game-active",
  "ready",
  "ready-flags",
  "match-over",
] as const satisfies readonly NetEventName[];

/** Events handled when they arrive over the MQTT relay or a LAN data channel. */
export const RELAY_EVENTS = [
  "attack",
  "state",
  "gameover",
  "left",
  "kick",
  "unleft",
  "start",
  "progress",
  "roster",
  "settings",
  "host-xfer",
  "host-resume",
  "ping",
  "pong",
  "hb",
  "rejoin",
  "ready",
  "ready-flags",
  "rejoin-req",
  "game-active",
  "match-over",
  "closed",
] as const satisfies readonly NetEventName[];

/** The events a transport of this kind delivers; the in-memory transport behaves like the relay. */
export function eventsFor(kind: TransportKind): readonly NetEventName[] {
  return kind === "supabase" ? SUPABASE_EVENTS : RELAY_EVENTS;
}

export interface MessageBus {
  emit: NetMessageHandler;
  subscribe(handler: NetMessageHandler): () => void;
  clear(): void;
}

/**
 * The listener list every adapter keeps. A handler that throws is not caught here: the error
 * reaches the connection code that delivered the message, as it did before this interface.
 */
export function createMessageBus(): MessageBus {
  let handlers: NetMessageHandler[] = [];
  return {
    emit(event, payload) {
      for (const handler of handlers.slice()) handler(event, payload);
    },
    subscribe(handler) {
      handlers.push(handler);
      return () => {
        handlers = handlers.filter((h) => h !== handler);
      };
    },
    clear() {
      handlers = [];
    },
  };
}

/** Messages cross a real network as text, so the in-memory hub copies payloads the same way. */
function copyPayload(payload: unknown): unknown {
  return payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
}

export interface MemoryHub {
  /** Seats a peer. A peer id that is still open cannot be seated twice. */
  join(peerId: string): Transport;
  /** Ids of the peers that are open now. */
  peerIds(): string[];
}

/**
 * A room that lives in one JavaScript context: everything a peer sends reaches every other open
 * peer, in order, and never the sender. A send made while a delivery is running is queued behind
 * it, so handlers that answer at once cannot reorder messages.
 */
export function createMemoryHub(): MemoryHub {
  const peers = new Map<string, { bus: MessageBus; open: boolean }>();
  const queue: Array<() => void> = [];
  let draining = false;

  function drain(): void {
    if (draining) return;
    draining = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) job();
    } finally {
      draining = false;
    }
  }

  return {
    join(peerId) {
      if (peers.get(peerId)?.open) throw new Error("peer already in the room: " + peerId);
      const me = { bus: createMessageBus(), open: true };
      peers.set(peerId, me);
      return {
        kind: "memory",
        isOpen: () => me.open,
        send(event, payload) {
          if (!me.open) return;
          let wire: unknown;
          try {
            wire = copyPayload(payload);
          } catch {
            return;
          }
          for (const [id, peer] of peers) {
            if (id === peerId || !peer.open) continue;
            queue.push(() => {
              if (peer.open) peer.bus.emit(event, copyPayload(wire));
            });
          }
          drain();
        },
        onMessage: (handler) => me.bus.subscribe(handler),
        close() {
          me.open = false;
          me.bus.clear();
        },
      };
    },
    peerIds: () => [...peers].filter(([, p]) => p.open).map(([id]) => id),
  };
}
