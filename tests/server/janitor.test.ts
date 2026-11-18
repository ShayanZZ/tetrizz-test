/** The janitor against a real in-memory SQLite database and a clock the test moves. */
import { afterEach, describe, expect, it } from "vitest";
import { DAY_MS, dayOf } from "../../apps/server/src/db/days";
import { openRepository, type Repository } from "../../apps/server/src/db";
import { createJanitor, type Janitor } from "../../apps/server/src/janitor";
import type { JanitorSettings } from "../../apps/server/src/config";

const T0 = Date.parse("2026-11-16T12:00:00Z");
const P = "aaaaaaaa-1111-4222-8333-444444444444";
const MB = 1024 * 1024;

const settings: JanitorSettings = {
  enabled: true,
  liveMs: 300_000,
  settleMs: 3_600_000,
  lookbackDays: 3,
  purgeBatch: 100,
  catchUpDays: 14,
  startDelayMs: 0,
};

const repos: Repository[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.close().catch(() => {});
});

async function setup(
  over: { dbMaxMb?: number; size?: () => number; events?: number; games?: number } = {},
  hooks: { onBudget?: (e: unknown) => void; onFailure?: (j: string, e: unknown) => void } = {},
) {
  const clock = { now: T0 };
  const base = await openRepository({ driver: "sqlite", path: ":memory:", now: () => clock.now });
  repos.push(base);
  const repository: Repository = over.size
    ? { ...base, sizeBytes: async () => over.size!() }
    : base;
  const janitor: Janitor = createJanitor({
    repository,
    settings,
    retention: { eventsDays: 30, gamesDays: 180, sessionsDays: 180 },
    dbMaxMb: over.dbMaxMb ?? 0,
    clock: () => clock.now,
    ...hooks,
  });
  return { clock, base, repository, janitor };
}

const game = (id: string, at: number, mode = "sprint") => ({
  id,
  mode,
  startedAt: at,
  durationMs: 30_000,
  players: [{ playerId: P, result: "finished" as const, lines: 10, score: 100, pieces: 30 }],
});

