import { createMessageBus, SUPABASE_EVENTS, type TransportAdapter } from "@tetrizz/protocol";

/** The part of a supabase-js realtime channel the transport uses. */
export interface SupabaseChannelLike {
  state?: string;
  send(message: { type: "broadcast"; event: string; payload: unknown }): unknown;
  on(
    type: "broadcast",
    filter: { event: string },
    callback: (message: { payload?: unknown } | null) => void,
  ): SupabaseChannelLike;
}

export interface SupabaseDeps {
  channel(): SupabaseChannelLike | null | undefined;
  debug(scope: string, error: unknown): void;
  /** Forgets the channel, so that nothing more is sent on it. */
  detach(): void;
  /** Removes the channel from the client. */
  remove(channel: SupabaseChannelLike): void;
}

/** How long a closed channel stays subscribed, so that a goodbye still on its way gets out. */
export const SUPABASE_CLOSE_DELAY_MS = 400;

export interface SupabaseTransport extends TransportAdapter {
  /** Adds the broadcast listeners to a channel. Call it before the channel is subscribed. */
  attach<T extends SupabaseChannelLike>(channel: T): T;
}

/** Keep-alive traffic is not worth queuing: when the channel is not joined it is dropped. */
const DROPPED_WHILE_NOT_JOINED = new Set(["hb", "ping", "pong"]);

/** Broadcasts events on the room's realtime channel. */
export function createSupabaseTransport(deps: SupabaseDeps): SupabaseTransport {
  const bus = createMessageBus();
  return {
    kind: "supabase",
    isOpen: () => deps.channel()?.state === "joined",
    send(event, payload) {
      const channel = deps.channel();
      if (!channel) return;
      const message = { type: "broadcast" as const, event, payload };
      try {
        if (channel.state === "joined") {
          channel.send(message);
          return;
        }
        if (DROPPED_WHILE_NOT_JOINED.has(event)) return;
        try {
          channel.send(message);
        } catch (error) {
          deps.debug("net/transport.supabase.send", error);
        }
      } catch (error) {
        deps.debug("net/transport.supabase.send#2", error);
      }
    },
    attach(channel) {
      let chained: SupabaseChannelLike = channel;
      for (const event of SUPABASE_EVENTS) {
        chained = chained.on("broadcast", { event }, (message) =>
          bus.emit(event, message ? message.payload : undefined),
        );
      }
      return chained as typeof channel;
    },
    onMessage: (handler) => bus.subscribe(handler),
    receive: (event, payload) => bus.emit(event, payload),
    close() {
      const channel = deps.channel();
      deps.detach();
      if (!channel) return;
      setTimeout(() => {
        try {
          deps.remove(channel);
        } catch (error) {
          deps.debug("net/transport.supabase.close", error);
        }
      }, SUPABASE_CLOSE_DELAY_MS);
    },
  };
}
