/**
 * The real server on a real port, spoken to with real WebSocket clients (the `ws` package, which
 * lets a test choose the Origin header). The room rules themselves are covered by
 * server-protocol.test.ts against the model; these tests cover what the server adds around it:
 * sockets, timers, scrypt, origin, limits, heartbeats and shutdown.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createServerApp, type ServerApp } from "../../apps/server/src/app";
import { loadConfig, type ServerConfig } from "../../apps/server/src/config";

type Msg = Record<string, unknown> & { t: string };

class Client {
  readonly frames: string[] = [];
  readonly messages: Msg[] = [];
  closed: { code: number; reason: string } | null = null;
  private wake: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data: Buffer) => {
      const text = data.toString("utf8");
      this.frames.push(text);
      this.messages.push(JSON.parse(text) as Msg);
      this.notify();
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.closed = { code, reason: reason.toString() };
      this.notify();
    });
    ws.on("error", () => {});
  }

  /** Opens a socket; rejects with the HTTP status when the handshake is refused. */
  static open(
    port: number,
    options: { origin?: string | null; autoPong?: boolean } = {},
  ): Promise<Client> {
    const origin = options.origin === undefined ? `http://127.0.0.1:${port}` : options.origin;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        ...(origin === null ? {} : { origin }),
        ...(options.autoPong === false ? { autoPong: false } : {}),
      });
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
      });
      ws.on("error", () => {});
      ws.on("open", () => resolve(new Client(ws)));
    });
  }

  private notify(): void {
    const waiting = this.wake;
    this.wake = [];
    for (const fn of waiting) fn();
  }

  send(message: object | string): void {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  /** Waits until `check` returns something, rechecking on every frame, close and every 20 ms. */
  async until<T>(check: () => T | undefined | false, ms = 3000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise<void>((resolve) => {
        this.wake.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  }

  /** Takes the first unread message of kind `t` (that passes `where`) out of the inbox. */
  async take(t: string, where: (m: Msg) => boolean = () => true, ms = 3000): Promise<Msg> {
    return this.until(() => {
      const i = this.messages.findIndex((m) => m.t === t && where(m));
      return i < 0 ? undefined : this.messages.splice(i, 1)[0];
    }, ms);
  }

  async closedWith(ms = 3000): Promise<{ code: number; reason: string }> {
    return this.until(() => this.closed, ms);
  }

  async hello(id: string, name = id, v = 1): Promise<Msg> {
    this.send({ t: "hello", v, app: "test", id, name });
    return this.take("welcome");
  }

  async create(room: string, id: string, password = ""): Promise<Msg> {
    this.send({ t: "create", rid: 1, room, name: id, settings: { seed: 7 }, password });
    return this.take("created");
  }

  async join(room: string, password = ""): Promise<Msg> {
    this.send({ t: "join", rid: 2, room, name: "guest", password });
    return this.take("joined");
  }

  close(): void {
    this.ws.terminate();
  }
}

const baseConfig = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  ...loadConfig({ LOG_LEVEL: "silent", PORT: "0" }).config,
  seatGraceMs: 400,
  heartbeatMs: 60_000,
  statsLogMs: 0,
  ...over,
});

const apps: ServerApp[] = [];
const clients: Client[] = [];

async function start(over: Partial<ServerConfig> = {}): Promise<{ app: ServerApp; port: number }> {
  const app = await createServerApp(baseConfig(over));
  apps.push(app);
  return { app, port: await app.listen() };
}

async function connect(
  port: number,
  id: string,
  options: { origin?: string | null; autoPong?: boolean } = {},
): Promise<Client> {
  const client = await Client.open(port, options);
  clients.push(client);
  await client.hello(id);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const app of apps.splice(0)) await app.shutdown().catch(() => {});
});

