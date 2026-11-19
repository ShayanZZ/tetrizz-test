import { describe, expect, it } from "vitest";
import { fromWire, helloFor, player, toWire } from "../helpers/identity";
import {
  createReferenceServer,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  SERVER_MAX_FRAME_BYTES,
  SERVER_PLAYER_LIMIT,
  SERVER_SEAT_GRACE_MS,
  type ReferenceServer,
  type ReferenceServerOptions,
  type ServerLink,
  type ServerToClient,
} from "@tetrizz/protocol";

describe("wire messages", () => {
  it("accepts well-formed messages from a page", () => {
    const hello = { t: "hello", v: 1, app: "1.2.0", id: "p1", name: "ANA" };
    expect(parseClientMessage(JSON.stringify(hello))).toEqual(hello);
    const create = {
      t: "create",
      rid: 1,
      room: "ABCD",
      name: "ANA",
      settings: { seed: 5 },
      password: "",
    };
    expect(parseClientMessage(JSON.stringify(create))).toEqual(create);
    expect(parseClientMessage('{"t":"leave","extra":1}')).toEqual({ t: "leave" });
    const rules = { t: "settings", settings: { rounds: 3 } };
    expect(parseClientMessage(JSON.stringify(rules))).toEqual(rules);
    expect(parseClientMessage(JSON.stringify({ ...rules, password: "" }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...rules, password: "new" }))).not.toBeNull();
    expect(parseClientMessage('{"t":"ev","event":"state","payload":{"a":1}}')).not.toBeNull();
  });

  it("rejects anything else", () => {
    const bad = [
      "not json",
      "[]",
      "null",
      "{}",
      '{"t":"nope"}',
      '{"t":"hello","v":"1","app":"x","id":"p","name":"n"}',
      '{"t":"hello","v":1,"app":"x","id":"","name":"n"}',
      '{"t":"join","rid":1.5,"room":"A","name":"n","password":""}',
      '{"t":"ev","event":""}',
      '{"t":"settings","settings":[]}',
      '{"t":"settings","settings":{},"password":5}',
      JSON.stringify({ t: "settings", settings: {}, password: "x".repeat(17) }),
      '{"t":"kick","target":5}',
      "x".repeat(SERVER_MAX_FRAME_BYTES + 1),
    ];
    for (const frame of bad) expect(parseClientMessage(frame), frame.slice(0, 40)).toBeNull();
    expect(parseClientMessage(42)).toBeNull();
  });

  it("reads the server's messages and ignores unknown ones", () => {
    expect(parseServerMessage('{"t":"welcome","v":1}')).toEqual({ t: "welcome", v: 1 });
    expect(parseServerMessage('{"t":"welcome","v":1,"grace":30}')).toEqual({
      t: "welcome",
      v: 1,
      grace: 30,
    });
    expect(parseServerMessage('{"t":"welcome","v":1,"grace":"soon"}')).toBeNull();
    expect(parseServerMessage('{"t":"kicked","x":1}')).toEqual({ t: "kicked" });
    expect(parseServerMessage('{"t":"roster","host":"a","players":[]}')).not.toBeNull();
    expect(parseServerMessage('{"t":"roster","host":"a"}')).toBeNull();
    expect(parseServerMessage('{"t":"joined","rid":1,"room":"A","host":"h"}')).toBeNull();
    expect(parseServerMessage('{"t":"future-message"}')).toBeNull();
  });
});

/** The reference server, with the seats it reports listed by the players' test names. */
function namedServer(options?: ReferenceServerOptions): ReferenceServer {
  const server = createReferenceServer(options);
  return {
    ...server,
    seatsOf: (code) => {
      const seats = server.seatsOf(code);
      return seats && (JSON.parse(fromWire(JSON.stringify(seats))) as typeof seats);
    },
  };
}

/** A page connected to the server, remembering what it was sent. */
interface Page {
  link: ServerLink;
  inbox: ServerToClient[];
  closed: boolean;
  say(message: object): void;
  last<T extends ServerToClient["t"]>(t: T): Extract<ServerToClient, { t: T }> | undefined;
}

