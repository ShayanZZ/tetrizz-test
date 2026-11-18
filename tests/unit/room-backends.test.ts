import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomPlayer, Transport } from "@tetrizz/protocol";
import { createLanRoom } from "../../apps/web/src/net/backends/lan-room";
import { createRelayRoom, RELAY_LEAVE_DELAY_MS } from "../../apps/web/src/net/backends/relay-room";
import {
  createSupabaseRoom,
  rowIsFresh,
  type SupabaseClientLike,
} from "../../apps/web/src/net/backends/supabase-room";
import {
  createSupabaseTransport,
  SUPABASE_CLOSE_DELAY_MS,
  type SupabaseChannelLike,
} from "../../apps/web/src/net/transports/supabase-transport";

/** A transport that records what it is asked to do. */
function fakeTransport() {
  const log: string[] = [];
  const sent: Array<[string, unknown]> = [];
  const transport: Transport = {
    kind: "relay",
    isOpen: () => true,
    send(event, payload) {
      log.push(`send ${event}`);
      sent.push([event, payload]);
    },
    onMessage: () => () => {},
    close: () => void log.push("close"),
  };
  return { transport, log, sent };
}

const seat = (id: string, joined: number, role = "player"): RoomPlayer => ({
  id,
  username: id.toUpperCase(),
  state: { role, joined },
});

describe("relay room", () => {
  function make() {
    const { transport, log, sent } = fakeTransport();
    const later: Array<{ task: () => void; ms: number }> = [];
    const room = createRelayRoom({
      transport,
      startHost: (id) => void log.push(`host ${id}`),
      startJoin: async (id, password) => {
        log.push(`join ${id} ${password}`);
        return { ok: false, reason: "not-found" };
      },
      publishBroker: (m) => void log.push(`broker ${JSON.stringify(m)}`),
      removeFromRoster: (id) => void log.push(`roster- ${id}`),
      markDead: (id) => void log.push(`dead ${id}`),
      pushRoster: () => void log.push("roster!"),
      destroyConnection: (id) => void log.push(`destroy ${id}`),
      later: (task, ms) => void later.push({ task, ms }),
    });
    return { room, log, sent, later };
  }
  const base = { roomId: "R", myId: "me", myName: "ME", announce: true };

  it("says goodbye, closes later, and hands the room on when the host leaves", () => {
    const { room, log, sent, later } = make();
    const players = [seat("me", 1), seat("spec", 2, "spec"), seat("next", 3)];
    expect(room.leave({ ...base, isHost: true, players })).toBeUndefined();
    expect(sent[0]).toEqual(["left", { sender: "me", name: "ME" }]);
    expect(log).toEqual(["send left", 'broker {"t":"host-transfer","newHost":"next","from":"me"}']);
    expect(later).toHaveLength(1);
    expect(later[0]?.ms).toBe(RELAY_LEAVE_DELAY_MS);
    later[0]?.task();
    expect(log.at(-1)).toBe("close");
  });

  it("closes the room when the host leaves and nobody can take over", () => {
    const { room, sent } = make();
    room.leave({ ...base, isHost: true, players: [seat("me", 1), seat("w", 2, "spec")] });
    expect(sent.map(([event]) => event)).toEqual(["left", "closed"]);
  });

  it("lets a guest leave without touching the broker", () => {
    const { room, log, later } = make();
    room.leave({ ...base, isHost: false, players: [seat("h", 1), seat("me", 2)] });
    expect(log).toEqual(["send left"]);
    expect(later).toHaveLength(1);
  });

  it("skips the goodbye when asked", () => {
    const { room, log } = make();
    room.leave({ ...base, announce: false, isHost: false, players: [] });
    expect(log).toEqual([]);
  });

  it("does nothing without a room, not even closing", () => {
    const { room, log, later } = make();
    room.leave({ ...base, roomId: null, isHost: true, players: [] });
    expect(log).toEqual([]);
    expect(later).toHaveLength(0);
  });

  it("drops at once and kicks in the order the lobby always did", () => {
    const { room, log } = make();
    room.drop({ roomId: "R", myId: "me" });
    expect(log).toEqual(["close"]);
    log.length = 0;
    room.kick({ roomId: "R", myId: "me", targetId: "x" });
    expect(log).toEqual(["roster- x", "dead x", "roster!", "destroy x"]);
  });

  it("has no database to update", () => {
    const { room, log } = make();
    room.setHost({ roomId: "R", myId: "me", newHost: "x" });
    room.saveMyState({ myId: "me", state: {} });
    expect(log).toEqual([]);
  });
});

