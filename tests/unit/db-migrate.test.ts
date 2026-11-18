import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dayOf, dayStart, isDay } from "../../apps/server/src/db/days";
import { numberPlaceholders } from "../../apps/server/src/db/executor";
import {
  MigrationError,
  bundledMigrations,
  migrate,
  parseMigrations,
  splitStatements,
} from "../../apps/server/src/db/migrate";
import { openSqlite } from "../../apps/server/src/db/sqlite";
import type { Executor } from "../../apps/server/src/db/executor";

const opened: Executor[] = [];
const memory = (): Executor => {
  const db = openSqlite(":memory:");
  opened.push(db);
  return db;
};
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

const clock = () => 42;
const files = (...sql: string[]) =>
  Object.fromEntries(
    sql.map((text, i) => [`./m/${String(i + 1).padStart(4, "0")}_step${i + 1}.sql`, text]),
  );

describe("parseMigrations", () => {
  it("orders by version and gives each a checksum", () => {
    const list = parseMigrations({ "./b/0002_second.sql": "B", "./b/0001_first.sql": "A" });
    expect(list.map((m) => [m.version, m.name])).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
    expect(list[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(list[0]?.checksum).not.toBe(list[1]?.checksum);
  });

  it("refuses gaps, repeats and bad names", () => {
    expect(() => parseMigrations({ "./0002_x.sql": "" })).toThrow(MigrationError);
    expect(() => parseMigrations({ "./a/0001_x.sql": "", "./b/0001_y.sql": "" })).toThrow(
      MigrationError,
    );
    expect(() => parseMigrations({ "./init.sql": "" })).toThrow(/NNNN_name/);
  });
});

describe("splitStatements", () => {
  it("splits at a semicolon ending a line and drops comments and blanks", () => {
    expect(
      splitStatements(
        "-- head\nCREATE TABLE a (x INTEGER);\n\n-- more\nCREATE INDEX i ON a (x);\n",
      ),
    ).toEqual(["CREATE TABLE a (x INTEGER)", "CREATE INDEX i ON a (x)"]);
  });
  it("keeps a statement that spans lines together", () => {
    expect(splitStatements("CREATE TABLE a (\n  x INTEGER,\n  y TEXT\n);")).toEqual([
      "CREATE TABLE a (\n  x INTEGER,\n  y TEXT\n)",
    ]);
  });
});

describe("migrate", () => {
  it("applies in order, records them, and a second run applies nothing", async () => {
    const db = memory();
    const list = parseMigrations(
      files("CREATE TABLE a (x INTEGER);", "CREATE TABLE b (y INTEGER);"),
    );
    expect(await migrate(db, list, clock)).toEqual([1, 2]);
    expect(await migrate(db, list, clock)).toEqual([]);
    const rows = await db.all(
      "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
    );
    expect(rows).toEqual([
      { version: 1, name: "step1", applied_at: 42 },
      { version: 2, name: "step2", applied_at: 42 },
    ]);
  });

  it("applies only the new ones after an upgrade", async () => {
    const db = memory();
    await migrate(db, parseMigrations(files("CREATE TABLE a (x INTEGER);")), clock);
    const next = parseMigrations(
      files("CREATE TABLE a (x INTEGER);", "CREATE TABLE b (y INTEGER);"),
    );
    expect(await migrate(db, next, clock)).toEqual([2]);
  });

  it("refuses a migration that was edited after it was applied", async () => {
    const db = memory();
    await migrate(db, parseMigrations(files("CREATE TABLE a (x INTEGER);")), clock);
    await expect(
      migrate(db, parseMigrations(files("CREATE TABLE a (x TEXT);")), clock),
    ).rejects.toThrow(/edited/);
  });

  it("refuses a database made by a newer server", async () => {
    const db = memory();
    await migrate(
      db,
      parseMigrations(files("CREATE TABLE a (x INTEGER);", "CREATE TABLE b (y INTEGER);")),
      clock,
    );
    await expect(
      migrate(db, parseMigrations(files("CREATE TABLE a (x INTEGER);")), clock),
    ).rejects.toThrow(/newer version/);
  });

  it("undoes a migration that fails halfway and keeps the earlier ones", async () => {
    const db = memory();
    const good = parseMigrations(files("CREATE TABLE a (x INTEGER);"));
    await migrate(db, good, clock);
    const broken = parseMigrations(
      files("CREATE TABLE a (x INTEGER);", "CREATE TABLE b (y INTEGER);\nCREATE TABLE nope (;"),
    );
    await expect(migrate(db, broken, clock)).rejects.toThrow();
    expect(await db.all("SELECT name FROM sqlite_master WHERE name = 'b'")).toEqual([]);
    expect((await db.all("SELECT version FROM schema_migrations")).length).toBe(1);
  });
});

describe("the bundled migrations", () => {
  it("run in both dialects with the same versions and names", () => {
    const lite = bundledMigrations("sqlite").map((m) => [m.version, m.name]);
    const server = bundledMigrations("postgres").map((m) => [m.version, m.name]);
    expect(lite.length).toBeGreaterThan(0);
    expect(server).toEqual(lite);
  });

  it("make the same tables and columns in both dialects", () => {
    const shape = (sql: string) => {
      const tables: Record<string, string[]> = {};
      for (const match of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\)/g)) {
        tables[match[1] ?? ""] = (match[2] ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !/^(PRIMARY|--)/.test(line))
          .map((line) => line.split(/\s+/)[0] ?? "");
      }
      return tables;
    };
    for (const [a, b] of bundledMigrations("sqlite").map(
      (m, i) => [m, bundledMigrations("postgres")[i]] as const,
    )) {
      expect(Object.keys(shape(a.sql)).length).toBeGreaterThan(5);
      expect(shape(b?.sql ?? "")).toEqual(shape(a.sql));
    }
  });
});

