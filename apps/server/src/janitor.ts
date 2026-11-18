/**
 * The background job that keeps the database useful and small.
 *
 * Two passes, both safe to repeat:
 *
 * - The live pass (every few minutes) rolls up today, so the numbers for today are current, and
 *   refreshes the "today" figures that `/metrics` shows. The first live pass after midnight UTC also
 *   closes the day that just ended.
 * - The settle pass (every hour) rolls up the last days again, because an offline page can upload
 *   events long after they happened; then it purges rows older than the retention (the repository
 *   only deletes from days that were rolled up), gives the space back, counts rows and checks the
 *   size budget. A database over its budget gets a shorter retention until it fits again.
 *
 * Everything runs one job at a time. A job that fails is counted and reported and the next run
 * tries again; the janitor never throws into the server.
 */
import type { JanitorSettings, RetentionSettings } from "./config";
import { DAY_MS, dayOf } from "./db/days";
import type { Counts, DailyStat, PurgeResult, Repository } from "./db/types";

export type JobName = "live" | "settle";

const MB = 1024 * 1024;
/** Each step halves every retention (events 30 -> 15 -> 7 ...), never below one day. */
const MAX_TIGHTEN_LEVEL = 6;
const WARN_RATIO = 0.8;
const RELAX_RATIO = 0.7;
/** The modes shown on their own in `/metrics`; any others are summed as `other`. */
const MODE_SERIES_LIMIT = 12;

export interface TodayFigures {
  day: string;
  games: number;
  playersActive: number;
  playersNew: number;
  sessions: number;
  jsErrors: number;
  playSeconds: number;
  gamesByMode: Record<string, number>;
}

export interface JobStats {
  ok: number;
  failed: number;
  lastOkAt: number | null;
  lastMs: number | null;
  /** Total seconds spent, with the count in `ok + failed`, for an average. */
  totalSeconds: number;
}

export interface BudgetState {
  maxBytes: number;
  sizeBytes: number;
  /** 0 is the configured retention; each step halves it. */
  level: number;
}

export interface JanitorStatus {
  jobs: Record<JobName, JobStats>;
  today: TodayFigures | null;
  counts: Counts | null;
  sizeBytes: number | null;
  budget: BudgetState;
  lastPurge: PurgeResult | null;
  purged: PurgeResult;
}

export interface JanitorDeps {
  repository: Repository;
  settings: JanitorSettings;
  retention: RetentionSettings;
  /** Soft ceiling in megabytes; 0 means none. */
  dbMaxMb: number;
  /** Wall-clock milliseconds. */
  clock: () => number;
  log?: { error(obj: object, msg: string): void; info(obj: object, msg: string): void };
  onFailure?: (job: JobName, error: unknown) => void;
  /** Called when the size crosses 80 % of the budget or the budget is exceeded. */
  onBudget?: (event: { ratio: number; sizeBytes: number; maxBytes: number; level: number }) => void;
}

export interface Janitor {
  /** Starts the timers (after the configured delay). A no-op when the janitor is switched off. */
  start(): void;
  /** Stops the timers and waits for the job that is running. */
  stop(): Promise<void>;
  runLive(): Promise<void>;
  runSettle(): Promise<void>;
  /** Rolls up one day, in line with the jobs (never at the same time as one). */
  rollup(day: string): Promise<void>;
  /** Retention in days now in force, after any tightening. */
  effectiveRetention(): RetentionSettings;
  status(): JanitorStatus;
}

const emptyJob = (): JobStats => ({
  ok: 0,
  failed: 0,
  lastOkAt: null,
  lastMs: null,
  totalSeconds: 0,
});
const emptyPurge = (): PurgeResult => ({ events: 0, games: 0, sessions: 0 });