describe("LAN room", () => {
  function make(uplink: { readyState: string; send(data: string): void } | null) {
    const { transport, log } = fakeTransport();
    const debug = vi.fn();
    return { room: createLanRoom({ transport, uplink: () => uplink, debug }), log, debug };
  }
  const request = { roomId: null, myId: "me", myName: "ME", isHost: false, players: [] };

  it("sends a bye on an open channel and closes", () => {
    const sent: string[] = [];
    const { room, log } = make({ readyState: "open", send: (d) => void sent.push(d) });
    expect(room.leave({ ...request, announce: true })).toBeUndefined();
    expect(sent).toEqual([JSON.stringify({ t: "bye", from: "me" })]);
    expect(log).toEqual(["close"]);
  });

  it("sends nothing on a channel that is not open, without being asked, or without a channel", () => {
    for (const [uplink, announce] of [
      [{ readyState: "closing", send: vi.fn() }, true],
      [{ readyState: "open", send: vi.fn() }, false],
      [null, true],
    ] as const) {
      const { room, log } = make(uplink);
      room.leave({ ...request, announce });
      if (uplink) expect(uplink.send).not.toHaveBeenCalled();
      expect(log).toEqual(["close"]);
    }
  });

  it("logs a failed send and still closes", () => {
    const { room, log, debug } = make({
      readyState: "open",
      send: () => {
        throw new Error("gone");
      },
    });
    room.leave({ ...request, announce: true });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["close"]);
  });

  it("closes on drop and has nothing else to do", () => {
    const { room, log } = make(null);
    room.drop({ roomId: "R", myId: "me" });
    room.setHost({ roomId: "R", myId: "me", newHost: "x" });
    room.kick({ roomId: "R", myId: "me", targetId: "x" });
    expect(log).toEqual(["close"]);
  });
});

type Row = Record<string, unknown>;

/** A small in-memory stand-in for the supabase-js calls the room code makes. */
function fakeClient(tables: { players: Row[]; rooms: Row[] }, failOn?: string) {
  const calls: string[] = [];
  const client: SupabaseClientLike = {
    removeChannel: () => undefined,
    from(table) {
      const rows = tables[table as "players" | "rooms"];
      const make = (op: string, values?: Row) => {
        const filters: Array<(r: Row) => boolean> = [];
        const execute = () => {
          if (failOn === `${op} ${table}`) throw new Error("db down");
          if (op === "insert" || op === "upsert") {
            if (failOn === `${op} ${table} error`)
              return { data: null, error: { message: "refused" } };
            const at = op === "upsert" ? rows.findIndex((r) => r.id === values?.id) : -1;
            if (at >= 0) rows[at] = { ...values };
            else rows.push({ ...values });
            calls.push(`${op} ${table}`);
            return { data: null };
          }
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          calls.push(`${op} ${table}`);
          if (op === "delete") for (const r of hit) rows.splice(rows.indexOf(r), 1);
          if (op === "update") for (const r of hit) Object.assign(r, values);
          return { data: op === "select" ? hit : null };
        };
        const query = {
          eq(c: string, v: unknown) {
            filters.push((r) => r[c] === v);
            return query;
          },
          neq(c: string, v: unknown) {
            filters.push((r) => r[c] !== v);
            return query;
          },
          maybeSingle: () => {
            const { data } = execute();
            return Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data });
          },
          then: (ok: (v: { data: unknown }) => unknown, bad?: (e: unknown) => unknown) =>
            new Promise((resolve) => resolve(execute())).then(ok, bad),
        };
        return query;
      };
      return {
        select: () => make("select"),
        insert: (values: Row) => make("insert", values),
        upsert: (values: Row) => make("upsert", values),
        delete: () => make("delete"),
        update: (values: Row) => make("update", values),
      } as never;
    },
  };
  return { client, calls };
}

