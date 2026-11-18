import { describe, expect, it } from "vitest";
import {
  createMemoryHub,
  createMessageBus,
  eventsFor,
  NET_EVENTS,
  RELAY_EVENTS,
  SUPABASE_EVENTS,
  type Transport,
} from "@tetrizz/protocol";

type Heard = [string, unknown];

function listen(t: Transport): Heard[] {
  const heard: Heard[] = [];
  t.onMessage((event, payload) => heard.push([event, payload]));
  return heard;
}

describe("message bus", () => {
  it("hands every message to every listener in the order they joined", () => {
    const bus = createMessageBus();
    const order: string[] = [];
    bus.subscribe((e) => order.push("a:" + e));
    bus.subscribe((e) => order.push("b:" + e));
    bus.emit("ping", null);
    expect(order).toEqual(["a:ping", "b:ping"]);
  });

  it("stops delivering to a listener that unsubscribed or after clear", () => {
    const bus = createMessageBus();
    const heard: string[] = [];
    const stop = bus.subscribe((e) => heard.push(e));
    bus.emit("one", 1);
    stop();
    bus.emit("two", 2);
    bus.subscribe((e) => heard.push(e));
    bus.clear();
    bus.emit("three", 3);
    expect(heard).toEqual(["one"]);
  });

  it("lets a listener's error reach the code that delivered the message", () => {
    const bus = createMessageBus();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    expect(() => bus.emit("x", 1)).toThrow("boom");
  });
});

describe("memory hub", () => {
  it("delivers to every other peer and never to the sender", () => {
    const hub = createMemoryHub();
    const [a, b, c] = ["a", "b", "c"].map((id) => hub.join(id));
    const [heardA, heardB, heardC] = [listen(a), listen(b), listen(c)];
    a.send("attack", { amount: 2 });
    expect(heardA).toEqual([]);
    expect(heardB).toEqual([["attack", { amount: 2 }]]);
    expect(heardC).toEqual([["attack", { amount: 2 }]]);
  });

  it("keeps order when a listener answers while a delivery is running", () => {
    const hub = createMemoryHub();
    const [a, b, c] = ["a", "b", "c"].map((id) => hub.join(id));
    const heardC = listen(c);
    b.onMessage((event) => {
      if (event === "a1") b.send("b1", null);
    });
    a.onMessage((event) => {
      if (event === "b1") a.send("a2", null);
    });
    a.send("a1", null);
    expect(heardC.map(([e]) => e)).toEqual(["a1", "b1", "a2"]);
  });

  it("copies payloads the way a wire does", () => {
    const hub = createMemoryHub();
    const [a, b, c] = ["a", "b", "c"].map((id) => hub.join(id));
    const payload = { board: [[1, 2]], gone: undefined, fn: () => 1 };
    const heardB = listen(b);
    const heardC = listen(c);
    a.send("state", payload);
    payload.board[0][0] = 99;
    const [, got] = heardB[0] as [string, { board: number[][]; gone?: unknown; fn?: unknown }];
    expect(got).toEqual({ board: [[1, 2]] });
    expect("gone" in got || "fn" in got).toBe(false);
    (got.board[0] as number[])[1] = 7;
    expect(heardC[0][1]).toEqual({ board: [[1, 2]] });
  });

  it("passes a missing payload through and drops one that cannot be sent", () => {
    const hub = createMemoryHub();
    const [a, b] = ["a", "b"].map((id) => hub.join(id));
    const heard = listen(b);
    a.send("match-over", undefined);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => a.send("state", circular)).not.toThrow();
    a.send("big", 10n);
    expect(heard).toEqual([["match-over", undefined]]);
  });

  it("stops sending and hearing once a peer closes, and lets the id be used again", () => {
    const hub = createMemoryHub();
    const [a, b] = ["a", "b"].map((id) => hub.join(id));
    const heardB = listen(b);
    expect(hub.peerIds()).toEqual(["a", "b"]);
    expect(() => hub.join("a")).toThrow();
    a.close();
    a.close();
    expect(a.isOpen()).toBe(false);
    a.send("late", 1);
    expect(heardB).toEqual([]);
    expect(hub.peerIds()).toEqual(["b"]);
    const again = hub.join("a");
    const heardAgain = listen(again);
    b.send("hello", 1);
    expect(heardAgain).toEqual([["hello", 1]]);
  });

  it("hands nothing to a peer that closes while a message is queued for it", () => {
    const hub = createMemoryHub();
    const [a, b, c] = ["a", "b", "c"].map((id) => hub.join(id));
    const heardC = listen(c);
    b.onMessage(() => c.close());
    a.send("x", 1);
    expect(heardC).toEqual([]);
  });
});

describe("events per transport", () => {
  it("only names events the protocol knows, each once", () => {
    for (const list of [SUPABASE_EVENTS, RELAY_EVENTS]) {
      expect(new Set(list).size).toBe(list.length);
      for (const event of list) expect(NET_EVENTS).toContain(event);
    }
    for (const event of NET_EVENTS) {
      expect([...SUPABASE_EVENTS, ...RELAY_EVENTS]).toContain(event);
    }
  });

  it("keeps the differences between the backends visible", () => {
    const onlyRelay = RELAY_EVENTS.filter(
      (e) => !(SUPABASE_EVENTS as readonly string[]).includes(e),
    );
    const onlySupabase = SUPABASE_EVENTS.filter(
      (e) => !(RELAY_EVENTS as readonly string[]).includes(e),
    );
    expect([...onlyRelay].sort()).toEqual(["closed", "host-resume", "roster", "settings"]);
    expect(onlySupabase).toEqual(["lobby-ok"]);
  });

  it("maps a transport kind to its event list", () => {
    expect(eventsFor("supabase")).toBe(SUPABASE_EVENTS);
    for (const kind of ["lan", "relay", "memory"] as const)
      expect(eventsFor(kind)).toBe(RELAY_EVENTS);
  });
});
