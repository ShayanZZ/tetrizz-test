/**
 * The telemetry queue: everything the page has noted but the server has not yet confirmed.
 *
 * Items are kept in memory and written to a `TelemetryStore` (IndexedDB in the page) so a closed
 * tab or an offline stretch loses nothing. The queue is capped; when it is full the least useful
 * items go first: performance samples, then other events, then history lines, then games, oldest
 * first inside each group. A store that fails never stops the game: the queue goes on in memory
 * and the failure is reported once.
 */
import type { TelemetryEvent } from "@tetrizz/protocol";

export type QueueKind = "event" | "game" | "history";

export interface QueueItem {
  /** Position in the queue; grows for ever, never reused. */
  seq: number;
  kind: QueueKind;
  /** The id the page made up for the item; the server dedupes by it. */
  id: string;
  /** Length of the item as JSON text, for the byte cap. */
  size: number;
  value: unknown;
}

export interface TelemetryStore {
  load(): Promise<QueueItem[]>;
  put(item: QueueItem): Promise<void>;
  remove(seqs: readonly number[]): Promise<void>;
  clear(): Promise<void>;
}

export interface QueueLimits {
  maxItems: number;
  maxBytes: number;
  /** An item larger than this is not queued. */
  maxItemBytes: number;
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  maxItems: 1000,
  maxBytes: 1_000_000,
  maxItemBytes: 8192,
};

export interface TakeLimits {
  events: number;
  games: number;
  history: number;
  /** Stop adding items once the batch would pass this many bytes of JSON. */
  bytes: number;
}

export interface TelemetryQueue {
  /** Loads what an earlier page left in the store. Call once, before anything else. */
  load(): Promise<void>;
  /** Queues an item. Returns false when it was too large to keep. */
  add(kind: QueueKind, id: string, value: unknown): boolean;
  /** The oldest items that fit `limits`, in queue order. Nothing is removed. */
  take(limits: TakeLimits): QueueItem[];
  remove(items: readonly QueueItem[]): void;
  clear(): void;
  size(): number;
  bytes(): number;
}

/** A store that keeps items in memory only; the fallback when IndexedDB is not there. */
export function createMemoryStore(): TelemetryStore {
  const items = new Map<number, QueueItem>();
  return {
    load: () => Promise.resolve([...items.values()]),
    put: (item) => {
      items.set(item.seq, item);
      return Promise.resolve();
    },
    remove: (seqs) => {
      for (const seq of seqs) items.delete(seq);
      return Promise.resolve();
    },
    clear: () => {
      items.clear();
      return Promise.resolve();
    },
  };
}

/** How soon an item is dropped when the queue is full: lower goes first. */
function dropRank(item: QueueItem): number {
  if (item.kind === "event") {
    return (item.value as Partial<TelemetryEvent>).kind === "perf_sample" ? 0 : 1;
  }
  return item.kind === "history" ? 2 : 3;
}

export function createQueue(
  store: TelemetryStore,
  limits: QueueLimits,
  warn: (scope: string, error: unknown) => void,
): TelemetryQueue {
  let items: QueueItem[] = [];
  let nextSeq = 1;
  let total = 0;
  let storeFailed = false;
  let loaded = false;
  const held: Array<{ kind: QueueKind; id: string; value: unknown }> = [];

  const guard = (work: Promise<void>): void => {
    work.catch((error: unknown) => {
      if (storeFailed) return;
      storeFailed = true;
      warn("telemetry/queue.store", error);
    });
  };

  const sizeOf = (value: unknown): number => {
    try {
      return JSON.stringify(value)?.length ?? 0;
    } catch {
      return 0;
    }
  };

  const evict = (): void => {
    if (items.length <= limits.maxItems && total <= limits.maxBytes) return;
    const order = items
      .map((item) => ({ item, rank: dropRank(item) }))
      .sort((a, b) => a.rank - b.rank || a.item.seq - b.item.seq);
    const dropped: QueueItem[] = [];
    let count = items.length;
    let bytes = total;
    for (const { item } of order) {
      if (count <= limits.maxItems && bytes <= limits.maxBytes) break;
      dropped.push(item);
      count--;
      bytes -= item.size;
    }
    const gone = new Set(dropped.map((item) => item.seq));
    items = items.filter((item) => !gone.has(item.seq));
    total = bytes;
    guard(store.remove(dropped.map((item) => item.seq)));
  };

  const add: TelemetryQueue["add"] = (kind, id, value) => {
    const size = sizeOf(value);
    if (size === 0 || size > limits.maxItemBytes) return false;
    if (!loaded) {
      held.push({ kind, id, value });
      return true;
    }
    const item: QueueItem = { seq: nextSeq++, kind, id, size, value };
    items.push(item);
    total += size;
    guard(store.put(item));
    evict();
    return true;
  };

  return {
    async load() {
      if (loaded) return;
      try {
        const stored = await store.load();
        for (const item of stored) {
          items.push(item);
          total += item.size;
        }
        items.sort((a, b) => a.seq - b.seq);
        nextSeq = items.reduce((max, item) => Math.max(max, item.seq), nextSeq - 1) + 1;
        evict();
      } catch (error) {
        warn("telemetry/queue.load", error);
      }
      loaded = true;
      for (const entry of held.splice(0)) add(entry.kind, entry.id, entry.value);
    },

    add,

    take(limit) {
      const out: QueueItem[] = [];
      const count = { event: 0, game: 0, history: 0 };
      const max = { event: limit.events, game: limit.games, history: limit.history };
      let bytes = 0;
      for (const item of items) {
        if (count[item.kind] >= max[item.kind]) continue;
        if (out.length > 0 && bytes + item.size > limit.bytes) break;
        out.push(item);
        count[item.kind]++;
        bytes += item.size;
      }
      return out;
    },

    remove(done) {
      if (done.length === 0) return;
      const gone = new Set(done.map((item) => item.seq));
      items = items.filter((item) => {
        if (!gone.has(item.seq)) return true;
        total -= item.size;
        return false;
      });
      guard(store.remove(done.map((item) => item.seq)));
    },

    clear() {
      items = [];
      total = 0;
      guard(store.clear());
    },

    size: () => items.length,
    bytes: () => total,
  };
}