describe("supabase room", () => {
  const NOW = Date.parse("2026-11-13T12:00:00Z");
  const ago = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();
  const row = (id: string, joined: number, role = "player", active = 1): Row => ({
    id,
    state: { role, joined },
    last_active: ago(active),
    room_id: "R",
  });

  function make(tables: { players: Row[]; rooms: Row[] }, failOn?: string) {
    const { transport, log, sent } = fakeTransport();
    const { client, calls } = fakeClient(tables, failOn);
    const debug = vi.fn();
    const warn = vi.fn();
    const room = createSupabaseRoom({
      transport,
      client: () => client,
      now: () => NOW,
      isoNow: () => "NOW",
      debug,
      warn,
    });
    return { room, tables, log, sent, calls, debug, warn };
  }
  const base = { roomId: "R", myId: "me", myName: "ME", announce: true, players: [] };

  it("removes a guest's seat, tells the room, and leaves the room row alone", async () => {
    const t = { players: [row("h", 1), row("me", 2)], rooms: [{ id: "R", host_id: "h" }] };
    const { room, log, tables } = make(t);
    await room.leave({ ...base, isHost: false });
    expect(tables.players.map((r) => r.id)).toEqual(["h"]);
    expect(tables.rooms).toEqual([{ id: "R", host_id: "h" }]);
    expect(log).toEqual(["send left", "close"]);
  });

  it("makes the earliest live player host when the host leaves", async () => {
    const t = {
      players: [row("me", 1), row("late", 5), row("spec", 2, "spec"), row("early", 3)],
      rooms: [{ id: "R", host_id: "me" }],
    };
    const { room, tables } = make(t);
    await room.leave({ ...base, isHost: true });
    expect(tables.rooms).toEqual([{ id: "R", host_id: "early", last_active: "NOW" }]);
  });

  it("falls back to a spectator when no player is left, and ignores stale seats", async () => {
    const t = {
      players: [row("me", 1), row("old", 2, "player", 30), row("spec", 3, "spec")],
      rooms: [{ id: "R", host_id: "me" }],
    };
    const { room, tables } = make(t);
    await room.leave({ ...base, isHost: true });
    expect(tables.rooms[0]?.host_id).toBe("spec");
  });

  it("leaves the host alone when everyone else is stale but still deletes nothing", async () => {
    const t = {
      players: [row("me", 1), row("old", 2, "player", 30)],
      rooms: [{ id: "R", host_id: "me" }],
    };
    const { room, tables } = make(t);
    await room.leave({ ...base, isHost: true });
    expect(tables.rooms).toEqual([{ id: "R", host_id: "me" }]);
  });

  it("deletes the room when nobody fresh is left", async () => {
    const t = { players: [row("me", 1)], rooms: [{ id: "R", host_id: "me" }] };
    const a = make(t);
    await a.room.leave({ ...base, isHost: true });
    expect(a.tables.rooms).toEqual([]);
    const stale = {
      players: [row("me", 1), row("ghost", 2, "player", 120)],
      rooms: [{ id: "R", host_id: "me" }],
    };
    const b = make(stale);
    await b.room.leave({ ...base, isHost: false });
    expect(b.tables.rooms).toEqual([]);
  });

  it("does not announce when told not to", async () => {
    const { room, log } = make({ players: [row("me", 1)], rooms: [] });
    await room.leave({ ...base, announce: false, isHost: false });
    expect(log).toEqual(["close"]);
  });

  it("logs a database failure and still closes", async () => {
    const t = { players: [row("me", 1)], rooms: [{ id: "R" }] };
    const { room, log, debug } = make(t, "delete players");
    await room.leave({ ...base, isHost: true });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(log.at(-1)).toBe("close");
  });

  it("does nothing without a room or a client", async () => {
    const { room, log } = make({ players: [], rooms: [] });
    await room.leave({ ...base, roomId: null, isHost: true });
    expect(log).toEqual([]);
    const { transport, log: log2 } = fakeTransport();
    const bare = createSupabaseRoom({
      transport,
      client: () => null,
      now: () => NOW,
      isoNow: () => "NOW",
      debug: vi.fn(),
      warn: vi.fn(),
    });
    await bare.leave({ ...base, isHost: true });
    bare.drop({ roomId: "R", myId: "me" });
    expect(log2).toEqual(["close"]);
  });

  it("drops by deleting the seat, and records host, state and kicks", async () => {
    const t = {
      players: [row("me", 1), row("x", 2)],
      rooms: [{ id: "R", host_id: "me" }],
    };
    const { room, tables, log } = make(t);
    room.setHost({ roomId: "R", myId: "me", newHost: "x" });
    room.saveMyState({ myId: "me", state: { role: "player", ready: true } });
    room.kick({ roomId: "R", myId: "me", targetId: "x" });
    await Promise.resolve();
    expect(tables.rooms[0]?.host_id).toBe("x");
    expect(tables.players.map((r) => r.id)).toEqual(["me"]);
    expect(tables.players[0]?.state).toEqual({ role: "player", ready: true });
    room.drop({ roomId: "R", myId: "me" });
    await Promise.resolve();
    expect(tables.players).toEqual([]);
    expect(log).toEqual(["close"]);
  });

  it("treats a row with no timestamp as fresh", () => {
    expect(rowIsFresh({}, 10, NOW)).toBe(true);
    expect(rowIsFresh({ last_active: ago(9) }, 10, NOW)).toBe(true);
    expect(rowIsFresh({ last_active: ago(11) }, 10, NOW)).toBe(false);
    expect(rowIsFresh(null, 10, NOW)).toBe(true);
  });
});