describe("own server: sockets", () => {
  it("answers health checks and tells a page how long it holds a seat", async () => {
    const { port } = await start({ seatGraceMs: 12_000 });
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/nowhere`)).status).toBe(404);
    const client = await Client.open(port);
    clients.push(client);
    client.send({ t: "hello", v: 1, app: "test", id: "p1", name: "p1" });
    expect(await client.take("welcome")).toMatchObject({ v: 1, grace: 12 });
  });

  it("makes rooms and relays events between two real connections", async () => {
    const { port, app } = await start();
    const a = await connect(port, "A");
    const b = await connect(port, "B");
    expect(await a.create("ab12", "A")).toMatchObject({ room: "AB12", host: "A" });
    const joined = await b.join("ab12");
    expect(joined).toMatchObject({ room: "AB12", host: "A", isHost: false });
    expect(typeof joined.seed).toBe("number");
    await a.take("roster", (m) => (m.players as unknown[]).length === 2);
    a.send({ t: "ev", event: "attack", payload: { lines: 4 } });
    expect(await b.take("ev")).toMatchObject({ from: "A", event: "attack", payload: { lines: 4 } });
    b.send({ t: "ev", event: "state", payload: { n: 1 } });
    expect(await a.take("ev")).toMatchObject({ from: "B", event: "state" });
    // Nobody hears their own event.
    await new Promise((r) => setTimeout(r, 80));
    expect(a.messages.filter((m) => m.t === "ev")).toHaveLength(0);
    expect(app.stats()).toMatchObject({ connections: 2, rooms: 1, accepted: 2 });
  });

  it("keeps a password as a hash: wrong and missing ones are refused, the right one gets in, and it is never sent out", async () => {
    const { port } = await start();
    const host = await connect(port, "H");
    await host.create("pw1", "H", "s3cret-pw");
    const guest = await connect(port, "G");
    guest.send({ t: "join", rid: 5, room: "pw1", name: "g", password: "" });
    expect(await guest.take("refused")).toMatchObject({ rid: 5, reason: "password" });
    guest.send({ t: "join", rid: 6, room: "pw1", name: "g", password: "nope" });
    expect(await guest.take("refused")).toMatchObject({ rid: 6, reason: "wrong-password" });
    await guest.join("pw1", "s3cret-pw");
    host.send({ t: "settings", settings: { speed: 3 } });
    await guest.take("ev", (m) => m.event === "settings");
    for (const client of [host, guest]) {
      expect(client.frames.join("\n")).not.toContain("s3cret-pw");
    }
  });

  it("lets the host change and remove the password", async () => {
    const { port } = await start();
    const host = await connect(port, "H");
    await host.create("pw2", "H", "first");
    host.send({ t: "settings", settings: {}, password: "second" });
    const late = await connect(port, "L");
    late.send({ t: "join", rid: 3, room: "pw2", name: "l", password: "first" });
    expect(await late.take("refused")).toMatchObject({ reason: "wrong-password" });
    await late.join("pw2", "second");
    host.send({ t: "settings", settings: {}, password: "" });
    const free = await connect(port, "F");
    await free.join("pw2");
  });

  it("hands the room to the guest when the host's socket ends, and tells it who is host", async () => {
    const { port } = await start({ seatGraceMs: 0 });
    const a = await connect(port, "A");
    const b = await connect(port, "B");
    await a.create("hand", "A");
    await b.join("hand");
    a.close();
    expect(await b.take("host")).toMatchObject({ host: "B" });
    const roster = await b.take(
      "roster",
      (m) => m.host === "B" && (m.players as unknown[]).length === 1,
    );
    expect(roster.players).toHaveLength(1);
  });

  it("kicks a seat and tells the player", async () => {
    const { port } = await start();
    const a = await connect(port, "A");
    const b = await connect(port, "B");
    await a.create("kick", "A");
    await b.join("kick");
    a.send({ t: "kick", target: "B" });
    await b.take("kicked");
    await a.take("roster", (m) => (m.players as unknown[]).length === 1);
  });
});

describe("own server: seat hold with real timers", () => {
  const seatOf = (m: Msg, id: string) =>
    (
      m.players as Array<{ id: string; state: { away?: boolean; ready?: boolean; role: string } }>
    ).find((p) => p.id === id);

  it("marks a dropped player away and gives the seat back to the same player id", async () => {
    const { port } = await start({ seatGraceMs: 2000 });
    const a = await connect(port, "A");
    const b = await connect(port, "B");
    await a.create("hold", "A");
    await b.join("hold");
    b.send({ t: "state", state: { ready: true } });
    // Wait until the server has it: a socket ended right after a send can lose the frame.
    await a.take("roster", (m) => seatOf(m, "B")?.state.ready === true);
    b.close();
    await a.take("roster", (m) => seatOf(m, "B")?.state.away === true);
    const b2 = await connect(port, "B");
    expect(await b2.join("hold")).toMatchObject({ isHost: false });
    // Rosters from before the drop are still in A's inbox, so match on ready and not away.
    const back = await a.take(
      "roster",
      (m) => seatOf(m, "B")?.state.ready === true && seatOf(m, "B")?.state.away === undefined,
    );
    expect(seatOf(back, "B")?.state).toMatchObject({ role: "player", ready: true });
  });

  it("lets a returning host be host again", async () => {
    const { port } = await start({ seatGraceMs: 2000 });
    const a = await connect(port, "A");
    const b = await connect(port, "B");
    await a.create("hosthold", "A");
    await b.join("hosthold");
    a.close();
    await b.take("roster", (m) => seatOf(m, "A")?.state.away === true);
    const a2 = await connect(port, "A");
    expect(await a2.join("hosthold")).toMatchObject({ isHost: true, host: "A" });
  });

  it("ends the hold when the time runs out and hands the room on", async () => {
    const { port } = await start({ seatGraceMs: 300 });
    const a = await connect(port, "A");
    const b = await connect(port, "B");
    await a.create("expire", "A");
    await b.join("expire");
    a.close();
    expect(await b.take("host", () => true, 2000)).toMatchObject({ host: "B" });
    await b.take("roster", (m) => !seatOf(m, "A") && m.host === "B");
    const late = await connect(port, "A");
    expect(await late.join("expire")).toMatchObject({ isHost: false, host: "B" });
  });
});

describe("own server: who may connect", () => {
  it("refuses a handshake from an origin that is not allowed, before the upgrade", async () => {
    const { port, app } = await start();
    await expect(Client.open(port, { origin: "https://evil.example" })).rejects.toThrow("HTTP 403");
    await expect(Client.open(port, { origin: null })).rejects.toThrow("HTTP 403");
    await expect(Client.open(port, { origin: "null" })).rejects.toThrow("HTTP 403");
    expect(app.stats().refused.origin).toBe(3);
    expect(app.stats().connections).toBe(0);
  });

  it("accepts listed origins, the page's own host, and null or missing only when switched on", async () => {
    const { port } = await start({
      origins: {
        allowed: new Set(["https://play.example"]),
        allowSameOrigin: true,
        allowFile: true,
        allowMissing: true,
      },
    });
    for (const origin of ["https://play.example", `http://127.0.0.1:${port}`, "null", null]) {
      const client = await Client.open(port, { origin });
      clients.push(client);
      client.close();
    }
    await expect(Client.open(port, { origin: "https://other.example" })).rejects.toThrow(
      "HTTP 403",
    );
  });

  it("closes the connections beyond the cap per address, and beyond the total", async () => {
    const perIp = await start({ maxConnectionsPerIp: 2 });
    const c1 = await connect(perIp.port, "p1");
    await connect(perIp.port, "p2");
    const c3 = await Client.open(perIp.port);
    clients.push(c3);
    expect(await c3.closedWith()).toMatchObject({ code: 1013, reason: "per-ip" });
    c1.close();
    await perIp.app.fastify.ready();
    await new Promise((r) => setTimeout(r, 80));
    await connect(perIp.port, "p4");

    const total = await start({ maxConnections: 1 });
    await connect(total.port, "t1");
    const extra = await Client.open(total.port);
    clients.push(extra);
    expect(await extra.closedWith()).toMatchObject({ code: 1013, reason: "total" });
    expect(total.app.stats().refused.total).toBe(1);
  });

  it("limits how fast one address may connect", async () => {
    const { port, app } = await start({ connectsPerMinutePerIp: 3 });
    for (let i = 0; i < 3; i++) {
      const client = await Client.open(port);
      client.close();
    }
    const fourth = await Client.open(port);
    clients.push(fourth);
    expect(await fourth.closedWith()).toMatchObject({ code: 1013, reason: "rate" });
    expect(app.stats().refused.rate).toBe(1);
  });
});

