import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createIndexedDbStore } from "../../apps/web/src/telemetry/idb-store";
import {
  createMemoryStore,
  createQueue,
  type QueueItem,
  type QueueLimits,
  type TelemetryStore,
} from "../../apps/web/src/telemetry/queue";

const LIMITS: QueueLimits = { maxItems: 5, maxBytes: 10_000, maxItemBytes: 500 };
const TAKE = { events: 100, games: 100, history: 100, bytes: 100_000 };
const noWarn = () => {};

const ev = (kind: string, n: number) => ({ id: `id-${n}`, kind, at: n });

describe("telemetry queue", () => {
  it("keeps items in order and hands out the oldest first", async () => {
    const queue = createQueue(createMemoryStore(), LIMITS, noWarn);
    await queue.load();
    queue.add("event", "a", ev("app_start", 1));
    queue.add("game", "b", { id: "b" });
    queue.add("event", "c", ev("game_start", 3));
    const taken = queue.take(TAKE);
    expect(taken.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(queue.size()).toBe(3);
  });

  it("limits each kind and the bytes of a batch", async () => {
    const queue = createQueue(createMemoryStore(), { ...LIMITS, maxItems: 50 }, noWarn);
    await queue.load();
    for (let i = 0; i < 6; i++) queue.add("event", `e${i}`, ev("game_start", i));
    queue.add("game", "g", { id: "g" });
    expect(queue.take({ ...TAKE, events: 2 }).map((item) => item.id)).toEqual(["e0", "e1", "g"]);
    const one = queue.take({ ...TAKE, bytes: 1 });
    expect(one).toHaveLength(1);
  });

  it("drops performance samples first, then events, then history, then games", async () => {
    const queue = createQueue(createMemoryStore(), LIMITS, noWarn);
    await queue.load();
    queue.add("game", "g1", { id: "g1" });
    queue.add("history", "h1", { id: "h1" });
    queue.add("event", "x1", ev("game_start", 1));
    queue.add("event", "p1", ev("perf_sample", 2));
    queue.add("event", "p2", ev("perf_sample", 3));
    expect(queue.size()).toBe(5);
    queue.add("event", "x2", ev("game_start", 4));
    expect(queue.take(TAKE).map((item) => item.id)).not.toContain("p1");
    queue.add("event", "x3", ev("game_start", 5));
    expect(queue.take(TAKE).map((item) => item.id)).not.toContain("p2");
    queue.add("event", "x4", ev("game_start", 6));
    expect(queue.take(TAKE).map((item) => item.id)).not.toContain("x1");
    queue.add("event", "x5", ev("game_start", 7));
    queue.add("event", "x6", ev("game_start", 8));
    queue.add("event", "x7", ev("game_start", 9));
    const left = queue.take(TAKE).map((item) => item.id);
    expect(left).toContain("g1");
    expect(queue.size()).toBe(5);
  });

  it("enforces the byte cap and refuses an oversized item", async () => {
    const queue = createQueue(
      createMemoryStore(),
      { maxItems: 100, maxBytes: 300, maxItemBytes: 200 },
      noWarn,
    );
    await queue.load();
    expect(queue.add("event", "big", { pad: "x".repeat(400) })).toBe(false);
    for (let i = 0; i < 20; i++) queue.add("event", `e${i}`, { pad: "x".repeat(60) });
    expect(queue.bytes()).toBeLessThanOrEqual(300);
    expect(queue.size()).toBeLessThan(20);
  });

  it("removes confirmed items and clears everything", async () => {
    const store = createMemoryStore();
    const queue = createQueue(store, LIMITS, noWarn);
    await queue.load();
    queue.add("event", "a", ev("app_start", 1));
    queue.add("event", "b", ev("app_start", 2));
    queue.remove(queue.take(TAKE).slice(0, 1));
    await Promise.resolve();
    expect((await store.load()).map((item) => item.id)).toEqual(["b"]);
    queue.clear();
    await Promise.resolve();
    expect(queue.size()).toBe(0);
    expect(await store.load()).toEqual([]);
  });

  it("loads what an earlier page left and continues the numbering", async () => {
    const store = createMemoryStore();
    const first = createQueue(store, LIMITS, noWarn);
    await first.load();
    first.add("event", "a", ev("app_start", 1));
    first.add("event", "b", ev("app_start", 2));
    await Promise.resolve();
    const second = createQueue(store, LIMITS, noWarn);
    second.add("event", "c", ev("app_start", 3));
    await second.load();
    expect(second.take(TAKE).map((item) => item.id)).toEqual(["a", "b", "c"]);
    const seqs = second.take(TAKE).map((item) => item.seq);
    expect(new Set(seqs).size).toBe(3);
  });

  it("goes on in memory, warning once, when the store fails", async () => {
    const warnings: string[] = [];
    const broken: TelemetryStore = {
      load: () => Promise.reject(new Error("no")),
      put: () => Promise.reject(new Error("no")),
      remove: () => Promise.reject(new Error("no")),
      clear: () => Promise.reject(new Error("no")),
    };
    const queue = createQueue(broken, LIMITS, (scope) => warnings.push(scope));
    await queue.load();
    queue.add("event", "a", ev("app_start", 1));
    queue.add("event", "b", ev("app_start", 2));
    queue.clear();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.size()).toBe(0);
    expect(warnings.filter((scope) => scope === "telemetry/queue.store")).toHaveLength(1);
  });
});

describe("telemetry IndexedDB store", () => {
  it("keeps items between two opens of the same database", async () => {
    const item = (seq: number): QueueItem => ({
      seq,
      kind: "event",
      id: `e${seq}`,
      size: 10,
      value: { n: seq },
    });
    const first = createIndexedDbStore(indexedDB);
    await first.put(item(2));
    await first.put(item(1));
    await first.put(item(3));
    const second = createIndexedDbStore(indexedDB);
    expect((await second.load()).map((i) => i.seq).sort()).toEqual([1, 2, 3]);
    await second.remove([1, 3]);
    expect((await first.load()).map((i) => i.seq)).toEqual([2]);
    await first.clear();
    expect(await second.load()).toEqual([]);
  });

  it("rejects when the database cannot be opened", async () => {
    const factory = {
      open() {
        const request: Partial<IDBOpenDBRequest> = {};
        setTimeout(() => request.onerror?.(new Event("error")), 0);
        return request as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
    await expect(createIndexedDbStore(factory).load()).rejects.toThrow();
  });
});
