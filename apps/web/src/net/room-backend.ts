import type { RoomBackend } from "@tetrizz/protocol";
import { log } from "../core/logger";
import { clock } from "../core/clock";
import { createLanRoom } from "./backends/lan-room";
import { createRelayRoom } from "./backends/relay-room";
import { createServerRoom } from "./backends/server-room";
import { createSupabaseRoom, type SupabaseClientLike } from "./backends/supabase-room";
import { lanState } from "./lan";
import { onlineSessionState } from "./online-session";
import {
  mqPub,
  relayDestroyConnFor,
  relayJoin,
  relayPushRoster,
  relayStartHost,
  MQ,
} from "./relay";
import { serverSocket, transportKindFor, transportOfKind, type AdapterKind } from "./transport";
import type { ChannelLike } from "./transports/lan-transport";

let backends: Record<AdapterKind, RoomBackend> | null = null;

/** Built on first use, for the same reason as the transports. */
function getBackends() {
  if (backends) return backends;
  backends = {
    lan: createLanRoom({
      transport: transportOfKind("lan"),
      uplink: () => lanState.lanDC as ChannelLike | null,
      debug: (scope, error) => log.debug(scope, error),
    }),
    relay: createRelayRoom({
      transport: transportOfKind("relay"),
      startHost: relayStartHost,
      startJoin: relayJoin,
      publishBroker: (message) => mqPub(message),
      removeFromRoster: (playerId) => {
        onlineSessionState.onlinePlayersList = onlineSessionState.onlinePlayersList.filter(
          (p: { id: string }) => p.id !== playerId,
        );
      },
      markDead: (playerId) => MQ.dead.add(playerId),
      pushRoster: relayPushRoster,
      destroyConnection: relayDestroyConnFor,
      later: (task, ms) => void setTimeout(task, ms),
    }),
    supabase: createSupabaseRoom({
      transport: transportOfKind("supabase"),
      client: () => onlineSessionState.sb as SupabaseClientLike | null,
      now: () => clock.wall(),
      isoNow: () => new Date().toISOString(),
      debug: (scope, error) => log.debug(scope, error),
      warn: (scope, error) => log.warn(scope, error),
    }),
    server: createServerRoom({
      socket: serverSocket(),
      transport: transportOfKind("server"),
      later: (task, ms) => void setTimeout(task, ms),
    }),
  };
  return backends;
}

/** The room backend of one kind, whatever the current mode (the lobby tries them in turn). */
export function backendOfKind(kind: AdapterKind): RoomBackend {
  return getBackends()[kind];
}

/** The room backend of the room the player is in (Supabase when no other mode is set). */
export function activeBackend(): RoomBackend {
  return getBackends()[transportKindFor(onlineSessionState.netMode) as AdapterKind];
}