/** Timers that run only when the test says so. */
function clockwork() {
  const tasks = new Map<number, { at: number; task: () => void }>();
  let next = 1;
  let now = 0;
  return {
    later(task: () => void, ms: number) {
      const id = next++;
      tasks.set(id, { at: now + ms, task });
      return () => void tasks.delete(id);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...tasks]) {
        if (entry.at <= now) {
          tasks.delete(id);
          entry.task();
        }
      }
    },
    pending: () => tasks.size,
  };
}

function serverWithGrace(extra: ReferenceServerOptions = {}) {
  const timers = clockwork();
  const server = namedServer({ later: timers.later, graceMs: 10_000, ...extra });
  return { server, timers };
}

function connect(server: ReferenceServer, id?: string, name = "NAME"): Page {
  const page: Page = {
    inbox: [],
    closed: false,
    link: undefined as unknown as ServerLink,
    say: (message) => page.link.receive(JSON.stringify(toWire(message))),
    last: (t) => page.inbox.filter((m) => m.t === t).at(-1) as never,
  };
  page.link = server.connect(
    (text) => page.inbox.push(JSON.parse(fromWire(text))),
    () => {
      page.closed = true;
    },
  );
  if (id) page.link.receive(JSON.stringify(helloFor(id, { v: PROTOCOL_VERSION, name })));
  return page;
}

function openRoom(server: ReferenceServer, code = "ROOM", password = "") {
  const host = connect(server, "host", "HOST");
  host.say({
    t: "create",
    rid: 1,
    room: code,
    name: "HOST",
    settings: { seed: 77, rounds: 3 },
    password,
  });
  return host;
}

function join(server: ReferenceServer, id: string, code = "ROOM", password = "") {
  const page = connect(server, id, id.toUpperCase());
  page.say({ t: "join", rid: 1, room: code, name: id.toUpperCase(), password });
  return page;
}

describe("reference server: connecting", () => {
  it("welcomes a current page and ends one that skips hello or sends garbage", () => {
    const server = namedServer();
    const ok = connect(server, "a");
    expect(ok.inbox[0]).toEqual({
      t: "welcome",
      v: PROTOCOL_VERSION,
      grace: SERVER_SEAT_GRACE_MS / 1000,
    });
    const silent = connect(server);
    silent.say({ t: "leave" });
    expect(silent.closed).toBe(true);
    const noisy = connect(server, "b");
    noisy.link.receive("garbage");
    expect(noisy.closed).toBe(true);
  });

  it("refuses a newer protocol and says which one it speaks", () => {
    const page = connect(namedServer());
    page.say({ t: "hello", v: PROTOCOL_VERSION + 1, app: "x", id: "a", name: "A" });
    expect(page.inbox).toEqual([{ t: "refused", reason: "version", v: PROTOCOL_VERSION }]);
    expect(page.closed).toBe(true);
  });

  it("lets a second connection with the same id replace the first", () => {
    const server = namedServer();
    const first = connect(server, "same");
    connect(server, "same");
    expect(first.closed).toBe(true);
  });
});

