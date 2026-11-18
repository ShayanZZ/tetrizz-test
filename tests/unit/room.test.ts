import { describe, expect, it } from "vitest";
import { createMemoryHub, createMemoryRoom, nextHostCandidate } from "@tetrizz/protocol";

const player = (id: string, role = "player") => ({
  id,
  username: id.toUpperCase(),
  state: { role, joined: 1 },
});

describe("nextHostCandidate", () => {
  it("skips the leaver and spectators and keeps seat order", () => {
    const seats = [player("a"), player("s", "spec"), player("b"), player("c")];
    expect(nextHostCandidate(seats, "a")?.id).toBe("b");
    expect(nextHostCandidate(seats, "b")?.id).toBe("a");
  });

  it("is null when nobody else is seated as a player", () => {
    expect(nextHostCandidate([player("a"), player("s", "spec")], "a")).toBeNull();
    expect(nextHostCandidate([], "a")).toBeNull();
  });

  it("treats a seat with no state as a player", () => {
    expect(
      nextHostCandidate(
        [
          { id: "a", username: "A" },
          { id: "b", username: "B" },
        ],
        "a",
      )?.id,
    ).toBe("b");
  });
});

describe("memory room", () => {
  function room() {
    const memory = createMemoryRoom(createMemoryHub());
    const host = memory.create("h", "host");
    return { memory, host };
  }
  const ids = (peer: { roster(): { id: string }[] }) => peer.roster().map((p) => p.id);

  it("seats joiners in order and shows everyone the same roster", () => {
    const { memory, host } = room();
    const g1 = memory.join("g1", "one");
    const g2 = memory.join("g2", "two");
    for (const peer of [host, g1, g2]) expect(ids(peer)).toEqual(["h", "g1", "g2"]);
    expect([host.hostId(), g1.hostId(), g2.hostId()]).toEqual(["h", "h", "h"]);
    expect(host.isHost()).toBe(true);
    expect(g1.isHost()).toBe(false);
  });

  it("carries a ready flag to every peer", () => {
    const { memory, host } = room();
    const guest = memory.join("g", "guest");
    guest.setReady(true);
    const ready = (peer: typeof host) => peer.roster().find((p) => p.id === "g")?.state?.ready;
    expect(ready(host)).toBe(true);
    expect(ready(guest)).toBe(true);
    guest.setReady(false);
    expect(ready(host)).toBe(false);
  });

  it("removes a guest who leaves and keeps the host", () => {
    const { memory, host } = room();
    const g1 = memory.join("g1", "one");
    const g2 = memory.join("g2", "two");
    g1.leave();
    expect(ids(host)).toEqual(["h", "g2"]);
    expect(ids(g2)).toEqual(["h", "g2"]);
    expect(host.isHost()).toBe(true);
  });

  it("hands the room to the next player when the host leaves", () => {
    const { memory, host } = room();
    const g1 = memory.join("g1", "one");
    const g2 = memory.join("g2", "two");
    host.leave();
    expect(g1.hostId()).toBe("g1");
    expect(g2.hostId()).toBe("g1");
    expect(g1.isHost()).toBe(true);
    expect(ids(g1)).toEqual(["g1", "g2"]);
    expect(g1.closed()).toBe(false);
    // the new host admits the next joiner and announces the roster
    const g3 = memory.join("g3", "three");
    expect(ids(g2)).toEqual(["g1", "g2", "g3"]);
    expect(ids(g3)).toEqual(["g1", "g2", "g3"]);
  });

  it("closes the room when the host leaves and only spectators remain", () => {
    const { memory, host } = room();
    const watcher = memory.join("w", "watcher", "spec");
    host.leave();
    expect(watcher.closed()).toBe(true);
    expect(watcher.hostId()).toBe("h");
    expect(host.backend.transport.isOpen()).toBe(false);
  });

  it("does not close the room when a player can take over", () => {
    const { memory, host } = room();
    const watcher = memory.join("w", "watcher", "spec");
    const guest = memory.join("g", "guest");
    host.leave();
    expect(watcher.closed()).toBe(false);
    expect(guest.isHost()).toBe(true);
    expect(watcher.hostId()).toBe("g");
  });

  it("lets the host kick a guest, who is dropped", () => {
    const { memory, host } = room();
    const g1 = memory.join("g1", "one");
    const g2 = memory.join("g2", "two");
    host.kick("g1");
    expect(g1.removed()).toBe(true);
    expect(ids(host)).toEqual(["h", "g2"]);
    expect(ids(g2)).toEqual(["h", "g2"]);
    expect(g1.backend.transport.isOpen()).toBe(false);
  });

  it("ignores a kick from a guest", () => {
    const { memory, host } = room();
    const g1 = memory.join("g1", "one");
    const g2 = memory.join("g2", "two");
    g1.kick("g2");
    expect(g2.removed()).toBe(false);
    expect(ids(host)).toEqual(["h", "g1", "g2"]);
  });
});

describe("memory room: creating and joining through the backend", () => {
  const request = (peer: { id: string }, name: string) => ({
    roomId: "MEMORY",
    myId: peer.id,
    myName: name,
    now: 1,
  });

  it("opens a room and tells a joining peer the rules, the host and the seed", async () => {
    const room = createMemoryRoom(createMemoryHub());
    const host = room.peer("h", "Host");
    const guest = room.peer("g", "Guest");
    const rules = { seed: 77, mode: "battle" };

    expect(await host.backend.create({ ...request(host, "Host"), settings: rules })).toEqual({
      ok: true,
      roomId: "MEMORY",
      hostId: "h",
    });
    expect(host.isHost()).toBe(true);

    const joined = await guest.backend.join({
      ...request(guest, "Guest"),
      password: "",
      passwordChecked: false,
    });
    expect(joined).toEqual({
      ok: true,
      roomId: "MEMORY",
      hostId: "h",
      isHost: false,
      seed: 77,
      settings: rules,
    });
    expect(guest.hostId()).toBe("h");
    expect(host.roster().map((p) => p.id)).toEqual(["h", "g"]);
    expect(guest.roster().map((p) => p.id)).toEqual(["h", "g"]);
  });

  it("does not seat a peer in a room that does not exist", async () => {
    const room = createMemoryRoom(createMemoryHub());
    const guest = room.peer("g", "Guest");
    expect(
      await guest.backend.join({
        ...request(guest, "Guest"),
        password: "",
        passwordChecked: false,
      }),
    ).toEqual({ ok: false, reason: "not-found" });
  });

  it("asks for the password of a protected room and seats the peer once it is checked", async () => {
    const room = createMemoryRoom(createMemoryHub());
    const host = room.peer("h", "Host");
    const guest = room.peer("g", "Guest");
    await host.backend.create({
      ...request(host, "Host"),
      settings: { seed: 1, pwdH: "0badf00d" },
    });

    const ask = { ...request(guest, "Guest"), password: "", passwordChecked: false };
    expect(await guest.backend.join(ask)).toEqual({
      ok: false,
      reason: "password",
      pwdH: "0badf00d",
    });
    expect(host.roster().map((p) => p.id)).toEqual(["h"]);

    expect(await guest.backend.join({ ...ask, passwordChecked: true })).toMatchObject({ ok: true });
    expect(host.roster().map((p) => p.id)).toEqual(["h", "g"]);
  });
});
