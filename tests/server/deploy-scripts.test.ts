/**
 * scripts/backup.sh and scripts/restore.sh against a real SQLite database, with a stand-in for
 * `docker compose` that runs the in-container commands on this machine. It tests the scripts' own
 * logic (snapshot, checks, rotation, ordering of stop and start, refusals), not Docker itself;
 * the docker job in CI runs the same scripts against real containers.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRepository } from "../../apps/server/src/db";

const REPO = join(__dirname, "..", "..");
const runnable = process.platform === "linux" && spawnSync("bash", ["--version"]).status === 0;

/** `docker compose ...` on this machine: exec and run execute the command in apps/server with SQLITE_PATH set. */
const FAKE_DOCKER = `#!/usr/bin/env bash
set -u
[ "$1" = compose ] && shift
sub=$1; shift
echo "$sub $*" >> "$FAKE_LOG"
case $sub in
  config) printf 'server\\ncaddy\\n'; [ -n "\${FAKE_POSTGRES:-}" ] && echo postgres; exit 0 ;;
  exec)
    while [[ $1 == -* ]]; do shift; done
    shift
    cd "$FAKE_APP" && SQLITE_PATH="$FAKE_DB" exec "$@" ;;
  run)
    entry=sh
    while [[ $1 == -* ]]; do
      if [ "$1" = --entrypoint ]; then entry=$2; shift; fi
      shift
    done
    shift
    cd "$FAKE_APP" && SQLITE_PATH="$FAKE_DB" exec "$entry" "$@" ;;
  ps) echo "running healthy"; exit 0 ;;
  stop|up) exit 0 ;;
  *) exit 0 ;;
esac
`;

