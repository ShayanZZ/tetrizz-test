import { describe, expect, it } from "vitest";
import {
  createRoomChannelHandlers,
  listenToRoomRows,
  type RoomChannelDeps,
  type RoomChannelMatch,
  type RoomChannelSession,
} from "../../apps/web/src/net/backends/supabase-channel";

type Timer = ReturnType<typeof setTimeout>;

function setup(over: Partial<RoomChannelSession> = {}, matchOver: Partial<RoomChannelMatch> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const timers: Array<{ id: number; at: number; task: () => void; live: boolean }> = [];
  let clockNow = 100_000;
  let gameState = "menu";
  let lastReady: number | undefined;

  const session: RoomChannelSession = {
    myPlayerId: "me",
    onlineRoomId: "ROOMAB",
    leavingRoom: false,
    isOnlineHost: false,
    onlineHostId: "host",
    onlineJoinedRoomAt: 0,
    onlineReadyFlags: {},
    isOnlineGame: false,
    isSpectator: false,
    onlineGameActive: false,
    onlineLocalOrder: [],
    onlineSeed: 1,
    onlineRoomPwdH: "",
    ...over,
  };
  const match: RoomChannelMatch = {
    vsMatchOver: false,
    vsActive: false,
    vsRound: 1,
    vsRoundT: undefined,
    vs: {},
    ...matchOver,
  };
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push([name, ...args]);

  const deps: RoomChannelDeps = {
    roomId: "ROOMAB",
    session,
    match,
    gameState: () => gameState,
    now: () => clockNow,
    lastReadyToggleAt: () => lastReady,
    later: (task, ms) => {
      const entry = { id: timers.length + 1, at: clockNow + ms, task, live: true };
      timers.push(entry);
      return entry.id as unknown as Timer;
    },
    cancel: (timer) => {
      const entry = timers.find((t) => (t.id as unknown as Timer) === timer);
      if (entry) entry.live = false;
    },
    send: record("send"),
    rejoinPayload: (id) => ({ rejoinFor: id }),
    forcedLeave: record("forcedLeave"),
    markLeft: record("markLeft"),
    refreshPlayers: record("refreshPlayers"),
    claimHost: record("claimHost"),
    deleteRoomIfEmpty: record("deleteRoomIfEmpty"),
    renderLists: record("renderLists"),
    note: record("note"),
    hostDecides: record("hostDecides"),
    applyRules: record("applyRules"),
    startMatch: record("startMatch"),
  };
  const handlers = createRoomChannelHandlers(deps);
  return {
    handlers,
    session,
    match,
    calls,
    names: () => calls.map((c) => c[0]),
    setGame: (state: string) => void (gameState = state),
    setReady: (at: number | undefined) => void (lastReady = at),
    advance(ms: number) {
      clockNow += ms;
      for (const t of timers) {
        if (t.live && t.at <= clockNow) {
          t.live = false;
          t.task();
        }
      }
    },
    now: () => clockNow,
  };
}

describe("seats being deleted", () => {
  it("leaves the room when my own seat is deleted (a kick)", () => {
    const t = setup();
    t.handlers.onSeatChange({ eventType: "DELETE", old: { id: "me" } });
    expect(t.calls).toEqual([["forcedLeave", "You were kicked from the room."]]);
  });

  it("does not treat the host's own seat going, or one just after joining, as a kick", () => {
    const host = setup({ isOnlineHost: true });
    host.handlers.onSeatChange({ eventType: "DELETE", old: { id: "me" } });
    const fresh = setup({ onlineJoinedRoomAt: 100_000 - 7_999 });
    fresh.handlers.onSeatChange({ eventType: "DELETE", old: { id: "me" } });
    const settled = setup({ onlineJoinedRoomAt: 100_000 - 8_000 });
    settled.handlers.onSeatChange({ eventType: "DELETE", old: { id: "me" } });
    expect(host.calls).toEqual([]);
    expect(fresh.calls).toEqual([]);
    expect(settled.names()).toEqual(["forcedLeave"]);
  });

  it("does nothing while leaving or after the room is gone", () => {
    const leaving = setup({ leavingRoom: true });
    leaving.handlers.onSeatChange({ eventType: "DELETE", old: { id: "me" } });
    const gone = setup({ onlineRoomId: null });
    gone.handlers.onSeatChange({ eventType: "DELETE", old: { id: "me" } });
    expect(leaving.calls).toEqual([]);
    expect(gone.calls).toEqual([]);
  });

  it("marks another player as gone, refreshes, and cleans up", () => {
    const t = setup();
    t.handlers.onSeatChange({ eventType: "DELETE", old: { id: "p2", username: "ANA" } });
    expect(t.calls).toEqual([
      ["markLeft", "p2", "ANA LEFT"],
      ["refreshPlayers"],
      ["deleteRoomIfEmpty"],
    ]);
  });

  it("names a player without a name PLAYER and asks to take over when the host left", () => {
    const t = setup();
    t.handlers.onSeatChange({ eventType: "DELETE", old: { id: "host" } });
    expect(t.calls).toEqual([
      ["markLeft", "host", "PLAYER LEFT"],
      ["refreshPlayers"],
      ["claimHost", "host"],
      ["deleteRoomIfEmpty"],
    ]);
  });
});