describe("own server: what a connection may send", () => {
  it("refuses a version it cannot serve and then closes", async () => {
    const { port } = await start();
    const client = await Client.open(port);
    clients.push(client);
    client.send({ t: "hello", v: 99, app: "test", id: "x", name: "x" });
    expect(await client.take("refused")).toMatchObject({ reason: "version" });
    await client.closedWith();
  });

  it("closes a connection that sends something that is not a protocol message", async () => {
    const { port } = await start();
    const client = await Client.open(port);
    clients.push(client);
    client.send("this is not json");
    expect((await client.closedWith()).code).toBe(1000);
  });

  it("closes a frame over 64 KB with 1009", async () => {
    const { port } = await start();
    const client = await connect(port, "big");
    client.send(JSON.stringify({ t: "ev", event: "x", payload: "a".repeat(70 * 1024) }));
    expect((await client.closedWith()).code).toBe(1009);
  });

  it("closes a binary frame with 1003", async () => {
    const { port, app } = await start();
    const client = await connect(port, "bin");
    client.ws.send(Buffer.from([1, 2, 3]));
    expect((await client.closedWith()).code).toBe(1003);
    expect(app.stats().closed.binary).toBe(1);
  });

  it("drops messages over the budget and cuts a connection that keeps flooding", async () => {
    const { port, app } = await start({ messagesPerSecond: 1, messageBurst: 5 });
    const client = await connect(port, "flood");
    for (let i = 0; i < 400; i++) client.send({ t: "ev", event: "noise" });
    expect(await client.closedWith()).toMatchObject({ code: 1008, reason: "too many messages" });
    expect(app.stats().messagesDropped).toBeGreaterThan(150);
    expect(app.stats().closed.flood).toBe(1);
  });

  it("does not drop ordinary play: ten state messages a second for several seconds", async () => {
    const { port, app } = await start();
    const a = await connect(port, "A");
    const b = await connect(port, "B");
    await a.create("play", "A");
    await b.join("play");
    for (let i = 0; i < 40; i++) {
      a.send({ t: "ev", event: "state", payload: { i } });
      await new Promise((r) => setTimeout(r, 25));
    }
    await b.until(() => b.messages.filter((m) => m.t === "ev").length >= 40);
    expect(app.stats().messagesDropped).toBe(0);
  });

  it("limits password checks per address and answers `busy` instead of hashing without end", async () => {
    const { port, app } = await start({ passwordBurst: 2, passwordChecksPerMinute: 1 });
    const host = await connect(port, "H");
    await host.create("budget", "H", "right"); // check 1 of 2
    const guest = await connect(port, "G");
    guest.send({ t: "join", rid: 1, room: "budget", name: "g", password: "wrong" }); // check 2
    expect(await guest.take("refused")).toMatchObject({ rid: 1, reason: "wrong-password" });
    guest.send({ t: "join", rid: 2, room: "budget", name: "g", password: "right" });
    expect(await guest.take("refused")).toMatchObject({ rid: 2, reason: "busy" });
    expect(app.stats().passwordLimited).toBe(1);
    // Without a password there is nothing to hash, so nothing is limited.
    const open = await connect(port, "O");
    await open.create("nopw", "O");
  });
});