describe.skipIf(!runnable)("backup and restore scripts", () => {
  let work: string;
  let db: string;
  let backups: string;
  let log: string;

  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}`,
    FAKE_LOG: log,
    FAKE_APP: join(REPO, "apps", "server"),
    FAKE_DB: db,
    BACKUP_DIR: backups,
    BACKUP_KEEP_DAILY: "7",
    BACKUP_KEEP_WEEKLY: "4",
    BACKUP_RCLONE_REMOTE: "",
    ...extra,
  });
  const run = (
    script: string,
    args: string[] = [],
    extra: Record<string, string> = {},
    input?: string,
  ) =>
    spawnSync("bash", [join(REPO, "scripts", script), ...args], {
      env: env(extra),
      encoding: "utf8",
      ...(input !== undefined ? { input } : {}),
    });

  const rows = (file: string): string[] => {
    const d = new DatabaseSync(file, { readOnly: true });
    try {
      return d
        .prepare("SELECT v FROM marker ORDER BY v")
        .all()
        .map((r) => String(r.v));
    } finally {
      d.close();
    }
  };
  const daily = () => readdirSync(join(backups, "daily")).sort();

  beforeEach(async () => {
    work = mkdtempSync(join(tmpdir(), "tetrizz-scripts-"));
    mkdirSync(join(work, "bin"));
    writeFileSync(join(work, "bin", "docker"), FAKE_DOCKER);
    chmodSync(join(work, "bin", "docker"), 0o755);
    db = join(work, "data", "tetrizz.db");
    mkdirSync(join(work, "data"));
    backups = join(work, "backups");
    log = join(work, "docker.log");
    writeFileSync(log, "");
    const repo = await openRepository({ driver: "sqlite", path: db });
    await repo.close();
    const d = new DatabaseSync(db);
    d.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('one'), ('two');");
    d.close();
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("makes a sound, compressed copy of a live database and a weekly copy", () => {
    const r = run("backup.sh");
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const files = daily();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^tetrizz-sqlite-\d{8}-\d{6}\.db\.gz$/);
    expect(readdirSync(join(backups, "weekly"))).toEqual(files);
    const copy = join(work, "copy.db");
    writeFileSync(copy, gunzipSync(readFileSync(join(backups, "daily", files[0]!))));
    expect(rows(copy)).toEqual(["one", "two"]);
    expect(readdirSync(backups).filter((f) => f.startsWith(".partial"))).toEqual([]);
  });

  it("keeps only the newest copies and adds no weekly copy when a recent one exists", () => {
    mkdirSync(join(backups, "daily"), { recursive: true });
    mkdirSync(join(backups, "weekly"), { recursive: true });
    const old = ["20260101-010101", "20260102-010101", "20260103-010101", "20260104-010101"];
    old.forEach((stamp, i) => {
      const file = join(backups, "daily", `tetrizz-sqlite-${stamp}.db.gz`);
      writeFileSync(file, "x");
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      utimesSync(file, t, t);
    });
    writeFileSync(join(backups, "weekly", "tetrizz-sqlite-20261110-010101.db.gz"), "x"); // fresh mtime
    const r = run("backup.sh", [], { BACKUP_KEEP_DAILY: "3" });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const files = daily();
    expect(files).toHaveLength(3);
    expect(files).not.toContain("tetrizz-sqlite-20260101-010101.db.gz");
    expect(files).not.toContain("tetrizz-sqlite-20260102-010101.db.gz");
    expect(files).toContain("tetrizz-sqlite-20260104-010101.db.gz");
    expect(readdirSync(join(backups, "weekly"))).toEqual(["tetrizz-sqlite-20261110-010101.db.gz"]);
  });

  it("fails and leaves nothing behind when there is no database", () => {
    rmSync(db);
    const r = run("backup.sh");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/snapshot failed/);
    expect(daily()).toEqual([]);
    expect(readdirSync(backups).filter((f) => f.startsWith(".partial"))).toEqual([]);
    expect(readdirSync(join(work, "data")).filter((f) => f.startsWith(".backup-"))).toEqual([]);
  });

  it("rejects settings that make no sense", () => {
    const r = run("backup.sh", [], { BACKUP_KEEP_DAILY: "0" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/BACKUP_KEEP_DAILY/);
  });

  describe("restore", () => {
    const makeBackup = () => {
      const r = run("backup.sh");
      expect(r.status, r.stderr).toBe(0);
      return join(backups, "daily", daily()[0]!);
    };
    const change = () => {
      const d = new DatabaseSync(db);
      d.exec("INSERT INTO marker VALUES ('three'); DELETE FROM marker WHERE v = 'one';");
      d.close();
    };
    const dockerCalls = () => readFileSync(log, "utf8").trim().split("\n");

    it("puts the copy back, keeps the old file aside and stops the server first", () => {
      const file = makeBackup();
      change();
      expect(rows(db)).toEqual(["three", "two"]);
      writeFileSync(log, "");
      const r = run("restore.sh", ["--yes", file]);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(rows(db)).toEqual(["one", "two"]);
      expect(
        readdirSync(join(work, "data")).filter((f) => f.includes("before-restore")),
      ).toHaveLength(1);
      expect(existsSync(`${db}.restoring`)).toBe(false);
      const calls = dockerCalls();
      const stop = calls.findIndex((c) => c.startsWith("stop server"));
      const start = calls.findIndex((c) => c.startsWith("up -d server"));
      expect(stop).toBeGreaterThanOrEqual(0);
      expect(start).toBeGreaterThan(stop);
    });

    it("refuses a damaged file before touching anything", () => {
      const file = makeBackup();
      change();
      truncateSync(file, 30);
      writeFileSync(log, "");
      const r = run("restore.sh", ["--yes", file]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/damaged/);
      expect(rows(db)).toEqual(["three", "two"]);
      expect(dockerCalls().filter((c) => c.startsWith("stop"))).toEqual([]);
    });

    it("refuses a file that is not a database and leaves the live one alone", () => {
      change();
      writeFileSync(join(work, "junk.db"), "not a database\n");
      expect(spawnSync("gzip", ["-f", join(work, "junk.db")]).status).toBe(0);
      const junk = join(work, "junk.db.gz");
      const r = run("restore.sh", ["--yes", junk]);
      expect(r.status).not.toBe(0);
      expect(rows(db)).toEqual(["three", "two"]);
      expect(readdirSync(join(work, "data")).filter((f) => f.endsWith(".restoring"))).toEqual([]);
    });

    it("refuses a PostgreSQL dump while the stack uses SQLite", () => {
      const dump = join(work, "tetrizz-postgres-20261117-031700.dump");
      writeFileSync(dump, "PGDMP");
      const r = run("restore.sh", ["--yes", dump]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/postgres backup but the stack is set up for sqlite/);
    });

    it("asks first and does nothing unless RESTORE is typed", () => {
      const file = makeBackup();
      change();
      writeFileSync(log, "");
      const no = run("restore.sh", [file], {}, "yes\n");
      expect(no.status).not.toBe(0);
      expect(no.stderr).toMatch(/cancelled/);
      expect(rows(db)).toEqual(["three", "two"]);
      expect(dockerCalls().filter((c) => c.startsWith("stop"))).toEqual([]);
      const yes = run("restore.sh", [file], {}, "RESTORE\n");
      expect(yes.status, yes.stderr).toBe(0);
      expect(rows(db)).toEqual(["one", "two"]);
    });
  });
});