describe("seat updates", () => {
  it("records another player's ready flag and refreshes the list", () => {
    const t = setup();
    t.handlers.onSeatChange({ eventType: "UPDATE", new: { id: "p2", state: { ready: true } } });
    expect(t.session.onlineReadyFlags).toEqual({ p2: true });
    expect(t.names()).toEqual(["refreshPlayers"]);
  });

  it("ignores the echo of my own ready change for 2.5 seconds, then takes it", () => {
    const t = setup();
    t.setReady(t.now() - 2_499);
    t.handlers.onSeatChange({ eventType: "UPDATE", new: { id: "me", state: { ready: true } } });
    expect(t.session.onlineReadyFlags).toEqual({});
    t.setReady(t.now() - 2_500);
    t.handlers.onSeatChange({ eventType: "UPDATE", new: { id: "me", state: { ready: true } } });
    expect(t.session.onlineReadyFlags).toEqual({ me: true });
  });

  it("sends a rejoin for a known player who just came back during a match", () => {
    const t = setup({ isOnlineGame: true, onlineLocalOrder: ["me", "p2"] });
    t.setGame("playing");
    t.handlers.onSeatChange({
      eventType: "UPDATE",
      new: { id: "p2", state: { joined: t.now() - 20_000, rejoined: t.now() - 9_999 } },
    });
    expect(t.calls[0]).toEqual(["send", "rejoin", { rejoinFor: "p2" }]);
  });

  it("does not send one when the seat's last join was 10 seconds ago or more", () => {
    const t = setup({ isOnlineGame: true, onlineLocalOrder: ["me", "p2"] });
    t.setGame("vsround");
    t.handlers.onSeatChange({
      eventType: "UPDATE",
      new: { id: "p2", state: { joined: t.now() - 10_000 } },
    });
    expect(t.names()).toEqual(["refreshPlayers"]);
  });

  it("does nothing special outside a round", () => {
    const t = setup({ isOnlineGame: true, onlineLocalOrder: ["me", "p2"] });
    t.setGame("menu");
    t.handlers.onSeatChange({ eventType: "INSERT", new: { id: "p2" } });
    expect(t.names()).toEqual(["refreshPlayers"]);
  });
});

describe("seats being added during a match", () => {
  it("asks a returning player for a rejoin", () => {
    const t = setup({ isOnlineGame: true, onlineLocalOrder: ["me", "p2"] });
    t.setGame("countdown");
    t.handlers.onSeatChange({ eventType: "INSERT", new: { id: "p2" } });
    expect(t.calls).toEqual([["send", "rejoin", { rejoinFor: "p2" }], ["refreshPlayers"]]);
  });

  it("tells a newcomer the match is running, with its seed, order and round", () => {
    const t = setup(
      { isOnlineGame: true, onlineLocalOrder: ["me", "p2"], onlineSeed: 77 },
      {
        vsRound: 3,
      },
    );
    t.setGame("playing");
    t.handlers.onSeatChange({ eventType: "INSERT", new: { id: "p3" } });
    expect(t.calls[0]).toEqual([
      "send",
      "game-active",
      { sender: "me", seed: 77, order: ["me", "p2"], round: 3 },
    ]);
  });

  it("stays quiet once the match is over, and for my own seat", () => {
    const over = setup({ isOnlineGame: true }, { vsMatchOver: true });
    over.setGame("playing");
    over.handlers.onSeatChange({ eventType: "INSERT", new: { id: "p3" } });
    const mine = setup({ isOnlineGame: true });
    mine.setGame("playing");
    mine.handlers.onSeatChange({ eventType: "INSERT", new: { id: "me" } });
    expect(over.names()).toEqual(["refreshPlayers"]);
    expect(mine.names()).toEqual(["refreshPlayers"]);
  });
});

