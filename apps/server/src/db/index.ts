/** Opens the database: connects, applies migrations and returns the repository. */
import { migrate, bundledMigrations } from "./migrate";
import { createRepository } from "./repository";
import { openSqlite } from "./sqlite";
import { openPostgres } from "./postgres";
import type { Repository } from "./types";

export type DatabaseOptions = { now?: () => number } & (
  | { driver: "sqlite"; path: string }
  | {
      driver: "postgres";
      url: string;
      poolMax?: number;
      schema?: string;
      onError?: (e: Error) => void;
    }
);

export async function openRepository(options: DatabaseOptions): Promise<Repository> {
  const now = options.now ?? Date.now;
  const db =
    options.driver === "sqlite"
      ? openSqlite(options.path)
      : await openPostgres({
          url: options.url,
          ...(options.poolMax !== undefined ? { poolMax: options.poolMax } : {}),
          ...(options.schema !== undefined ? { schema: options.schema } : {}),
          ...(options.onError !== undefined ? { onError: options.onError } : {}),
        });
  try {
    await migrate(db, bundledMigrations(options.driver), now);
  } catch (error) {
    await db.close();
    throw error;
  }
  return createRepository({ driver: options.driver, db, now });
}

export type { Repository } from "./types";
export * from "./types";
export { MigrationError } from "./migrate";