export function figuresOf(day: string, stats: readonly DailyStat[]): TodayFigures {
  const all = (metric: string): number =>
    stats.find((s) => s.metric === metric && s.dim === "all")?.value ?? 0;
  const modes = stats
    .filter((s) => s.metric === "games" && s.dim.startsWith("mode:"))
    .map((s) => [s.dim.slice(5), s.value] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const gamesByMode: Record<string, number> = {};
  let other = 0;
  modes.forEach(([mode, value], index) => {
    if (index < MODE_SERIES_LIMIT) gamesByMode[mode] = value;
    else other += value;
  });
  if (other > 0) gamesByMode.other = other;
  return {
    day,
    games: all("games"),
    playersActive: all("players_active"),
    playersNew: all("players_new"),
    sessions: all("sessions"),
    jsErrors: all("errors"),
    playSeconds: Math.round(all("play_ms") / 1000),
    gamesByMode,
  };
}

export function createJanitor(deps: JanitorDeps): Janitor {
  const { repository, settings, clock } = deps;
  const maxBytes = deps.dbMaxMb * MB;
  const jobs: Record<JobName, JobStats> = { live: emptyJob(), settle: emptyJob() };
  const purged = emptyPurge();
  let today: TodayFigures | null = null;
  let counts: Counts | null = null;
  let sizeBytes: number | null = null;
  let lastPurge: PurgeResult | null = null;
  let level = 0;
  let lastLiveDay: string | null = null;
  let caughtUp = false;
  let lastCompactDay: string | null = null;
  let warnedDay: string | null = null;

  // Jobs and ad-hoc rollups queue behind one another; a job already waiting is not queued twice.
  let tail: Promise<void> = Promise.resolve();
  const waiting = new Set<string>();
  function serial(name: string, work: () => Promise<void>, dedupe: boolean): Promise<void> {
    if (dedupe && waiting.has(name)) return tail;
    if (dedupe) waiting.add(name);
    const run = tail.then(async () => {
      waiting.delete(name);
      await work();
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function timed(job: JobName, work: () => Promise<void>): Promise<void> {
    const started = performance.now();
    try {
      await work();
      const seconds = (performance.now() - started) / 1000;
      jobs[job].ok++;
      jobs[job].lastOkAt = clock();
      jobs[job].lastMs = Math.round(seconds * 1000);
      jobs[job].totalSeconds += seconds;
    } catch (error) {
      jobs[job].failed++;
      jobs[job].lastMs = Math.round(performance.now() - started);
      deps.log?.error({ job, err: error }, "janitor job failed");
      deps.onFailure?.(job, error);
    }
  }

  const effectiveRetention = (): RetentionSettings => {
    const shrink = (days: number): number => Math.max(1, Math.floor(days / 2 ** level));
    return {
      eventsDays: shrink(deps.retention.eventsDays),
      gamesDays: shrink(deps.retention.gamesDays),
      sessionsDays: shrink(deps.retention.sessionsDays),
    };
  };

  async function purgeNow(): Promise<PurgeResult> {
    const keep = effectiveRetention();
    const at = clock();
    const result = await repository.purge({
      eventsBefore: at - keep.eventsDays * DAY_MS,
      gamesBefore: at - keep.gamesDays * DAY_MS,
      sessionsBefore: at - keep.sessionsDays * DAY_MS,
      batch: settings.purgeBatch,
    });
    purged.events += result.events;
    purged.games += result.games;
    purged.sessions += result.sessions;
    lastPurge = result;
    return result;
  }

  async function checkBudget(): Promise<void> {
    sizeBytes = await repository.sizeBytes();
    if (maxBytes <= 0) return;
    let ratio = sizeBytes / maxBytes;
    if (ratio >= 1) {
      // Shorter retention, purge, give the space back, measure again, until it fits or nothing is left to shorten.
      while (ratio >= 1 && level < MAX_TIGHTEN_LEVEL) {
        level++;
        await purgeNow();
        await repository.compact();
        sizeBytes = await repository.sizeBytes();
        ratio = sizeBytes / maxBytes;
      }
      deps.onBudget?.({ ratio, sizeBytes, maxBytes, level });
      return;
    }
    if (level > 0 && ratio < RELAX_RATIO) level--;
    const day = dayOf(clock());
    if (ratio >= WARN_RATIO && warnedDay !== day) {
      warnedDay = day;
      deps.onBudget?.({ ratio, sizeBytes, maxBytes, level });
    }
  }

  async function refreshToday(day: string): Promise<void> {
    today = figuresOf(day, await repository.dailyStats(day, day));
  }

  async function live(): Promise<void> {
    const day = dayOf(clock());
    // The day that just ended gets its last rollup as soon as the next day's first live pass runs.
    if (lastLiveDay !== null && lastLiveDay !== day) await repository.rollupDay(lastLiveDay);
    await repository.rollupDay(day);
    lastLiveDay = day;
    await refreshToday(day);
  }

  async function settle(): Promise<void> {
    const at = clock();
    const day = dayOf(at);
    const back = caughtUp
      ? settings.lookbackDays
      : Math.max(settings.lookbackDays, settings.catchUpDays);
    for (let n = back; n >= 1; n--) await repository.rollupDay(dayOf(at - n * DAY_MS));
    await repository.rollupDay(day);
    caughtUp = true;

    const result = await purgeNow();
    const removed = result.events + result.games + result.sessions;
    // Giving space back costs a little work; once a day, or whenever rows were just deleted.
    if (removed > 0 || lastCompactDay !== day) {
      await repository.compact();
      lastCompactDay = day;
    }
    counts = await repository.counts();
    await checkBudget();
    await refreshToday(day);
  }

  let timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];

  const janitor: Janitor = {
    start() {
      if (!settings.enabled || timers.length > 0) return;
      const first = setTimeout(() => {
        void janitor.runSettle().then(() => janitor.runLive());
        const liveTimer = setInterval(() => void janitor.runLive(), settings.liveMs);
        const settleTimer = setInterval(() => void janitor.runSettle(), settings.settleMs);
        liveTimer.unref();
        settleTimer.unref();
        timers.push(liveTimer, settleTimer);
      }, settings.startDelayMs);
      first.unref();
      timers.push(first);
    },
    async stop() {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers = [];
      await tail;
    },
    runLive: () => serial("live", () => timed("live", live), true),
    runSettle: () => serial("settle", () => timed("settle", settle), true),
    rollup: (day) => serial(`rollup:${day}`, () => repository.rollupDay(day), false),
    effectiveRetention,
    status: () => ({
      jobs: { live: { ...jobs.live }, settle: { ...jobs.settle } },
      today,
      counts,
      sizeBytes,
      budget: { maxBytes, sizeBytes: sizeBytes ?? 0, level },
      lastPurge,
      purged: { ...purged },
    }),
  };
  return janitor;
}
