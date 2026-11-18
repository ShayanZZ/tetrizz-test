import { describe, expect, it, vi } from "vitest";
import { SUPABASE_EVENTS } from "@tetrizz/protocol";
import { dispatchTo, type HandlerTable } from "../../apps/web/src/net/dispatch";
import {
  createLanTransport,
  type ChannelLike,
} from "../../apps/web/src/net/transports/lan-transport";
import { createRelayTransport } from "../../apps/web/src/net/transports/relay-transport";
import {
  createSupabaseTransport,
  type SupabaseChannelLike,
} from "../../apps/web/src/net/transports/supabase-transport";

function channel(readyState = "open", fail = false): ChannelLike & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState,
    sent,
    send(data) {
      if (fail) throw new Error("send failed");
      sent.push(data);
    },
  };
}

describe("LAN transport", () => {
  function make(peers: ChannelLike[], uplink: ChannelLike | null) {
    const warn = vi.fn();
    const close = vi.fn();
    const t = createLanTransport({
      peers: () => new Set(peers),
      uplink: () => uplink,
      warn,
      close,
    });
    return { t, warn, close };
  }

  it("writes one JSON line to every open channel and skips the others", () => {
    const [open1, open2, closing] = [channel(), channel(), channel("closing")];
    const up = channel();
    const { t } = make([open1, open2, closing], up);
    t.send("attack", { amount: 3 });
    const line = JSON.stringify({ event: "attack", payload: { amount: 3 } });
    expect(open1.sent).toEqual([line]);
    expect(open2.sent).toEqual([line]);
    expect(up.sent).toEqual([line]);
    expect(closing.sent).toEqual([]);
  });

  it("keeps sending to the others when one channel fails, and says so", () => {
    const [bad, good] = [channel("open", true), channel()];
    const { t, warn } = make([bad, good], null);
    expect(() => t.send("state", 1)).not.toThrow();
    expect(good.sent).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is open while any channel is open", () => {
    expect(make([], null).t.isOpen()).toBe(false);
    expect(make([channel("closed")], channel("connecting")).t.isOpen()).toBe(false);
    expect(make([channel()], null).t.isOpen()).toBe(true);
    expect(make([], channel()).t.isOpen()).toBe(true);
  });

  it("sends nothing when there are no channels", () => {
    const { t } = make([], null);
    expect(() => t.send("hb", {})).not.toThrow();
  });

  it("delivers what it receives, until the listener stops", () => {
    const { t } = make([], null);
    const heard: unknown[] = [];
    const stop = t.onMessage((e, p) => heard.push([e, p]));
    t.receive("kick", { id: "x" });
    stop();
    t.receive("kick", { id: "y" });
    expect(heard).toEqual([["kick", { id: "x" }]]);
    expect(t.kind).toBe("lan");
  });

  it("closes through its owner", () => {
    const { t, close } = make([], null);
    t.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("relay transport", () => {
  it("sends on the direct connections first and then on the broker topic", () => {
    const calls: string[] = [];
    const t = createRelayTransport({
      sendDirect: (e) => calls.push("direct:" + e),
      sendBroker: (e) => calls.push("broker:" + e),
      isOpen: () => true,
      close: () => calls.push("close"),
    });
    t.send("ready", { ready: true });
    t.close();
    expect(calls).toEqual(["direct:ready", "broker:ready", "close"]);
    expect(t.kind).toBe("relay");
    expect(t.isOpen()).toBe(true);
  });

  it("delivers what it receives", () => {
    const t = createRelayTransport({
      sendDirect: () => {},
      sendBroker: () => {},
      isOpen: () => false,
      close: () => {},
    });
    const heard: unknown[] = [];
    t.onMessage((e, p) => heard.push([e, p]));
    t.receive("roster", { players: [] });
    expect(heard).toEqual([["roster", { players: [] }]]);
  });
});

type FakeSupabaseChannel = SupabaseChannelLike & {
  sent: Array<{ type: string; event: string; payload: unknown }>;
  listeners: Map<string, (m: { payload?: unknown } | null) => void>;
  throwOnSend: boolean;
};

function supabaseChannel(state: string): FakeSupabaseChannel {
  const ch: FakeSupabaseChannel = {
    state,
    sent: [],
    listeners: new Map(),
    throwOnSend: false,
    send(message) {
      if (ch.throwOnSend) throw new Error("send failed");
      ch.sent.push(message);
    },
    on(_type, filter, callback) {
      ch.listeners.set(filter.event, callback);
      return ch;
    },
  };
  return ch;
}

describe("Supabase transport", () => {
  function make(ch: FakeSupabaseChannel | null) {
    const debug = vi.fn();
    const detach = vi.fn();
    const remove = vi.fn();
    return {
      t: createSupabaseTransport({ channel: () => ch, debug, detach, remove }),
      debug,
      detach,
      remove,
    };
  }

  it("broadcasts on a joined channel", () => {
    const ch = supabaseChannel("joined");
    const { t } = make(ch);
    t.send("hb", { n: 1 });
    expect(ch.sent).toEqual([{ type: "broadcast", event: "hb", payload: { n: 1 } }]);
    expect(t.isOpen()).toBe(true);
  });

  it("drops keep-alive traffic but still tries other events while the channel is not joined", () => {
    const ch = supabaseChannel("joining");
    const { t } = make(ch);
    for (const event of ["hb", "ping", "pong"]) t.send(event, {});
    expect(ch.sent).toEqual([]);
    t.send("start", { seed: 1 });
    expect(ch.sent.map((m) => m.event)).toEqual(["start"]);
    expect(t.isOpen()).toBe(false);
  });

  it("does not throw when the channel does, and logs it", () => {
    const ch = supabaseChannel("joined");
    ch.throwOnSend = true;
    const { t, debug } = make(ch);
    expect(() => t.send("attack", {})).not.toThrow();
    expect(debug).toHaveBeenCalled();
    const pending = supabaseChannel("closed");
    pending.throwOnSend = true;
    const second = make(pending);
    expect(() => second.t.send("attack", {})).not.toThrow();
    expect(second.debug).toHaveBeenCalledTimes(1);
  });

  it("sends nothing without a channel", () => {
    const { t } = make(null);
    expect(() => t.send("attack", {})).not.toThrow();
    expect(t.isOpen()).toBe(false);
  });

  it("listens for exactly the room events, before the channel is subscribed", () => {
    const ch = supabaseChannel("joined");
    const { t } = make(ch);
    expect(t.attach(ch)).toBe(ch);
    expect([...ch.listeners.keys()]).toEqual([...SUPABASE_EVENTS]);
  });

  it("delivers a broadcast's payload, and none when the message has none", () => {
    const ch = supabaseChannel("joined");
    const { t } = make(ch);
    t.attach(ch);
    const heard: unknown[] = [];
    t.onMessage((e, p) => heard.push([e, p]));
    ch.listeners.get("gameover")!({ payload: { sender: "p1", rnd: 2 } });
    ch.listeners.get("match-over")!(null);
    expect(heard).toEqual([
      ["gameover", { sender: "p1", rnd: 2 }],
      ["match-over", undefined],
    ]);
  });
});

describe("dispatching incoming events", () => {
  it("runs the handler of a known event with its payload", () => {
    const seen: unknown[] = [];
    const table: HandlerTable = { attack: (p) => seen.push(p) };
    expect(dispatchTo(table, "attack", { amount: 1 })).toBe(true);
    expect(seen).toEqual([{ amount: 1 }]);
  });

  it("ignores events with no handler and names that are not the table's own", () => {
    const table: HandlerTable = { attack: () => {} };
    for (const event of [
      "state",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      ["attack"],
      5,
      null,
      undefined,
      {},
    ]) {
      expect(dispatchTo(table, event, {})).toBe(false);
    }
  });

  it("lets a handler's error out to the caller", () => {
    const table: HandlerTable = {
      kick: () => {
        throw new Error("boom");
      },
    };
    expect(() => dispatchTo(table, "kick", {})).toThrow("boom");
  });
});
