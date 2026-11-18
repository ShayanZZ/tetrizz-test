/**
 * The only thing the repository needs from a database driver: run a read, run a write, and run
 * several statements as one transaction. SQL is written once with `?` placeholders; the
 * PostgreSQL driver rewrites them to `$1, $2, ...`.
 */

export type Param = string | number | null;
export type Row = Record<string, unknown>;

export interface Executor {
  all(sql: string, params?: readonly Param[]): Promise<Row[]>;
  /** Runs a write and returns how many rows it changed. */
  run(sql: string, params?: readonly Param[]): Promise<number>;
  /** Runs `fn` in one transaction: committed when it returns, undone when it throws. */
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  /** Runs `fn` while no other server process is migrating the same database. */
  migrationLock<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Turns `?` placeholders into `$1, $2, ...`. The repository's SQL has no `?` inside a string. */
export function numberPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}
