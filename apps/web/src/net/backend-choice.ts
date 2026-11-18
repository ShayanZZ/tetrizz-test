import {
  backendOrder,
  isOnlineBackend,
  type BackendName,
  type NetworkConfig,
  type OnlineBackend,
} from "../core/network-config";

/** The room backend each configured backend runs on. */
const ROOM_KIND: Record<BackendName, "server" | "supabase" | "relay"> = {
  server: "server",
  supabase: "supabase",
  mqtt: "relay",
};

export type RoomKind = "server" | "supabase" | "relay";

/** The backends that can be used now, in the order they are tried for the player's pick. */
export function runnableBackends(
  cfg: NetworkConfig,
  choice: OnlineBackend = "auto",
): BackendName[] {
  return backendOrder(cfg, choice);
}

/** The room backends to try, first to last, for creating or joining a room. */
export function roomBackendKinds(cfg: NetworkConfig, choice: OnlineBackend = "auto"): RoomKind[] {
  return runnableBackends(cfg, choice).map((name) => ROOM_KIND[name]);
}

/** What the picker offers: `auto` and each backend that can be used. Empty when there is nothing to pick. */
export function backendChoices(cfg: NetworkConfig): OnlineBackend[] {
  const runnable = runnableBackends(cfg);
  return runnable.length < 2 ? [] : ["auto", ...runnable];
}

/** The next pick when the toggle is pressed, wrapping around. */
export function nextBackendChoice(cfg: NetworkConfig, current: OnlineBackend): OnlineBackend {
  const choices = backendChoices(cfg);
  if (!choices.length) return "auto";
  const at = choices.indexOf(current);
  return choices[(at + 1) % choices.length] ?? "auto";
}

/** A stored or imported value as a pick; anything unknown means `auto`. */
export function parseBackendChoice(value: unknown): OnlineBackend {
  return isOnlineBackend(value) ? value : "auto";
}

/** A pick that is not offered right now (its backend is not configured) counts as `auto`. */
export function effectiveBackendChoice(cfg: NetworkConfig, choice: OnlineBackend): OnlineBackend {
  return backendChoices(cfg).includes(choice) ? choice : "auto";
}