describe("supabase transport close", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(channel: SupabaseChannelLike | null, remove = vi.fn()) {
    const detach = vi.fn();
    const debug = vi.fn();
    const t = createSupabaseTransport({ channel: () => channel, debug, detach, remove });
    return { t, detach, remove, debug };
  }
  const channel = (): SupabaseChannelLike => ({ send: () => undefined, on: () => channel() });

  it("stops sending at once and removes the channel after the delay", () => {
    const ch = channel();
    const { t, detach, remove } = make(ch);
    t.close();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SUPABASE_CLOSE_DELAY_MS - 1);
    expect(remove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(remove).toHaveBeenCalledWith(ch);
  });

  it("logs a failed removal", () => {
    const { t, debug } = make(
      channel(),
      vi.fn(() => {
        throw new Error("gone");
      }),
    );
    t.close();
    vi.advanceTimersByTime(SUPABASE_CLOSE_DELAY_MS);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it("removes nothing when there is no channel, and is safe to call twice", () => {
    const { t, remove } = make(null);
    t.close();
    t.close();
    vi.advanceTimersByTime(SUPABASE_CLOSE_DELAY_MS * 2);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("opening and joining a room", () => {
  const request = { roomId: "ROOM", myId: "me", myName: "Me", now: 1000 };
  const rules = { seed: 42, pwdH: "" };

  it("relay: starts hosting and answers at once; join passes the password and returns the outcome", async () => {
    const { transport, log } = fakeTransport();
    const accepted = {
      ok: true as const,
      roomId: "ROOM",
      hostId: "h",
      isHost: false,
      seed: 7,
      settings: { seed: 7 },
    };
    const room = createRelayRoom({
      transport,
      startHost: (id) => void log.push(`host ${id}`),
      startJoin: async (id, password) => {
        log.push(`join ${id} [${password}]`);
        return accepted;
      },
      publishBroker: () => undefined,
      removeFromRoster: () => undefined,
      markDead: () => undefined,
      pushRoster: () => undefined,
      destroyConnection: () => undefined,
      later: () => undefined,
    });
    expect(await room.create({ ...request, settings: rules })).toEqual({
      ok: true,
      roomId: "ROOM",
      hostId: "me",
    });
    expect(await room.join({ ...request, password: "pw", passwordChecked: false })).toBe(accepted);
    expect(log).toEqual(["host ROOM", "join ROOM [pw]"]);
  });

  it("LAN: rooms are made by hand, so both answer manual", async () => {
    const { transport } = fakeTransport();
    const room = createLanRoom({ transport, uplink: () => null, debug: vi.fn() });
    expect(await room.create({ ...request, settings: rules })).toEqual({
      ok: false,
      reason: "manual",
    });
    expect(await room.join({ ...request, password: "", passwordChecked: false })).toEqual({
      ok: false,
      reason: "manual",
    });
  });

  describe("supabase", () => {
    const NOW = Date.parse("2026-11-13T12:00:00Z");
    function make(tables: { players: Row[]; rooms: Row[] }, failOn?: string) {
      const { transport } = fakeTransport();
      const { client, calls } = fakeClient(tables, failOn);
      const warn = vi.fn();
      const debug = vi.fn();
      const room = createSupabaseRoom({
        transport,
        client: () => client,
        now: () => NOW,
        isoNow: () => "NOW",
        debug,
        warn,
      });
      return { room, calls, warn, debug };
    }
    const seat = (id: string, role = "player", joined = 1): Row => ({
      id,
      room_id: "ROOM",
      state: { role, joined },
    });
    const joinRequest = { ...request, password: "", passwordChecked: false };

    it("create writes the room row and the host's seat", async () => {
      const tables = { players: [] as Row[], rooms: [] as Row[] };
      const { room } = make(tables);
      expect(await room.create({ ...request, settings: rules })).toEqual({
        ok: true,
        roomId: "ROOM",
        hostId: "me",
      });
      expect(tables.rooms).toEqual([
        { id: "ROOM", host_id: "me", settings: rules, last_active: "NOW" },
      ]);
      expect(tables.players).toEqual([
        { id: "me", room_id: "ROOM", username: "Me", state: { role: "player", joined: 1000 } },
      ]);
    });

    it("create reports a refused write or a thrown error as failed, without throwing", async () => {
      const refused = make({ players: [], rooms: [] }, "insert rooms error");
      expect(await refused.room.create({ ...request, settings: rules })).toEqual({
        ok: false,
        reason: "failed",
      });
      const seatRefused = make({ players: [], rooms: [] }, "upsert players error");
      expect(await seatRefused.room.create({ ...request, settings: rules })).toEqual({
        ok: false,
        reason: "failed",
      });
      const down = make({ players: [], rooms: [] }, "insert rooms");
      expect(await down.room.create({ ...request, settings: rules })).toEqual({
        ok: false,
        reason: "failed",
      });
      expect(down.debug).toHaveBeenCalledOnce();
    });

    it("answers unavailable without a client", async () => {
      const { transport } = fakeTransport();
      const bare = createSupabaseRoom({
        transport,
        client: () => null,
        now: () => NOW,
        isoNow: () => "NOW",
        debug: vi.fn(),
        warn: vi.fn(),
      });
      expect(await bare.create({ ...request, settings: rules })).toEqual({
        ok: false,
        reason: "unavailable",
      });
      expect(await bare.join(joinRequest)).toEqual({ ok: false, reason: "unavailable" });
    });

    it("join seats a guest as a player and returns the host's rules", async () => {
      const tables = {
        players: [seat("h")],
        rooms: [{ id: "ROOM", host_id: "h", settings: { seed: 9, mode: "battle" } }],
      };
      const { room } = make(tables);
      expect(await room.join(joinRequest)).toEqual({
        ok: true,
        roomId: "ROOM",
        hostId: "h",
        isHost: false,
        seed: 9,
        settings: { seed: 9, mode: "battle" },
      });
      expect(tables.players.at(-1)).toEqual({
        id: "me",
        room_id: "ROOM",
        username: "Me",
        state: { role: "player", joined: 1000, rejoined: 1000 },
      });
    });

    it("join makes the fifth player a spectator", async () => {
      const tables = {
        players: [seat("a"), seat("b"), seat("c"), seat("d"), seat("w", "spec")],
        rooms: [{ id: "ROOM", host_id: "a", settings: {} }],
      };
      const { room } = make(tables);
      const joined = await room.join(joinRequest);
      expect(joined.ok).toBe(true);
      expect(tables.players.find((p) => p.id === "me")?.state).toMatchObject({ role: "spec" });
    });

    it("join keeps the seat and role of a player who comes back, and knows the host", async () => {
      const tables = {
        players: [seat("me", "spec", 500)],
        rooms: [{ id: "ROOM", host_id: "me", settings: { seed: 1 } }],
      };
      const { room } = make(tables);
      const joined = await room.join(joinRequest);
      expect(joined).toMatchObject({ ok: true, isHost: true });
      expect(tables.players[0]?.state).toEqual({ role: "spec", joined: 500, rejoined: 1000 });
    });

    it("join asks for the password of a protected room unless it was checked", async () => {
      const tables = {
        players: [seat("h")],
        rooms: [{ id: "ROOM", host_id: "h", settings: { seed: 3, pwdH: "abcd1234" } }],
      };
      const { room } = make(tables);
      expect(await room.join(joinRequest)).toEqual({
        ok: false,
        reason: "password",
        pwdH: "abcd1234",
      });
      expect(tables.players).toHaveLength(1);
      expect(await room.join({ ...joinRequest, passwordChecked: true })).toMatchObject({
        ok: true,
      });
    });

    it("join says not-found for an unknown room, failed when the seat cannot be written", async () => {
      const none = make({ players: [], rooms: [] });
      expect(await none.room.join(joinRequest)).toEqual({ ok: false, reason: "not-found" });
      const tables = { players: [], rooms: [{ id: "ROOM", host_id: "h", settings: {} }] };
      const refused = make(tables, "upsert players error");
      expect(await refused.room.join(joinRequest)).toEqual({ ok: false, reason: "failed" });
      expect(refused.warn).toHaveBeenCalledOnce();
      const down = make(tables, "select rooms");
      expect(await down.room.join(joinRequest)).toEqual({ ok: false, reason: "failed" });
    });
  });
});
