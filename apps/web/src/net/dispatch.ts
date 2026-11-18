import type { NetEventName } from "@tetrizz/protocol";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each handler checks its own payload
export type NetHandler = (payload: any) => void;

/** One handler per event name; an event with no entry is ignored. */
export type HandlerTable = Partial<Record<NetEventName, NetHandler>>;

/**
 * Hands an incoming event to its handler. The name comes from the network, so only the table's
 * own entries count: a name such as `constructor` or a non-string value matches nothing.
 */
export function dispatchTo(table: HandlerTable, event: unknown, payload: unknown): boolean {
  if (typeof event !== "string" || !Object.prototype.hasOwnProperty.call(table, event)) {
    return false;
  }
  const handler = table[event as NetEventName];
  if (!handler) return false;
  handler(payload);
  return true;
}
