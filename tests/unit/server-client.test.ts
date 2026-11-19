import { describe, expect, it } from "vitest";
import {
  createReferenceServer,
  playerIdFromKey,
  PROTOCOL_VERSION,
  type ReferenceServer,
  type RoomBackend,
} from "@tetrizz/protocol";
import {
  createServerRoom,
  SERVER_LEAVE_DELAY_MS,
} from "../../apps/web/src/net/backends/server-room";
import {
  CONNECT_TIMEOUT_MS,
  createServerSocket,
  REQUEST_TIMEOUT_MS,
  serverSocketUrl,
  type SocketLike,
} from "../../apps/web/src/net/server-socket";
import { createServerTransport } from "../../apps/web/src/net/transports/server-transport";
import { fromWire, player as testPlayer, toWire } from "../helpers/identity";

/** Timers that run only when the test says so. */
function fakeTimers() {
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

function toServer(data: string): string {
  const message = JSON.parse(data) as Record<string, unknown>;
  if (message.t === "hello" && typeof message.id === "string") {
    const who = testPlayer(message.id);
    return JSON.stringify({ ...message, id: who.id, key: who.key });
  }
  return JSON.stringify(toWire(message));
}

/**
 * A WebSocket whose other end is the reference server; frames arrive on a microtask. The tests name
 * their players ("a", "b"); by default the wire carries their ids and keys, as `helpers/identity.ts`
 * explains, and the hello a page sends is completed with the named player's real key. `raw` leaves
 * every frame exactly as the page wrote it.
 */
function serverSocketFor(server: ReferenceServer, raw = false): SocketLike {
  const socket: SocketLike = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => link.receive(raw ? data : toServer(data)),
    close: () => link.close(),
  };
  const link = server.connect(
    (text) => queueMicrotask(() => socket.onmessage?.({ data: raw ? text : fromWire(text) })),
    () =>
      queueMicrotask(() => {
        (socket as { readyState: number }).readyState = 3;
        socket.onclose?.();
      }),
  );
  queueMicrotask(() => {
    (socket as { readyState: number }).readyState = 1;
    socket.onopen?.();
  });
  return socket;
}

function newClient(server: ReferenceServer, timers = fakeTimers()) {
  const warnings: string[] = [];
  const socket = createServerSocket({
    url: () => "ws://test/ws",
    createSocket: () => serverSocketFor(server),
    later: timers.later,
    appVersion: "test",
    key: () => "",
    warn: (scope) => warnings.push(scope),
  });
  return { socket, timers, warnings };
}

