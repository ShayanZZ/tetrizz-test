import type { TransportAdapter, TransportKind } from "@tetrizz/protocol";
import { log } from "../core/logger";
import { APP_VERSION } from "../core/version";
import { playerKey } from "./identity";
import { lanState, lanTeardownAll } from "./lan";
import { netConfig } from "./net-config";
import { dispatchNetMessage } from "./net-handlers";
import { onlineSessionState } from "./online-session";
import { MQ, mqSend, mqTeardown, relaySend, relayTeardown } from "./relay";
import { createLanTransport, type ChannelLike } from "./transports/lan-transport";
import {
  createServerSocket,
  serverSocketUrl,
  type ServerSocket,
  type SocketLike,
} from "./server-socket";
import { createRelayTransport } from "./transports/relay-transport";
import { createServerTransport } from "./transports/server-transport";
import { createSupabaseTransport, type SupabaseTransport } from "./transports/supabase-transport";

type Adapters = {
  lan: TransportAdapter;
  relay: TransportAdapter;
  supabase: SupabaseTransport;
  server: TransportAdapter;
};

/** The kinds of transport the app can run, one adapter each. */
export type AdapterKind = keyof Adapters;

let adapters: Adapters | null = null;
let socket: ServerSocket | null = null;

/** The page's one connection to the own server, built on first use; it opens only when a room is made or joined. */
export function serverSocket(): ServerSocket {
  socket ??= createServerSocket({
    url: () => serverSocketUrl(netConfig.current.server?.url ?? "/", location.origin),
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    later: (task, ms) => {
      const timer = setTimeout(task, ms);
      return () => clearTimeout(timer);
    },
    appVersion: APP_VERSION,
    key: playerKey,
    warn: (scope, error) => log.warn(scope, error),
  });
  return socket;
}

/** Built on first use, because creating them reads other modules. Each reports to the game's handlers. */
function getAdapters(): Adapters {
  if (adapters) return adapters;
  const lan = createLanTransport({
    peers: () => lanState.lanPeers as Set<ChannelLike>,
    uplink: () => lanState.lanDC as ChannelLike | null,
    warn: (message, error) => console.warn(message, error),
    close: lanTeardownAll,
  });
  const relay = createRelayTransport({
    sendDirect: relaySend,
    sendBroker: mqSend,
    isOpen: () => !!(MQ.client && MQ.connected && MQ.room),
    close: () => {
      relayTeardown();
      mqTeardown();
    },
  });
  const supabase = createSupabaseTransport({
    channel: () => onlineSessionState.onlineChannel,
    debug: (scope, error) => log.debug(scope, error),
    detach: () => {
      onlineSessionState.onlineChannel = null;
    },
    remove: (channel) => {
      onlineSessionState.sb?.removeChannel(channel);
    },
  });
  const server = createServerTransport({
    socket: serverSocket(),
    myId: () => String(onlineSessionState.myPlayerId ?? ""),
  });
  for (const adapter of [lan, relay, supabase, server]) {
    adapter.onMessage((event, payload) => dispatchNetMessage(adapter.kind, event, payload));
  }
  adapters = { lan, relay, supabase, server };
  return adapters;
}

/** The value `netMode` holds for each backend; the relay's is still called "p2p" in saved rooms. */
export type NetMode = "supabase" | "p2p" | "lan" | "server";

export function transportKindFor(mode: NetMode | string): TransportKind {
  if (mode === "lan") return "lan";
  if (mode === "p2p") return "relay";
  if (mode === "server") return "server";
  return "supabase";
}

/** The transport of the room the player is in (Supabase when no other mode is set). */
export function activeTransport(): TransportAdapter {
  const all = getAdapters();
  return all[transportKindFor(onlineSessionState.netMode) as AdapterKind];
}

/** The transport of one backend, whichever the player's room uses. */
export function transportOfKind(kind: AdapterKind): TransportAdapter {
  return getAdapters()[kind];
}

export function supabaseTransport(): SupabaseTransport {
  return getAdapters().supabase;
}

/** Sends a game event to everyone else in the room, over whichever backend the room uses. */
export function netSend(event: string, payload: unknown): void {
  activeTransport().send(event, payload);
}

/** Hands a message that arrived over a LAN channel or the relay to the game. */
export function receiveEnvelope(mode: "lan" | "p2p", envelope: unknown): void {
  if (!envelope || typeof envelope !== "object") return;
  const { event, payload } = envelope as { event?: unknown; payload?: unknown };
  getAdapters()[transportKindFor(mode) as "lan" | "relay"].receive(event as string, payload);
}