describe("reference server: rooms", () => {
  it("creates a room, seats the host and pushes the roster", () => {
    const server = namedServer({ now: () => 1000 });
    const host = openRoom(server);
    expect(host.last("created")).toEqual({ t: "created", rid: 1, room: "ROOM", host: "host" });
    expect(host.last("roster")?.players).toEqual([
      { id: "host", username: "HOST", state: { role: "player", joined: 1000 } },
    ]);
    expect(server.roomCount()).toBe(1);
  });

  it("refuses an existing code, a busy page, and a full server", () => {
    const server = namedServer({ maxRooms: 1 });
    openRoom(server);
    const other = connect(server, "x");
    other.say({ t: "create", rid: 4, room: "room", name: "X", settings: {}, password: "" });
    expect(other.last("refused")).toEqual({ t: "refused", rid: 4, reason: "exists" });
    other.say({ t: "create", rid: 5, room: "NEW", name: "X", settings: {}, password: "" });
    expect(other.last("refused")?.reason).toBe("busy");
  });

  it("answers a join with the host, seed and the rules the host published", () => {
    const server = namedServer();
    openRoom(server);
    const guest = join(server, "guest");
    expect(guest.last("joined")).toEqual({
      t: "joined",
      rid: 1,
      room: "ROOM",
      host: "host",
      isHost: false,
      seed: 77,
      settings: { seed: 77, rounds: 3 },
    });
    expect(guest.last("roster")?.players.map((p) => p.id)).toEqual(["host", "guest"]);
  });

  it("generates a seed when the creator sent none", () => {
    const server = namedServer({ newSeed: () => 4242 });
    const host = connect(server, "h");
    host.say({ t: "create", rid: 1, room: "R", name: "H", settings: {}, password: "" });
    const guest = join(server, "g", "R");
    expect(guest.last("joined")?.seed).toBe(4242);
  });

  it("is case-insensitive about the code and refuses an unknown one", () => {
    const server = namedServer();
    openRoom(server, "AbCd");
    expect(join(server, "a", "abcd").last("joined")?.room).toBe("ABCD");
    expect(join(server, "b", "ZZZZ").last("refused")?.reason).toBe("not-found");
  });

  it("checks the password on the server", () => {
    const server = namedServer();
    openRoom(server, "LOCK", "secret");
    expect(join(server, "a", "LOCK", "").last("refused")?.reason).toBe("password");
    expect(join(server, "b", "LOCK", "nope").last("refused")?.reason).toBe("wrong-password");
    expect(join(server, "c", "LOCK", "secret").last("joined")).toBeDefined();
  });

  it("seats four players and makes later arrivals spectators", () => {
    const server = namedServer();
    openRoom(server);
    for (let i = 1; i < SERVER_PLAYER_LIMIT; i++) join(server, `p${i}`);
    const late = join(server, "late");
    const roles = late.last("roster")?.players.map((p) => p.state.role);
    expect(roles).toEqual(["player", "player", "player", "player", "spec"]);
  });

  it("relays an event to everyone except the sender", () => {
    const server = namedServer();
    const host = openRoom(server);
    const a = join(server, "a");
    const b = join(server, "b");
    a.say({ t: "ev", event: "attack", payload: { n: 3 } });
    const expected = { t: "ev", from: "a", event: "attack", payload: { n: 3 } };
    expect(host.last("ev")).toEqual(expected);
    expect(b.last("ev")).toEqual(expected);
    expect(a.last("ev")).toBeUndefined();
  });

  it("ignores events from a page that is in no room", () => {
    const server = namedServer();
    const host = openRoom(server);
    connect(server, "x").say({ t: "ev", event: "attack" });
    expect(host.last("ev")).toBeUndefined();
  });
});