/** A page's whole client stack against one server. */
function player(server: ReferenceServer, id: string, name = id.toUpperCase()) {
  const { socket, timers } = newClient(server);
  const events: Array<[string, unknown]> = [];
  const transport = createServerTransport({ socket, myId: () => id });
  transport.onMessage((event, payload) => events.push([event, payload]));
  const later: Array<() => void> = [];
  const backend: RoomBackend = createServerRoom({
    socket,
    transport,
    later: (task) => void later.push(task),
  });
  const base = { myId: id, myName: name, now: 1 };
  return { socket, timers, transport, backend, events, later, base };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("serverSocketUrl", () => {
  it("turns the configured address into the socket address", () => {
    expect(serverSocketUrl("https://play.example.org", "https://x")).toBe(
      "wss://play.example.org/ws",
    );
    expect(serverSocketUrl("http://localhost:8080/", "https://x")).toBe("ws://localhost:8080/ws");
    expect(serverSocketUrl("wss://a.example/base/", "https://x")).toBe("wss://a.example/base/ws");
    expect(serverSocketUrl("/tetrizz", "https://page.example")).toBe(
      "wss://page.example/tetrizz/ws",
    );
    expect(serverSocketUrl("https://a.example/p?x=1#h", "https://x")).toBe("wss://a.example/p/ws");
  });
});

describe("server socket", () => {
  it("connects, and answers requests by id", async () => {
    const server = createReferenceServer();
    const { socket } = newClient(server);
    expect(await socket.connect({ id: "a", name: "A" })).toBe("ok");
    expect(socket.isOpen()).toBe(true);
    const created = await socket.request({
      t: "create",
      room: "R1",
      name: "A",
      settings: { seed: 1 },
      password: "",
    });
    expect(created).toMatchObject({ t: "created", room: "R1", host: "a" });
    const refused = await socket.request({ t: "join", room: "NOPE", name: "A", password: "" });
    expect(refused).toMatchObject({ t: "refused", reason: "busy" });
  });

  it("hands everything that is not an answer to its listeners", async () => {
    const server = createReferenceServer();
    const a = newClient(server).socket;
    const b = newClient(server).socket;
    await a.connect({ id: "a", name: "A" });
    await b.connect({ id: "b", name: "B" });
    const heard: string[] = [];
    b.onMessage((m) => heard.push(m.t));
    await a.request({ t: "create", room: "R", name: "A", settings: {}, password: "" });
    await b.request({ t: "join", room: "R", name: "B", password: "" });
    a.send({ t: "ev", event: "state", payload: 1 });
    await settled();
    expect(heard).toEqual(["roster", "ev"]);
  });

  it("is told by a server that speaks another protocol, and gives up", async () => {
    const server = createReferenceServer();
    const timers = fakeTimers();
    const sock = createServerSocket({
      url: () => "ws://t",
      createSocket: () => {
        const s = serverSocketFor(server);
        const send = s.send.bind(s);
        s.send = (data) =>
          send(data.replace(`"v":${PROTOCOL_VERSION}`, `"v":${PROTOCOL_VERSION + 1}`));
        return s;
      },
      later: timers.later,
      appVersion: "t",
      key: () => "",
      warn: () => {},
    });
    expect(await sock.connect({ id: "a", name: "A" })).toBe("version");
    expect(sock.isOpen()).toBe(false);
  });

  it("sends its key in hello, and reports a refused identity as that, not as an unreachable server", async () => {
    const server = createReferenceServer();
    const timers = fakeTimers();
    const warnings: string[] = [];
    const sent: string[] = [];
    const make = (key: string) =>
      createServerSocket({
        url: () => "ws://test/ws",
        createSocket: () => {
          const socket = serverSocketFor(server, true);
          const send = socket.send;
          socket.send = (data) => {
            sent.push(data);
            send(data);
          };
          return socket;
        },
        later: timers.later,
        appVersion: "test",
        key: () => key,
        warn: (scope) => warnings.push(scope),
      });

    const key = "0123456789abcdef".repeat(4);
    const id = playerIdFromKey(key);
    expect(await make(key).connect({ id, name: "A" })).toBe("ok");
    expect(JSON.parse(sent[0]!)).toMatchObject({ t: "hello", id, key, name: "A" });

    expect(await make("f".repeat(64)).connect({ id, name: "A" })).toBe("identity");
    expect(await make("").connect({ id, name: "A" })).toBe("identity");
    expect(warnings).toEqual(["net/server-socket.identity", "net/server-socket.identity"]);
  });

  it("is unreachable when the socket never opens, errors, or cannot be made", async () => {
    const timers = fakeTimers();
    const deaf: SocketLike = {
      readyState: 0,
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const slow = createServerSocket({
      url: () => "ws://t",
      createSocket: () => deaf,
      later: timers.later,
      appVersion: "t",
      key: () => "",
      warn: () => {},
    });
    const waiting = slow.connect({ id: "a", name: "A" });
    timers.advance(CONNECT_TIMEOUT_MS);
    expect(await waiting).toBe("unreachable");

    const failing: SocketLike = { ...deaf };
    const errored = createServerSocket({
      url: () => "ws://t",
      createSocket: () => failing,
      later: timers.later,
      appVersion: "t",
      key: () => "",
      warn: () => {},
    });
    const pending = errored.connect({ id: "a", name: "A" });
    failing.onerror?.();
    expect(await pending).toBe("unreachable");

    const warned: string[] = [];
    const broken = createServerSocket({
      url: () => "ws://t",
      createSocket: () => {
        throw new Error("blocked");
      },
      later: timers.later,
      appVersion: "t",
      key: () => "",
      warn: (scope) => warned.push(scope),
    });
    expect(await broken.connect({ id: "a", name: "A" })).toBe("unreachable");
    expect(warned).toEqual(["net/server-socket.connect"]);
    expect(timers.pending()).toBe(0);
  });

  it("fails a request that gets no answer, and ones in flight when the connection ends", async () => {
    const server = createReferenceServer();
    const { socket, timers } = newClient(server);
    await socket.connect({ id: "a", name: "A" });
    const quiet = socket.request({ t: "join", room: "R", name: "A", password: "" });
    const answered = await quiet;
    expect(answered.t).toBe("refused");

    const mute = createServerSocket({
      url: () => "ws://t",
      createSocket: () => {
        const s = serverSocketFor(createReferenceServer());
        const send = s.send.bind(s);
        s.send = (data) => (data.includes('"t":"hello"') ? send(data) : undefined);
        return s;
      },
      later: timers.later,
      appVersion: "t",
      key: () => "",
      warn: () => {},
    });
    await mute.connect({ id: "m", name: "M" });
    const silent = mute.request({ t: "join", room: "R", name: "M", password: "" });
    timers.advance(REQUEST_TIMEOUT_MS);
    expect(await silent).toEqual({ t: "lost", reason: "timeout" });

    const inFlight = mute.request({ t: "join", room: "R", name: "M", password: "" });
    mute.close();
    expect(await inFlight).toEqual({ t: "lost", reason: "closed" });
  });

  it("tells its listeners when an established connection ends, and not a failed attempt", async () => {
    const server = createReferenceServer();
    const { socket } = newClient(server);
    let closes = 0;
    socket.onClose(() => closes++);
    await socket.connect({ id: "a", name: "A" });
    socket.close();
    socket.close();
    expect(closes).toBe(1);
    expect(socket.isOpen()).toBe(false);
    socket.send({ t: "leave" });
    expect(await socket.request({ t: "join", room: "R", name: "A", password: "" })).toEqual({
      t: "lost",
      reason: "closed",
    });

    const failing = createServerSocket({
      url: () => "ws://t",
      createSocket: () => {
        throw new Error("no");
      },
      later: fakeTimers().later,
      appVersion: "t",
      key: () => "",
      warn: () => {},
    });
    failing.onClose(() => closes++);
    await failing.connect({ id: "b", name: "B" });
    expect(closes).toBe(1);
  });

  it("drops a server-side close into the close listeners", async () => {
    const server = createReferenceServer();
    const a = newClient(server).socket;
    let closed = false;
    a.onClose(() => (closed = true));
    await a.connect({ id: "same", name: "A" });
    await newClient(server).socket.connect({ id: "same", name: "A2" });
    await settled();
    expect(closed).toBe(true);
  });
});

describe("server transport", () => {
  it("sends events as `ev`, and the host's settings as `settings`", async () => {
    const server = createReferenceServer();
    const host = player(server, "host");
    const guest = player(server, "guest");
    await host.backend.create({ ...host.base, roomId: "R", settings: { seed: 3 } });
    await guest.backend.join({ ...guest.base, roomId: "R", password: "", passwordChecked: false });
    host.transport.send("attack", { n: 2 });
    host.transport.send("settings", { rounds: 5 });
    await settled();
    expect(guest.events.filter(([e]) => e === "attack" || e === "settings")).toEqual([
      ["attack", { n: 2 }],
      ["settings", { rounds: 5, seed: 3 }],
    ]);
  });

  it("turns the server's announcements into the events the game knows", async () => {
    const server = createReferenceServer();
    const host = player(server, "host");
    const a = player(server, "a");
    const b = player(server, "b");
    await host.backend.create({ ...host.base, roomId: "R", settings: {} });
    await a.backend.join({ ...a.base, roomId: "R", password: "", passwordChecked: false });
    await b.backend.join({ ...b.base, roomId: "R", password: "", passwordChecked: false });
    await settled();
    expect(a.events.at(-1)?.[0]).toBe("roster");
    host.backend.kick({ roomId: "R", myId: "host", targetId: "a" });
    host.backend.setHost({ roomId: "R", myId: "host", newHost: "b" });
    await settled();
    expect(a.events.at(-1)).toEqual(["kick", { target: "a" }]);
    expect(b.events.filter(([e]) => e === "host-xfer")).toEqual([
      ["host-xfer", { newHost: "b", from: "" }],
    ]);
    b.backend.leave({
      roomId: "R",
      myId: "b",
      myName: "B",
      isHost: true,
      announce: true,
      players: [],
    });
    await settled();
    expect(server.seatsOf("R")?.map((p) => fromWire(p.id))).toEqual(["host"]);
    expect(host.events.at(-2)).toEqual(["host-xfer", { newHost: "host", from: "" }]);
  });

  it("reports closed rooms and stops listening once closed", async () => {
    const server = createReferenceServer();
    const host = player(server, "host");
    const spec = player(server, "spec");
    await host.backend.create({ ...host.base, roomId: "R", settings: {} });
    await spec.backend.join({ ...spec.base, roomId: "R", password: "", passwordChecked: false });
    spec.backend.saveMyState({ myId: "spec", state: { role: "spec" } });
    await settled();
    host.backend.leave({
      roomId: "R",
      myId: "host",
      myName: "H",
      isHost: true,
      announce: false,
      players: [],
    });
    await settled();
    expect(spec.events.at(-1)).toEqual(["closed", {}]);
    const count = spec.events.length;
    spec.transport.close();
    spec.transport.send("attack", {});
    expect(spec.transport.isOpen()).toBe(false);
    expect(spec.events.length).toBe(count);
  });
});

describe("server room backend", () => {
  it("creates a room and joins it, with the rules, seed and host", async () => {
    const server = createReferenceServer();
    const host = player(server, "host", "HOST");
    const guest = player(server, "guest", "GUEST");
    expect(
      await host.backend.create({ ...host.base, roomId: "ABCD", settings: { seed: 9, rounds: 2 } }),
    ).toEqual({
      ok: true,
      roomId: "ABCD",
      hostId: "host",
    });
    expect(
      await guest.backend.join({
        ...guest.base,
        roomId: "abcd",
        password: "",
        passwordChecked: false,
      }),
    ).toEqual({
      ok: true,
      roomId: "ABCD",
      hostId: "host",
      isHost: false,
      seed: 9,
      settings: { seed: 9, rounds: 2 },
    });
  });

  it("maps every refusal to the reason the lobby shows", async () => {
    const server = createReferenceServer();
    const host = player(server, "host");
    await host.backend.create({ ...host.base, roomId: "LOCK", settings: {}, password: "pw" });
    const join = (id: string, room: string, password: string) => {
      const p = player(server, id);
      return p.backend.join({ ...p.base, roomId: room, password, passwordChecked: false });
    };
    expect(await join("a", "NONE", "")).toEqual({ ok: false, reason: "not-found" });
    expect(await join("b", "LOCK", "")).toEqual({ ok: false, reason: "password" });
    expect(await join("c", "LOCK", "bad")).toEqual({
      ok: false,
      reason: "password",
      wrongPassword: true,
    });
    expect((await join("d", "LOCK", "pw")).ok).toBe(true);
    const again = player(server, "e");
    expect(await again.backend.create({ ...again.base, roomId: "lock", settings: {} })).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("says unreachable or version when there is no usable server", async () => {
    const timers = fakeTimers();
    const dead = createServerSocket({
      url: () => "ws://t",
      createSocket: () => {
        throw new Error("down");
      },
      later: timers.later,
      appVersion: "t",
      key: () => "",
      warn: () => {},
    });
    const transport = createServerTransport({ socket: dead, myId: () => "a" });
    const backend = createServerRoom({ socket: dead, transport, later: () => {} });
    const base = { myId: "a", myName: "A", now: 1 };
    expect(
      await backend.join({ ...base, roomId: "R", password: "", passwordChecked: false }),
    ).toEqual({ ok: false, reason: "unreachable" });
    expect(await backend.create({ ...base, roomId: "R", settings: {} })).toEqual({
      ok: false,
      reason: "failed",
    });

    const server = createReferenceServer();
    const old = createServerSocket({
      url: () => "ws://t",
      createSocket: () => {
        const s = serverSocketFor(server);
        const send = s.send.bind(s);
        s.send = (data) =>
          send(data.replace(`"v":${PROTOCOL_VERSION}`, `"v":${PROTOCOL_VERSION + 1}`));
        return s;
      },
      later: timers.later,
      appVersion: "t",
      key: () => "",
      warn: () => {},
    });
    const oldBackend = createServerRoom({
      socket: old,
      transport: createServerTransport({ socket: old, myId: () => "a" }),
      later: () => {},
    });
    expect(
      await oldBackend.join({ ...base, roomId: "R", password: "", passwordChecked: false }),
    ).toEqual({ ok: false, reason: "version" });
  });

  it("leaves with a goodbye and closes the connection after a short delay", async () => {
    const server = createReferenceServer();
    const host = player(server, "host");
    const guest = player(server, "guest", "GUEST");
    await host.backend.create({ ...host.base, roomId: "R", settings: {} });
    await guest.backend.join({ ...guest.base, roomId: "R", password: "", passwordChecked: false });
    guest.backend.leave({
      roomId: "R",
      myId: "guest",
      myName: "GUEST",
      isHost: false,
      announce: true,
      players: [],
    });
    await settled();
    expect(host.events.filter(([e]) => e === "left")).toEqual([
      ["left", { sender: "guest", name: "GUEST" }],
    ]);
    expect(server.seatsOf("R")?.map((p) => fromWire(p.id))).toEqual(["host"]);
    expect(guest.socket.isOpen()).toBe(true);
    expect(guest.later).toHaveLength(1);
    guest.later[0]?.();
    expect(guest.socket.isOpen()).toBe(false);
    expect(SERVER_LEAVE_DELAY_MS).toBeGreaterThan(0);
  });

  it("does nothing when asked to leave with no room, and drops without a goodbye", async () => {
    const server = createReferenceServer();
    const a = player(server, "a");
    a.backend.leave({
      roomId: null,
      myId: "a",
      myName: "A",
      isHost: false,
      announce: true,
      players: [],
    });
    expect(a.later).toHaveLength(0);
    await a.backend.create({ ...a.base, roomId: "R", settings: {} });
    a.backend.drop({ roomId: "R", myId: "a" });
    await settled();
    expect(a.socket.isOpen()).toBe(false);
    expect(server.seatsOf("R")?.[0]?.state.away).toBe(true);
  });

  it("saves a seat's state, sending an empty one for a state that is not an object", async () => {
    const server = createReferenceServer();
    const a = player(server, "a");
    await a.backend.create({ ...a.base, roomId: "R", settings: {} });
    a.backend.saveMyState({ myId: "a", state: { ready: true, role: "player", joined: 5 } });
    a.backend.saveMyState({ myId: "a", state: null });
    await settled();
    expect(server.seatsOf("R")?.[0]?.state).toMatchObject({ ready: true, role: "player" });
  });
});
