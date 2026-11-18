/**
 * Schema migrations. Each database has its own folder of numbered `.sql` files
 * (`0001_init.sql`), bundled into the server at build time. The applied ones are recorded in
 * `schema_migrations` with a checksum, and the runner refuses to start when:
 *
 * - the database holds a migration this build does not know (it was made by a newer server), or
 * - a migration that was applied has been edited since (add a new one instead).
 */
import { createHash } from "node:crypto";
import type { Executor } from "./executor";
import type { DriverName } from "./types";

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

const FILE = /(?:^|\/)(\d{4})_([a-z0-9_]+)\.sql$/;

/** Builds the migration list from `{ path: sql }`; versions must run 1, 2, 3 with no gaps. */
export function parseMigrations(files: Record<string, string>): Migration[] {
  const found: Migration[] = [];
  for (const [path, sql] of Object.entries(files)) {
    const match = FILE.exec(path);
    if (!match) throw new MigrationError(`migration file name is not NNNN_name.sql: ${path}`);
    found.push({
      version: Number(match[1]),
      name: match[2] ?? "",
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  found.sort((a, b) => a.version - b.version);
  found.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(`migration versions must run 1, 2, 3 without gaps or repeats`);
    }
  });
  return found;
}

const sqliteFiles = import.meta.glob("./migrations/sqlite/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const postgresFiles = import.meta.glob("./migrations/postgres/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

export function bundledMigrations(driver: DriverName): Migration[] {
  return parseMigrations(driver === "sqlite" ? sqliteFiles : postgresFiles);
}

const TRACKING_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at BIGINT NOT NULL
)`;

/** Applies what is missing and returns the versions applied by this call. */
export async function migrate(
  db: Executor,
  migrations: readonly Migration[],
  now: () => number,
): Promise<number[]> {
  return db.migrationLock(async () => {
    await db.run(TRACKING_TABLE);
    const rows = await db.all("SELECT version, checksum FROM schema_migrations ORDER BY version");
    const applied = new Map(rows.map((row) => [Number(row.version), String(row.checksum)]));
    const known = new Map(migrations.map((migration) => [migration.version, migration]));
    for (const [version, checksum] of applied) {
      const migration = known.get(version);
      if (!migration) {
        throw new MigrationError(
          `the database is at migration ${version}, which this server does not know: it was made by a newer version`,
        );
      }
      if (migration.checksum !== checksum) {
        throw new MigrationError(
          `migration ${version} (${migration.name}) was edited after it was applied`,
        );
      }
    }
    const done: number[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await db.transaction(async (tx) => {
        for (const statement of splitStatements(migration.sql)) await tx.run(statement);
        await tx.run(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          [migration.version, migration.name, migration.checksum, now()],
        );
      });
      done.push(migration.version);
    }
    return done;
  });
}

/** Splits a migration at `;` at the end of a line. Migrations must not hold `;` inside strings. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((part) =>
      part
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}
