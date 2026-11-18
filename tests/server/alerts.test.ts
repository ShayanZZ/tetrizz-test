/** The alert rules, with a notifier that only records what it is asked to send. */
import { afterEach, describe, expect, it } from "vitest";
import { createAlerts, formatDuration } from "../../apps/server/src/alerts";
import { loadConfig } from "../../apps/server/src/config";
import { openRepository, type Repository } from "../../apps/server/src/db";
import type { Notice, Notifier } from "../../apps/server/src/notifier";

const P = "aaaaaaaa-1111-4222-8333-444444444444";
const repos: Repository[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.close().catch(() => {});
});

function harness(env: Record<string, string> = {}, at = "2026-11-16T03:00:00Z") {
  const sent: Notice[] = [];
  const notifier: Notifier = {
    channels: ["telegram"],
    notify: async (n) => {
      sent.push(n);
      return true;
    },
    stats: () => ({ sent: sent.length, failed: 0, suppressed: 0 }),
    idle: async () => {},
  };
  const clock = { now: Date.parse(at) };
  const config = loadConfig({ LOG_LEVEL: "silent", ...env }).config;
  return { sent, notifier, clock, config };
}

describe("alerts", () => {
  it("sends a start notice with version, Node and database", async () => {
    const h = harness();
    const alerts = createAlerts({
      config: h.config,
      notifier: h.notifier,
      clock: () => h.clock.now,
      repository: null,
      janitor: null,
      live: () => ({ connections: 0, rooms: 0 }),
      version: "1.2.0",
    });
    await alerts.started();
    expect(h.sent[0]).toMatchObject({ kind: "restart", severity: "info" });
    expect(h.sent[0]!.lines[0]).toContain("Version 1.2.0");
    expect(h.sent[0]!.lines[0]).toContain("database off");
  });

  it("raises an error-burst notice only at the threshold, inside the window", () => {
    const h = harness({ NOTIFY_ERROR_SPIKE: "3", NOTIFY_ERROR_WINDOW_SECONDS: "60" });
    const alerts = createAlerts({
      config: h.config,
      notifier: h.notifier,
      clock: () => h.clock.now,
      repository: null,
      janitor: null,
      live: () => ({ connections: 0, rooms: 0 }),
      version: "x",
    });
    alerts.recordError();
    alerts.recordError();
    expect(h.sent).toHaveLength(0);
    h.clock.now += 61_000; // the first two fall out of the window
    alerts.recordError();
    expect(h.sent).toHaveLength(0);
    alerts.recordError();
    alerts.recordError();
    expect(h.sent.map((n) => n.kind)).toEqual(["error-spike"]);
  });

  it("turns errors off with NOTIFY_ERROR_SPIKE=0", () => {
    const h = harness({ NOTIFY_ERROR_SPIKE: "0" });
    const alerts = createAlerts({
      config: h.config,
      notifier: h.notifier,
      clock: () => h.clock.now,
      repository: null,
      janitor: null,
      live: () => ({ connections: 0, rooms: 0 }),
      version: "x",
    });
    for (let i = 0; i < 50; i++) alerts.recordError();
    expect(h.sent).toHaveLength(0);
  });

  it("alerts on a slow event loop only after two slow checks in a row", () => {
    const h = harness({ NOTIFY_LAG_MS: "200" });
    const alerts = createAlerts({
      config: h.config,
      notifier: h.notifier,
      clock: () => h.clock.now,
      repository: null,
      janitor: null,
      live: () => ({ connections: 0, rooms: 0 }),
      version: "x",
    });
    alerts.checkLag(900);
    alerts.checkLag(50);
    alerts.checkLag(900);
    expect(h.sent).toHaveLength(0);
    alerts.checkLag(800);
    expect(h.sent.map((n) => n.kind)).toEqual(["lag"]);
  });

  it("describes database and janitor failures without leaking a connection string", () => {
    const h = harness();
    const alerts = createAlerts({
      config: h.config,
      notifier: h.notifier,
      clock: () => h.clock.now,
      repository: null,
      janitor: null,
      live: () => ({ connections: 0, rooms: 0 }),
      version: "x",
    });
    alerts.dbError("api", new Error("cannot reach postgres://tetrizz:s3cret@db:5432/tz"));
    alerts.janitorFailed("settle", new Error("disk full"));
    alerts.budget({ ratio: 0.85, sizeBytes: 85 * 1048576, maxBytes: 100 * 1048576, level: 0 });
    alerts.budget({ ratio: 1.2, sizeBytes: 120 * 1048576, maxBytes: 100 * 1048576, level: 6 });
    expect(h.sent.map((n) => [n.kind, n.severity, n.key])).toEqual([
      ["db-failure", "alert", undefined],
      ["janitor-failure", "warn", "janitor-failure:settle"],
      ["budget", "warn", "budget:warn"],
      ["budget", "alert", "budget:over"],
    ]);
    expect(JSON.stringify(h.sent)).not.toContain("s3cret");
    expect(h.sent[3]!.lines[1]).toContain("cannot be cut further");
  });

  it("sends the digest of yesterday once, at the hour, and not again after a restart that day", async () => {
    const h = harness({ NOTIFY_DIGEST_HOUR_UTC: "7" }, "2026-11-16T06:30:00Z");
    const repository = await openRepository({
      driver: "sqlite",
      path: ":memory:",
      now: () => h.clock.now,
    });
    repos.push(repository);
    await repository.touchPlayer(P, Date.parse("2026-11-15T10:00:00Z"));
    await repository.recordGame({
      id: "g-000001",
      mode: "sprint",
      startedAt: Date.parse("2026-11-15T10:00:00Z"),
      durationMs: 90_000,
      players: [{ playerId: P, result: "finished", lines: 40, score: 5000, pieces: 100 }],
    });
    const make = () =>
      createAlerts({
        config: h.config,
        notifier: h.notifier,
        clock: () => h.clock.now,
        repository,
        janitor: null,
        live: () => ({ connections: 2, rooms: 1 }),
        version: "1.2.0",
      });
    const alerts = make();
    await alerts.checkDigest();
    expect(h.sent).toHaveLength(0); // before the hour
    h.clock.now = Date.parse("2026-11-16T07:01:00Z");
    await alerts.checkDigest();
    await alerts.checkDigest();
    expect(h.sent).toHaveLength(1);
    const d = h.sent[0]!;
    expect(d).toMatchObject({ kind: "digest", title: "daily digest for 2026-11-15" });
    expect(d.lines[0]).toBe("Games: 1 (sprint 1)");
    expect(d.lines[1]).toContain("1 active, 1 new");
    expect(d.lines[2]).toBe("Play time: 1 min");
    expect(d.lines[4]).toBe("Right now: 2 connections, 1 rooms");
    // A start after the hour the same day does not send it again.
    const again = make();
    await again.checkDigest();
    expect(h.sent).toHaveLength(1);
    h.clock.now += 86_400_000;
    await again.checkDigest();
    expect(h.sent).toHaveLength(2);
  });

  it("formats durations", () => {
    expect(formatDuration(5 * 60_000)).toBe("5 min");
    expect(formatDuration(125 * 60_000)).toBe("2 h 5 min");
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3 d 4 h");
  });
});
