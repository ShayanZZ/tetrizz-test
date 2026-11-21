/**
 * `TelemetryStore` on IndexedDB: one object store keyed by the item's `seq`. Every call opens the
 * database on first use only; a failure to open (private mode, blocked storage) rejects the
 * calls, which the queue reports once and then carries on in memory.
 */
import type { QueueItem, TelemetryStore } from "./queue";

const DB_NAME = "tetrizz-telemetry";
const STORE = "queue";
const VERSION = 1;

const done = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

export function createIndexedDbStore(factory: IDBFactory): TelemetryStore {
  let opened: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: "seq" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB could not open"));
      request.onblocked = () => reject(new Error("IndexedDB is blocked"));
    });
    opened.catch(() => {
      opened = null;
    });
    return opened;
  };

  const inStore = async (mode: IDBTransactionMode) => {
    const db = await open();
    const tx = db.transaction(STORE, mode);
    return { tx, store: tx.objectStore(STORE) };
  };

  return {
    async load() {
      const { store } = await inStore("readonly");
      return (await done(store.getAll())) as QueueItem[];
    },
    async put(item) {
      const { tx, store } = await inStore("readwrite");
      store.put(item);
      await finished(tx);
    },
    async remove(seqs) {
      if (seqs.length === 0) return;
      const { tx, store } = await inStore("readwrite");
      for (const seq of seqs) store.delete(seq);
      await finished(tx);
    },
    async clear() {
      const { tx, store } = await inStore("readwrite");
      store.clear();
      await finished(tx);
    },
  };
}