describe("reference server: host, seats and leaving", () => {
  it("keeps the host's rules for later arrivals and passes them on as an event", () => {
    const server = namedServer();
    const host = openRoom(server);
    const early = join(server, "early");
    host.say({ t: "settings", settings: { rounds: 9, seed: 1 } });
    expect(early.last("ev")).toEqual({
      t: "ev",
      from: "host",
      event: "settings",
      payload: { rounds: 9, seed: 77 },
    });
    expect(join(server, "late").last("joined")?.settings).toEqual({ rounds: 9, seed: 77 });
    early.say({ t: "settings", settings: { rounds: 1 } });
    expect(join(server, "later").last("joined")?.settings).toEqual({ rounds: 9, seed: 77 });
  });

  it("merges a seat's state, and does not let a spectator take a full table", () => {
    const server = namedServer();
    openRoom(server);
    const a = join(server, "a");
    a.say({ t: "state", state: { ready: true } });
    expect(a.last("roster")?.players.find((p) => p.id === "a")?.state).toMatchObject({
      role: "player",
      ready: true,
    });
    a.say({ t: "state", state: { role: "bogus" } });
    expect(server.seatsOf("ROOM")?.find((p) => p.id === "a")?.state.role).toBe("player");
    join(server, "b");
    join(server, "c");
    const spec = join(server, "spec");
    spec.say({ t: "state", state: { role: "player" } });
    expect(server.seatsOf("ROOM")?.find((p) => p.id === "spec")?.state.role).toBe("spec");
  });

  it("hands the host to the first player when the host leaves", () => {
    const server = namedServer();
    const host = openRoom(server);
    const a = join(server, "a");
    const b = join(server, "b");
    host.say({ t: "leave" });
    expect(a.last("host")).toEqual({ t: "host", host: "a" });
    expect(b.last("host")).toEqual({ t: "host", host: "a" });
    expect(a.last("roster")?.players.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("hands the host on at once when the host's connection drops and no grace is set", () => {
    const server = namedServer({ graceMs: 0 });
    const host = openRoom(server);
    const a = join(server, "a");
    host.link.close();
    expect(a.last("host")?.host).toBe("a");
    expect(a.last("roster")?.players.map((p) => p.id)).toEqual(["a"]);
  });

  it("closes the room when only spectators would be left", () => {
    const server = namedServer();
    const host = openRoom(server);
    const spec = join(server, "x");
    spec.say({ t: "state", state: { role: "spec" } });
    host.say({ t: "leave" });
    expect(spec.last("closed")).toEqual({ t: "closed" });
    expect(server.roomCount()).toBe(0);
  });

  it("deletes a room when its last player leaves", () => {
    const server = namedServer();
    const host = openRoom(server);
    host.say({ t: "leave" });
    expect(server.roomCount()).toBe(0);
    expect(join(server, "late").last("refused")?.reason).toBe("not-found");
  });

  it("lets only the host change host or kick", () => {
    const server = namedServer();
    const host = openRoom(server);
    const a = join(server, "a");
    const b = join(server, "b");
    a.say({ t: "kick", target: "b" });
    a.say({ t: "host", newHost: "b" });
    expect(b.last("kicked")).toBeUndefined();
    expect(server.seatsOf("ROOM")?.map((p) => p.id)).toEqual(["host", "a", "b"]);
    host.say({ t: "host", newHost: "nobody" });
    expect(a.last("host")).toBeUndefined();
  });

  it("kicks a player: tells them, drops the seat, updates the roster", () => {
    const server = namedServer();
    const host = openRoom(server);
    const a = join(server, "a");
    const b = join(server, "b");
    host.say({ t: "kick", target: "a" });
    expect(a.last("kicked")).toEqual({ t: "kicked" });
    expect(b.last("roster")?.players.map((p) => p.id)).toEqual(["host", "b"]);
    host.say({ t: "kick", target: "host" });
    expect(server.seatsOf("ROOM")?.length).toBe(2);
    a.say({ t: "ev", event: "attack" });
    expect(host.last("ev")).toBeUndefined();
  });

  it("moves the host on request", () => {
    const server = namedServer();
    const host = openRoom(server);
    const a = join(server, "a");
    host.say({ t: "host", newHost: "a" });
    expect(a.last("host")?.host).toBe("a");
    expect(a.last("roster")?.players.map((p) => p.id)).toEqual(["a", "host"]);
  });
});

describe("reference server: changing the password", () => {
  it("lets the host set, change and remove the password after the room exists", () => {
    const server = namedServer();
    const host = openRoom(server);
    expect(join(server, "a").last("joined")).toBeDefined();
    host.say({ t: "settings", settings: { rounds: 3 }, password: "secret" });
    expect(join(server, "b").last("refused")?.reason).toBe("password");
    expect(join(server, "c", "ROOM", "nope").last("refused")?.reason).toBe("wrong-password");
    expect(join(server, "d", "ROOM", "secret").last("joined")).toBeDefined();
    host.say({ t: "settings", settings: { rounds: 3 }, password: "other" });
    expect(join(server, "e", "ROOM", "secret").last("refused")?.reason).toBe("wrong-password");
    expect(join(server, "f", "ROOM", "other").last("joined")).toBeDefined();
    host.say({ t: "settings", settings: { rounds: 3 }, password: "" });
    expect(join(server, "g").last("joined")).toBeDefined();
  });

  it("keeps the password when the rules change without one", () => {
    const server = namedServer();
    const host = openRoom(server, "ROOM", "secret");
    host.say({ t: "settings", settings: { rounds: 5 } });
    expect(join(server, "a").last("refused")?.reason).toBe("password");
    expect(join(server, "b", "ROOM", "secret").last("joined")?.settings).toMatchObject({
      rounds: 5,
    });
  });

  it("ignores a password from anyone but the host, and never tells players the password", () => {
    const server = namedServer();
    const host = openRoom(server);
    const a = join(server, "a");
    a.say({ t: "settings", settings: {}, password: "mine" });
    expect(join(server, "b").last("joined")).toBeDefined();
    host.say({ t: "settings", settings: { rounds: 4 }, password: "secret" });
    const event = a.last("ev");
    expect(event?.event).toBe("settings");
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(join(server, "c", "ROOM", "secret").last("joined"))).not.toContain(
      "secret",
    );
  });

  it("does not ask a player who already has a seat, and checks everyone else against the new one", () => {
    const server = namedServer();
    const host = openRoom(server);
    const a = join(server, "a");
    host.say({ t: "settings", settings: {}, password: "secret" });
    a.say({ t: "leave" });
    expect(join(server, "a").last("refused")?.reason).toBe("password");
  });

  it("stores the password through the hooks it is given", () => {
    const stored: string[] = [];
    const server = namedServer({
      passwords: {
        hash: (plain) => {
          stored.push(plain);
          return `#${plain.length}:${plain.split("").reverse().join("")}`;
        },
        verify: (plain, hash) => hash === `#${plain.length}:${plain.split("").reverse().join("")}`,
      },
    });
    const host = openRoom(server, "ROOM", "abc");
    expect(join(server, "a", "ROOM", "abc").last("joined")).toBeDefined();
    expect(join(server, "b", "ROOM", "abd").last("refused")?.reason).toBe("wrong-password");
    host.say({ t: "settings", settings: {}, password: "xyz" });
    expect(join(server, "c", "ROOM", "xyz").last("joined")).toBeDefined();
    host.say({ t: "settings", settings: {}, password: "" });
    expect(stored).toEqual(["abc", "xyz"]);
    expect(join(server, "d").last("joined")).toBeDefined();
  });
});

describe("reference server: holding the seat of a dropped player", () => {
  it("marks a dropped seat as away, keeps it for the grace period and tells the others", () => {
    const { server } = serverWithGrace();
    const host = openRoom(server);
    const a = join(server, "a");
    a.link.close();
    const roster = host.last("roster");
    expect(roster?.players.map((p) => p.id)).toEqual(["host", "a"]);
    expect(roster?.players[1]?.state.away).toBe(true);
    expect(server.seatsOf("ROOM")).toHaveLength(2);
  });

  it("gives the seat back to the same player id, keeping role, ready flag and joined time", () => {
    const { server, timers } = serverWithGrace();
    openRoom(server);
    const a = join(server, "a");
    a.say({ t: "state", state: { ready: true } });
    const before = server.seatsOf("ROOM")?.find((s) => s.id === "a");
    a.link.close();
    timers.advance(9_000);
    const back = join(server, "a");
    const joined = back.last("joined");
    expect(joined?.isHost).toBe(false);
    const after = server.seatsOf("ROOM")?.find((s) => s.id === "a");
    expect(after?.state).toEqual({ ...before?.state });
    expect(after?.state.away).toBeUndefined();
    expect(server.seatsOf("ROOM")).toHaveLength(2);
    timers.advance(60_000);
    expect(server.seatsOf("ROOM")).toHaveLength(2);
  });

  it("removes the seat when the grace period ends", () => {
    const { server, timers } = serverWithGrace();
    const host = openRoom(server);
    const a = join(server, "a");
    a.link.close();
    timers.advance(9_999);
    expect(server.seatsOf("ROOM")).toHaveLength(2);
    timers.advance(1);
    expect(server.seatsOf("ROOM")?.map((s) => s.id)).toEqual(["host"]);
    expect(host.last("roster")?.players.map((p) => p.id)).toEqual(["host"]);
    expect(join(server, "a").last("joined")).toBeDefined();
    expect(server.seatsOf("ROOM")?.find((s) => s.id === "a")?.state.away).toBeUndefined();
  });

  it("holds the host role too, and hands it on only when the grace period ends", () => {
    const { server, timers } = serverWithGrace();
    const host = openRoom(server);
    const a = join(server, "a");
    host.link.close();
    expect(a.last("host")).toBeUndefined();
    expect(a.last("roster")?.host).toBe("host");
    timers.advance(10_000);
    expect(a.last("host")?.host).toBe("a");
    expect(a.last("roster")?.players.map((p) => p.id)).toEqual(["a"]);
  });

  it("lets a returning host take the room back as host", () => {
    const { server, timers } = serverWithGrace();
    const host = openRoom(server);
    const a = join(server, "a");
    host.link.close();
    timers.advance(5_000);
    const back = join(server, "host");
    expect(back.last("joined")?.isHost).toBe(true);
    expect(back.last("joined")?.seed).toBe(77);
    expect(a.last("roster")?.host).toBe("host");
    expect(a.last("roster")?.players.every((p) => !p.state.away)).toBe(true);
    timers.advance(60_000);
    expect(a.last("host")).toBeUndefined();
  });

  it("does not hand the room to a seat that is itself away", () => {
    const { server, timers } = serverWithGrace();
    const host = openRoom(server);
    const a = join(server, "a");
    const b = join(server, "b");
    a.link.close();
    host.say({ t: "leave" });
    expect(b.last("host")?.host).toBe("b");
    timers.advance(10_000);
    expect(b.last("roster")?.players.map((p) => p.id)).toEqual(["b"]);
  });

  it("closes the room when the host's seat ends and nobody present can take over", () => {
    const { server, timers } = serverWithGrace();
    const host = openRoom(server);
    const a = join(server, "a");
    host.link.close();
    a.link.close();
    timers.advance(10_000);
    expect(server.roomCount()).toBe(0);
    expect(join(server, "late").last("refused")?.reason).toBe("not-found");
    expect(timers.pending()).toBe(0);
  });

  it("lets a new connection with the same id take a seat from a half-open one", () => {
    const { server } = serverWithGrace();
    openRoom(server);
    const first = join(server, "a");
    const second = join(server, "a");
    expect(first.closed).toBe(true);
    expect(second.last("joined")).toBeDefined();
    expect(server.seatsOf("ROOM")).toHaveLength(2);
    expect(server.seatsOf("ROOM")?.find((s) => s.id === "a")?.state.away).toBeUndefined();
  });

  it("skips the password check for a held seat, even after the password changed", () => {
    const { server } = serverWithGrace();
    const host = openRoom(server, "ROOM", "secret");
    const a = join(server, "a", "ROOM", "secret");
    a.link.close();
    host.say({ t: "settings", settings: {}, password: "changed" });
    expect(join(server, "a").last("joined")).toBeDefined();
  });

  it("drops events for a held seat without failing, and does not let a seat's state say it is away", () => {
    const { server } = serverWithGrace();
    const host = openRoom(server);
    const a = join(server, "a");
    a.link.close();
    host.say({ t: "ev", event: "garbage", payload: { n: 1 } });
    host.say({ t: "state", state: { away: false } });
    expect(server.seatsOf("ROOM")?.find((s) => s.id === "a")?.state.away).toBe(true);
    const mine = join(server, "b");
    mine.say({ t: "state", state: { away: true } });
    expect(server.seatsOf("ROOM")?.find((s) => s.id === "b")?.state.away).toBeUndefined();
  });

  it("lets the host kick a held seat, which ends the hold", () => {
    const { server, timers } = serverWithGrace();
    const host = openRoom(server);
    join(server, "a").link.close();
    host.say({ t: "kick", target: "a" });
    expect(server.seatsOf("ROOM")?.map((s) => s.id)).toEqual(["host"]);
    expect(timers.pending()).toBe(0);
  });

  it("ends a held seat when its player leaves on purpose or asks for another room", () => {
    const { server, timers } = serverWithGrace();
    openRoom(server, "ONE");
    const other = connect(server, "boss", "BOSS");
    other.say({ t: "create", rid: 1, room: "TWO", name: "BOSS", settings: {}, password: "" });
    join(server, "a", "ONE").link.close();
    const back = connect(server, "a", "A");
    back.say({ t: "create", rid: 1, room: "THREE", name: "A", settings: {}, password: "" });
    expect(server.seatsOf("ONE")?.map((s) => s.id)).toEqual(["host"]);
    expect(server.seatsOf("THREE")).toHaveLength(1);
    const c = join(server, "c", "ONE");
    c.link.close();
    const again = connect(server, "c", "C");
    again.say({ t: "join", rid: 1, room: "TWO", name: "C", password: "" });
    expect(server.seatsOf("ONE")?.map((s) => s.id)).toEqual(["host"]);
    expect(timers.pending()).toBe(0);
  });

  it("holds a spectator's seat as well", () => {
    const { server, timers } = serverWithGrace();
    openRoom(server);
    for (const id of ["a", "b", "c"]) join(server, id);
    const spec = join(server, "s");
    expect(server.seatsOf("ROOM")?.find((s) => s.id === "s")?.state.role).toBe("spec");
    spec.link.close();
    join(server, "s");
    expect(server.seatsOf("ROOM")?.find((s) => s.id === "s")?.state.role).toBe("spec");
    timers.advance(60_000);
    expect(server.seatsOf("ROOM")).toHaveLength(5);
  });
});

describe("reference server: proof of identity", () => {
  it("refuses a hello with no key, a malformed key, or a key that is not the id's", () => {
    const server = createReferenceServer();
    const stranger = player("b").key;
    for (const key of [undefined, "short", stranger, player("a").key.toUpperCase()]) {
      const page = connect(server);
      page.say({ ...helloFor("a"), key });
      expect(page.inbox).toEqual([{ t: "refused", reason: "identity" }]);
      expect(page.closed).toBe(true);
    }
  });

  it("does not let a page take another player's seat or push that player out", () => {
    const { server } = serverWithGrace();
    const host = openRoom(server);
    expect(host.last("created")).toBeDefined();

    const thief = connect(server);
    thief.say({ ...helloFor("thief"), id: player("host").id });
    expect(thief.inbox).toEqual([{ t: "refused", reason: "identity" }]);
    expect(thief.closed).toBe(true);

    expect(host.closed).toBe(false);
    expect(server.seatsOf("ROOM")?.map((seat) => seat.id)).toEqual(["host"]);
  });

  it("gives a page nothing before it has proved who it is", () => {
    const server = createReferenceServer();
    const page = connect(server);
    page.say({ ...helloFor("a"), key: "nonsense" });
    page.say({ t: "create", rid: 1, room: "ROOM", name: "A", settings: {}, password: "" });
    expect(server.roomCount()).toBe(0);
    expect(page.inbox).toEqual([{ t: "refused", reason: "identity" }]);
  });

  it("still lets the player's own new connection replace the old one", () => {
    const { server } = serverWithGrace();
    const first = connect(server, "a");
    const second = connect(server, "a");
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(second.last("welcome")).toBeDefined();
  });
});
