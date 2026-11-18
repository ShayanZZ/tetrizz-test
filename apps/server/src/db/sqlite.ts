/**
 * SQLite through Node's built-in `node:sqlite`: no native add-on to build or ship. One connection,
 * so statements and transactions are queued one after another; every statement is short, and the
 * purge works in small batches so that the event loop is never blocked for long.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StatementSync } from "node:sqlite";
import type { Executor, Param, Row } from "./executor";

export function openSqlite(path: string): Executor {
  // Loaded on first use, so a server that keeps no database never loads `node:sqlite` (which
  // prints an experimental-feature warning on Node 22).
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const memory = path === ":memory:";
  if (!memory) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const pageCount = Number(Object.values(db.prepare("PRAGMA page_count").get() ?? {})[0] ?? 0);
  // Must be set before the first table exists; a database made another way keeps its mode.
  if (pageCount === 0) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };

  const all = (sql: string, params: readonly Param[] = []): Row[] =>
    prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }));
  const run = (sql: string, params: readonly Param[] = []): number =>
    Number(prepare(sql).run(...params).changes);

  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => undefined);
    return result;
  };

  const inside: Executor = {
    all: async (sql, params) => all(sql, params),
    run: async (sql, params) => run(sql, params),
    transaction: (fn) => fn(inside),
    migrationLock: (fn) => fn(),
    close: async () => undefined,
  };

  return {
    all: (sql, params) => exclusive(() => all(sql, params)),
    run: (sql, params) => exclusive(() => run(sql, params)),
    transaction: (fn) =>
      exclusive(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(inside);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
    migrationLock: (fn) => fn(),
    close: () =>
      exclusive(() => {
        statements.clear();
        db.close();
      }),
  };
}
