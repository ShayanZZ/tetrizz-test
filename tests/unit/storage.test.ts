import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  SCHEMA_KEY,
  runStorageMigrations,
  type KeyValueStore,
  type Migration,
} from "../../apps/web/src/core/storage";

function memoryStore(
  initial: Record<string, string> = {},
): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
  };
}

describe("storage migrations", () => {
  it("renames the legacy training data once and records the schema version", () => {
    const store = memoryStore({
      tetris_training: '{"a":1}',
      tetris_mode: "training",
      tetris_session: '{"mode":"training","trainingNextGarbage":3}',
    });
    expect(runStorageMigrations(store)).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.get("tetris_practice")).toBe('{"a":1}');
    expect(store.get("tetris_training")).toBeNull();
    expect(store.get("tetris_mode")).toBe("practice");
    expect(store.get("tetris_session")).toBe('{"mode":"practice","practiceNextGarbage":3}');
    expect(store.get(SCHEMA_KEY)).toBe(String(CURRENT_SCHEMA_VERSION));
  });

  it("keeps existing practice data when both keys exist", () => {
    const store = memoryStore({ tetris_training: "old", tetris_practice: "new" });
    runStorageMigrations(store);
    expect(store.get("tetris_practice")).toBe("new");
    expect(store.get("tetris_training")).toBeNull();
  });

  it("does not run migrations that are already applied", () => {
    const store = memoryStore({
      [SCHEMA_KEY]: String(CURRENT_SCHEMA_VERSION),
      tetris_training: "late",
    });
    runStorageMigrations(store);
    expect(store.get("tetris_training")).toBe("late");
  });

  it("applies newer migrations in order and records progress after each", () => {
    const seen: number[] = [];
    const extra: Migration[] = [
      ...MIGRATIONS,
      { version: CURRENT_SCHEMA_VERSION + 1, name: "a", run: () => void seen.push(1) },
      { version: CURRENT_SCHEMA_VERSION + 2, name: "b", run: () => void seen.push(2) },
    ];
    const store = memoryStore();
    expect(runStorageMigrations(store, extra)).toBe(CURRENT_SCHEMA_VERSION + 2);
    expect(seen).toEqual([1, 2]);
  });

  it("stops at a failing migration and keeps the last good version", () => {
    const failing: Migration[] = [
      { version: 1, name: "ok", run: () => undefined },
      {
        version: 2,
        name: "bad",
        run: () => {
          throw new Error("quota");
        },
      },
    ];
    const store = memoryStore();
    expect(runStorageMigrations(store, failing)).toBe(-1);
    expect(store.get(SCHEMA_KEY)).toBe("1");
  });

  it("treats a corrupt version as zero", () => {
    const store = memoryStore({ [SCHEMA_KEY]: "abc", tetris_mode: "training" });
    runStorageMigrations(store);
    expect(store.get("tetris_mode")).toBe("practice");
  });
});