describe("janitor", () => {
  it("live pass rolls up today and reports the figures, with the extra modes summed", async () => {
    const { base, janitor } = await setup();
    await base.touchPlayer(P, T0 - 1000);
    await base.recordGame(game("g-000001", T0 - 60_000, "sprint"));
    await base.recordGame(game("g-000002", T0 - 50_000, "sprint"));
    for (let i = 0; i < 14; i++)
      await base.recordGame(
        game(
          `g-m${String(i).padStart(5, "0")}`,
          T0 - 40_000 + i,
          `mode${String(i).padStart(2, "0")}`,
        ),
      );
    await janitor.runLive();
    const s = janitor.status();
    expect(s.today?.day).toBe("2026-11-16");
    expect(s.today?.games).toBe(16);
    expect(s.today?.playersActive).toBe(1);
    expect(s.today?.gamesByMode.sprint).toBe(2);
    expect(Object.keys(s.today!.gamesByMode)).toHaveLength(13);
    expect(s.today?.gamesByMode.other).toBe(3);
    expect(s.jobs.live.ok).toBe(1);
  });

  it("closes the day that just ended on the first live pass after midnight", async () => {
    const { base, clock, janitor } = await setup();
    await base.touchPlayer(P, T0);
    await janitor.runLive();
    await base.recordGame(game("g-000001", T0 + 3_600_000));
    clock.now = Date.parse("2026-11-17T00:02:00Z");
    await janitor.runLive();
    const stats = await base.dailyStats("2026-11-16", "2026-11-16");
    expect(stats.find((s) => s.metric === "games" && s.dim === "all")?.value).toBe(1);
  });

  it("settle rolls up late uploads, purges only old rows and counts what is left", async () => {
    const { base, clock, janitor } = await setup();
    await base.touchPlayer(P, T0);
    const old = T0 - 40 * DAY_MS;
    await base.insertEvents([
      { id: "evt-00000001", playerId: P, kind: "game_start", occurredAt: old, receivedAt: old },
      {
        id: "evt-00000002",
        playerId: P,
        kind: "game_start",
        occurredAt: T0 - DAY_MS,
        receivedAt: T0,
      },
    ]);
    // The first settle after a start catches up over two weeks; the old day was never rolled up, so its events stay.
    await janitor.runSettle();
    expect((await base.counts()).events).toBe(2);
    // Once that day has been rolled up the same purge removes them.
    await janitor.rollup(dayOf(old));
    clock.now += 1000;
    await janitor.runSettle();
    expect(janitor.status().counts).toMatchObject({ events: 1 });
    expect(janitor.status().lastPurge?.events).toBe(1);
    expect(janitor.status().purged.events).toBe(1);
  });

  it("cuts the retention while over budget and relaxes it when well under", async () => {
    let size = 250 * MB;
    const budgetEvents: Array<{ ratio: number; level: number }> = [];
    const { base } = await setup();
    // Every compaction "frees" 30 % of the size, as the purge of a shorter retention would.
    const janitor = createJanitor({
      repository: {
        ...base,
        sizeBytes: async () => size,
        compact: async () => {
          size = Math.round(size * 0.7);
        },
      },
      settings,
      retention: { eventsDays: 30, gamesDays: 180, sessionsDays: 180 },
      dbMaxMb: 100,
      clock: () => T0,
      onBudget: (e) => budgetEvents.push(e),
    });
    // The settle pass compacts once, then finds 175 MB: two cuts bring it to 86 MB.
    await janitor.runSettle();
    expect(janitor.status().budget.level).toBe(2);
    expect(janitor.effectiveRetention()).toEqual({
      eventsDays: 7,
      gamesDays: 45,
      sessionsDays: 45,
    });
    expect(budgetEvents.at(-1)?.ratio).toBeLessThan(1);
    expect(budgetEvents.at(-1)?.level).toBe(2);
    size = 50 * MB;
    await janitor.runSettle();
    expect(janitor.status().budget.level).toBe(1);
    size = 10 * MB;
    await janitor.runSettle();
    expect(janitor.status().budget.level).toBe(0);
  });

  it("warns once a day at 80 % and never cuts retention below one day", async () => {
    const warned: number[] = [];
    const { janitor, clock } = await setup(
      { dbMaxMb: 100, size: () => 85 * MB },
      { onBudget: (e) => warned.push((e as { ratio: number }).ratio) },
    );
    await janitor.runSettle();
    await janitor.runSettle();
    expect(warned).toHaveLength(1);
    clock.now += DAY_MS;
    await janitor.runSettle();
    expect(warned).toHaveLength(2);

    const stuck = await setup({ dbMaxMb: 1, size: () => 500 * MB });
    await stuck.janitor.runSettle();
    expect(stuck.janitor.status().budget.level).toBe(6);
    expect(stuck.janitor.effectiveRetention().eventsDays).toBe(1);
  });

  it("reports a failing job and keeps going", async () => {
    const failures: string[] = [];
    const { base, janitor } = await setup({}, { onFailure: (job) => failures.push(job) });
    const original = base.rollupDay.bind(base);
    let fail = true;
    base.rollupDay = async (day: string) => {
      if (fail) throw new Error("disk full");
      return original(day);
    };
    // The janitor was built with the repository object itself, so replacing the method takes effect.
    await janitor.runLive();
    expect(failures).toEqual(["live"]);
    expect(janitor.status().jobs.live).toMatchObject({ ok: 0, failed: 1 });
    fail = false;
    await janitor.runLive();
    expect(janitor.status().jobs.live.ok).toBe(1);
  });

  it("does not queue the same job twice while one waits", async () => {
    const { janitor } = await setup();
    await Promise.all([janitor.runLive(), janitor.runLive(), janitor.runLive()]);
    expect(janitor.status().jobs.live.ok).toBeLessThanOrEqual(2);
  });

  it("stop() waits for the running job and clears the timers", async () => {
    const { janitor } = await setup();
    janitor.start();
    await janitor.stop();
    await janitor.stop();
  });
});
