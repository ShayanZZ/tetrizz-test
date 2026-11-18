/**
 * PostgreSQL through `pg`, loaded only when this driver is chosen so a SQLite install never pays
 * for it. 64-bit integers are returned as numbers: every value stored here (times in
 * milliseconds, counts, scores) is far below 2^53.
 */
import type { Pool, PoolClient } from "pg";
import { numberPlaceholders, type Executor, type Param, type Row } from "./executor";

export interface PostgresOptions {
  url: string;
  poolMax?: number;
  /** Keeps the tables in their own schema; made if it does not exist. */
  schema?: string;
  /** Called with errors from idle connections (a database restart, for example). */
  onError?: (error: Error) => void;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const MIGRATION_LOCK_KEY = 727274;
const INT8 = 20;

type Queryable = Pick<Pool | PoolClient, "query">;

function executorOver(connection: Queryable, pool: Pool): Executor {
  const query = async (sql: string, params: readonly Param[] = []) =>
    connection.query(numberPlaceholders(sql), [...params]);
  return {
    all: async (sql, params) => (await query(sql, params)).rows as Row[],
    run: async (sql, params) => (await query(sql, params)).rowCount ?? 0,
    transaction: async (fn) => {
      if (connection !== pool) return fn(executorOver(connection, pool));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(executorOver(client, pool));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    migrationLock: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
        try {
          return await fn();
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
        }
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function openPostgres(options: PostgresOptions): Promise<Executor> {
  const { schema } = options;
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new Error(`database schema name is not allowed: ${schema}`);
  }
  const pg = (await import("pg")).default;
  const types = {
    getTypeParser: (oid: number, format?: "text" | "binary") =>
      oid === INT8
        ? (value: string) => Number(value)
        : pg.types.getTypeParser(oid, format as "text"),
  };
  if (schema !== undefined) {
    // Two servers starting together would both try to make the schema; the lock lets one do it.
    const setup = new pg.Pool({ connectionString: options.url, max: 1 });
    try {
      await setup.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      try {
        await setup.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      } finally {
        await setup.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      }
    } finally {
      await setup.end();
    }
  }
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolMax ?? 5,
    types,
    ...(schema !== undefined ? { options: `-c search_path=${schema}` } : {}),
  });
  pool.on("error", (error) => options.onError?.(error));
  return executorOver(pool, pool);
}