describe("the room row changing", () => {
  it("announces that I am the host now, once", () => {
    const t = setup();
    t.handlers.onRoomUpdate({ eventType: "UPDATE", new: { host_id: "me" } });
    expect(t.session.isOnlineHost).toBe(true);
    expect(t.session.onlineHostId).toBe("me");
    expect(t.calls).toEqual([["note", "You are now the HOST"], ["renderLists"]]);
    t.calls.length = 0;
    t.handlers.onRoomUpdate({ eventType: "UPDATE", new: { host_id: "me" } });
    expect(t.calls).toEqual([["renderLists"]]);
  });

  it("makes the new host decide how the round goes on after 800 ms, replacing an earlier timer", () => {
    const t = setup({}, {});
    t.setGame("vsround");
    t.handlers.onRoomUpdate({ eventType: "UPDATE", new: { host_id: "me" } });
    t.handlers.onRoomUpdate({ eventType: "UPDATE", new: { host_id: "me" } });
    t.calls.length = 0;
    t.advance(799);
    expect(t.names()).toEqual([]);
    t.advance(1);
    expect(t.calls).toEqual([["hostDecides"]]);
  });

  it("copies the host's rules for a guest, but not the seed, players or password fields", () => {
    const t = setup();
    t.handlers.onRoomUpdate({
      eventType: "UPDATE",
      new: {
        host_id: "host",
        settings: {
          lines: 40,
          players: 4,
          pwd: "secret",
          pwdH: "abc123",
          seed: 555,
          garbage: "on",
        },
      },
    });
    expect(t.match.vs).toEqual({ lines: 40, garbage: "on" });
    expect(t.session.onlineSeed).toBe(555);
    expect(t.session.onlineRoomPwdH).toBe("abc123");
    expect(t.names()).toEqual(["applyRules", "renderLists"]);
  });

  it("starts the match for a player in the order when the start is fresh", () => {
    const t = setup();
    t.handlers.onRoomUpdate({
      eventType: "UPDATE",
      new: {
        host_id: "host",
        settings: { st: { order: ["host", "me"], seed: 9, ts: t.now() - 19_999 } },
      },
    });
    expect(t.session.onlineSeed).toBe(9);
    expect(t.calls.at(-1)).toEqual(["startMatch", ["host", "me"]]);
  });

  it("only marks the match as running for a player who is not in it", () => {
    const t = setup();
    t.handlers.onRoomUpdate({
      eventType: "UPDATE",
      new: { host_id: "host", settings: { st: { order: ["host", "p2"], ts: t.now() } } },
    });
    expect(t.session.onlineGameActive).toBe(true);
    expect(t.names()).not.toContain("startMatch");
  });

  it("ignores a start that is 20 seconds old, or one when a game is already on", () => {
    const stale = setup();
    stale.handlers.onRoomUpdate({
      eventType: "UPDATE",
      new: { host_id: "host", settings: { st: { order: ["me"], ts: stale.now() - 20_000 } } },
    });
    const running = setup({ isOnlineGame: true });
    running.handlers.onRoomUpdate({
      eventType: "UPDATE",
      new: { host_id: "host", settings: { st: { order: ["me"], ts: running.now() } } },
    });
    expect(stale.names()).not.toContain("startMatch");
    expect(running.names()).not.toContain("startMatch");
  });

  it("ignores an update without a row", () => {
    const t = setup();
    t.handlers.onRoomUpdate({ eventType: "UPDATE", new: null });
    expect(t.calls).toEqual([]);
  });

  it("closes the room for everyone left in it, unless I am the one leaving", () => {
    const t = setup();
    t.handlers.onRoomDelete();
    expect(t.calls).toEqual([["forcedLeave", "The room was closed (expired or empty)."]]);
    const leaving = setup({ leavingRoom: true });
    leaving.handlers.onRoomDelete();
    expect(leaving.calls).toEqual([]);
  });
});

describe("asking for a rejoin once subscribed", () => {
  it("waits for SUBSCRIBED, asks after 700 ms, and repeats every 1.5 s up to 8 times", () => {
    const t = setup();
    t.handlers.onStatus("TIMED_OUT");
    t.advance(5_000);
    expect(t.calls).toEqual([]);
    t.handlers.onStatus("SUBSCRIBED");
    t.advance(699);
    expect(t.calls).toEqual([]);
    t.advance(1);
    expect(t.calls).toEqual([["send", "rejoin-req", { sender: "me" }]]);
    for (let i = 0; i < 20; i++) t.advance(1_500);
    expect(t.calls.filter((c) => c[1] === "rejoin-req")).toHaveLength(8);
  });

  it("starts only once, however many times it is told it is subscribed", () => {
    const t = setup();
    t.handlers.onStatus("SUBSCRIBED");
    t.handlers.onStatus("SUBSCRIBED");
    t.advance(700);
    expect(t.calls).toHaveLength(1);
  });

  it("stops asking once a game is on or the player is a spectator", () => {
    const t = setup();
    t.handlers.onStatus("SUBSCRIBED");
    t.advance(700);
    t.session.isOnlineGame = true;
    t.advance(1_500);
    t.advance(1_500);
    expect(t.calls).toHaveLength(1);
    const spectator = setup({ isSpectator: true });
    spectator.handlers.onStatus("SUBSCRIBED");
    spectator.advance(5_000);
    expect(spectator.calls).toEqual([]);
  });
});

describe("listening to the room's rows", () => {
  it("registers the seats, the room update and the room delete, in that order", () => {
    const seen: Array<{ type: string; filter: Record<string, string> }> = [];
    const channel = {
      on(type: "postgres_changes", filter: Record<string, string>) {
        seen.push({ type, filter });
        return channel;
      },
    };
    const handlers = setup().handlers;
    const returned = listenToRoomRows(channel as never, "ROOMAB", handlers);
    expect(returned).toBe(channel);
    expect(seen).toEqual([
      {
        type: "postgres_changes",
        filter: { event: "*", schema: "public", table: "players", filter: "room_id=eq.ROOMAB" },
      },
      {
        type: "postgres_changes",
        filter: { event: "UPDATE", schema: "public", table: "rooms", filter: "id=eq.ROOMAB" },
      },
      {
        type: "postgres_changes",
        filter: { event: "DELETE", schema: "public", table: "rooms", filter: "id=eq.ROOMAB" },
      },
    ]);
  });
});