describe("the SQLite connection", () => {
  it("is set up for a server: WAL, foreign keys on, incremental vacuum on a new file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tetrizz-sqlite-"));
    const db = openSqlite(join(dir, "a", "b.db"));
    try {
      const one = async (pragma: string) =>
        Object.values((await db.all(`PRAGMA ${pragma}`))[0] ?? {})[0];
      expect(await one("journal_mode")).toBe("wal");
      expect(await one("foreign_keys")).toBe(1);
      expect(await one("auto_vacuum")).toBe(2);
      expect(await one("busy_timeout")).toBe(5000);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queues a transaction behind another instead of nesting it", async () => {
    const db = memory();
    await db.run("CREATE TABLE t (x INTEGER)");
    const slow = db.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES (1)");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await tx.run("INSERT INTO t VALUES (2)");
    });
    const second = db.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES (3)");
    });
    await Promise.all([slow, second]);
    expect((await db.all("SELECT x FROM t ORDER BY rowid")).map((r) => r.x)).toEqual([1, 2, 3]);
  });

  it("rolls back when the transaction throws", async () => {
    const db = memory();
    await db.run("CREATE TABLE t (x INTEGER)");
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO t VALUES (1)");
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(await db.all("SELECT x FROM t")).toEqual([]);
    await db.run("INSERT INTO t VALUES (2)");
    expect(await db.all("SELECT x FROM t")).toEqual([{ x: 2 }]);
  });
});

describe("helpers", () => {
  it("numbers placeholders for PostgreSQL", () => {
    expect(numberPlaceholders("SELECT ? , ? WHERE a = ?")).toBe("SELECT $1 , $2 WHERE a = $3");
  });
  it("days are UTC dates", () => {
    const d = Date.parse("2026-11-10T00:00:00Z");
    expect(dayOf(d)).toBe("2026-11-10");
    expect(dayOf(d - 1)).toBe("2026-11-09");
    expect(dayStart("2026-11-10")).toBe(d);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-2-3")).toBe(false);
    expect(() => dayStart("nope")).toThrow(RangeError);
  });
});
