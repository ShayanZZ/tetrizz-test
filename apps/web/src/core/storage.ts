import { log } from "./logger";

export const STORAGE_KEYS = [
  "tetris_adaptive",
  "tetris_arr",
  "tetris_bg",
  "tetris_bindings",
  "tetris_bindings_ver",
  "tetris_botworker",
  "tetris_blockshape",
  "tetris_blockstyle",
  "tetris_clearfx",
  "tetris_colortheme",
  "tetris_das",
  "tetris_fx",
  "tetris_gestures",
  "tetris_ghost",
  "tetris_ghostOpacity",
  "tetris_grid",
  "tetris_ipop",
  "tetris_lastroom",
  "tetris_loglevel",
  "tetris_mode",
  "tetris_motion",
  "tetris_mouse",
  "tetris_mousesteer",
  "tetris_muted",
  "tetris_olself",
  "tetris_online_backend",
  "tetris_pkey",
  "tetris_practice",
  "tetris_replays",
  "tetris_schema",
  "tetris_scores",
  "tetris_sdf",
  "tetris_session",
  "tetris_swipe",
  "tetris_swipesens",
  "tetris_telemetry",
  "tetris_telemetry_todo",
  "tetris_theme",
  "tetris_touch_order",
  "tetris_touch_presets",
  "tetris_touchbtns",
  "tetris_username",
  "tetris_vol",
  "tetris_vsbot",
] as const;

export type StorageKey = (typeof STORAGE_KEYS)[number];

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Thin pass-through: errors (quota, blocked storage) reach the caller exactly as with the raw API. */
export const storage: KeyValueStore = {
  get: (key) => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  remove: (key) => localStorage.removeItem(key),
};

/** Per-tab storage, used for the player id that must differ between tabs. */
export const tabStorage: Pick<KeyValueStore, "get" | "set"> = {
  get: (key) => sessionStorage.getItem(key),
  set: (key, value) => sessionStorage.setItem(key, value),
};

export const SCHEMA_KEY: StorageKey = "tetris_schema";

export interface Migration {
  readonly version: number;
  readonly name: string;
  run(store: KeyValueStore): void;
}

function renameTrainingToPractice(store: KeyValueStore): void {
  const legacy = store.get("tetris_training");
  if (legacy !== null) {
    if (store.get("tetris_practice") === null) store.set("tetris_practice", legacy);
    store.remove("tetris_training");
  }
  if (store.get("tetris_mode") === "training") store.set("tetris_mode", "practice");
  for (const key of ["tetris_session", "tetris_replays", "tetris_scores"]) {
    const value = store.get(key);
    if (value && (value.includes('"training"') || value.includes('"trainingNextGarbage"'))) {
      store.set(
        key,
        value
          .split('"training"')
          .join('"practice"')
          .split('"trainingNextGarbage"')
          .join('"practiceNextGarbage"'),
      );
    }
  }
}

/** Ordered by version. Append new entries; never edit or reorder shipped ones. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "rename training to practice", run: renameTrainingToPractice },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

function readVersion(store: KeyValueStore): number {
  const raw = store.get(SCHEMA_KEY);
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Applies every migration newer than the stored schema version and records progress after each one. */
export function runStorageMigrations(
  store: KeyValueStore = storage,
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  try {
    let current = readVersion(store);
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      migration.run(store);
      store.set(SCHEMA_KEY, String(migration.version));
      current = migration.version;
    }
    return current;
  } catch (error) {
    log.warn("storage.migrate", error);
    return -1;
  }
}