describe("own server: silent and slow connections", () => {
  it("cuts a connection that does not answer pings, and keeps one that does", async () => {
    const { port, app } = await start({ heartbeatMs: 100 });
    const quiet = await connect(port, "quiet", { autoPong: false });
    const alive = await connect(port, "alive");
    await quiet.closedWith(2000);
    expect(app.stats().closed.heartbeat).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive.closed).toBeNull();
    expect(app.stats().connections).toBe(1);
  });

  it("cuts a connection that never says hello", async () => {
    const { port, app } = await start({ helloTimeoutMs: 150 });
    const idle = await Client.open(port);
    clients.push(idle);
    await idle.closedWith(2000);
    expect(app.stats().closed.hello).toBe(1);
  });

  it("cuts a page that stops reading instead of buffering for it without end", async () => {
    const { port, app } = await start({
      maxBufferedBytes: 64 * 1024,
      messagesPerSecond: 100_000,
      messageBurst: 100_000,
    });
    const a = await connect(port, "A");
    const slow = await connect(port, "S");
    await a.create("slow", "A");
    await slow.join("slow");
    (slow.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const chunk = "x".repeat(8 * 1024);
    for (let i = 0; i < 6000 && app.stats().closed.slowReader === 0; i++) {
      a.send({ t: "ev", event: "fill", payload: chunk });
      if (i % 50 === 0) await new Promise((r) => setTimeout(r, 5));
    }
    await a.until(() => app.stats().closed.slowReader > 0, 5000);
    expect(app.stats().closed.slowReader).toBe(1);
    expect(a.closed).toBeNull();
  });
});

describe("own server: stopping", () => {
  it("tells every page it is going away and ends cleanly", async () => {
    const { port, app } = await start();
    const a = await connect(port, "A");
    const b = await connect(port, "B");
    await a.create("bye", "A");
    await b.join("bye");
    const stopping = app.shutdown();
    expect(await a.closedWith()).toMatchObject({ code: 1001 });
    expect(await b.closedWith()).toMatchObject({ code: 1001 });
    await stopping;
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});
