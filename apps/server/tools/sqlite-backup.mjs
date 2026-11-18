/**
 * Takes a consistent snapshot of the server's SQLite database while the server is running, or
 * checks a database file. It runs inside the server container (see scripts/backup.sh).
 *
 *   node tools/sqlite-backup.mjs <out-file>      snapshot of $SQLITE_PATH (default /data/sqlite/tetrizz.db)
 *   node tools/sqlite-backup.mjs --check <file>  integrity check of a database file
 *
 * The snapshot is made with VACUUM INTO: one read transaction, so the copy is consistent even
 * while the server writes, and it comes out compacted. The copy is opened again and checked
 * before the tool reports success. Exit code 0 only when the file is a sound database.
 */
import { existsSync, statSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_PATH = "/data/sqlite/tetrizz.db";

function fail(message) {
  console.error(`sqlite-backup: ${message}`);
  process.exit(1);
}

function check(file) {
  if (!existsSync(file)) fail(`${file} does not exist`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all();
    const verdict = rows.map((row) => Object.values(row)[0]).join("; ");
    if (verdict !== "ok") fail(`integrity check failed: ${verdict}`);
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get();
    if (!tables || Number(tables.n) === 0) fail("the database has no tables");
    const migrations = db
      .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'schema_migrations'")
      .get();
    if (!migrations || Number(migrations.n) === 0)
      fail("not a TetriZZ database (no schema_migrations)");
  } finally {
    db.close();
  }
}

const args = process.argv.slice(2);
if (args[0] === "--check") {
  if (!args[1]) fail("usage: sqlite-backup.mjs --check <file>");
  check(args[1]);
  console.error(`sqlite-backup: ${args[1]} is sound`);
} else {
  const out = args[0];
  if (!out || out.startsWith("-")) fail("usage: sqlite-backup.mjs <out-file> | --check <file>");
  const source = process.env.SQLITE_PATH?.trim() || DEFAULT_PATH;
  if (!existsSync(source)) fail(`no database at ${source}`);
  if (existsSync(out)) {
    // mktemp creates an empty file; VACUUM INTO refuses to write over anything that exists.
    if (statSync(out).size > 0) fail(`${out} already holds data`);
    unlinkSync(out);
  }
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA busy_timeout = 15000");
    db.prepare("VACUUM INTO ?").run(out);
  } finally {
    db.close();
  }
  check(out);
  console.error(`sqlite-backup: wrote ${out} (${statSync(out).size} bytes)`);
}
