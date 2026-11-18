/**
 * What the owner is told, and when. The delivery itself is `notifier.ts`.
 *
 * - a start notice, every time the server starts listening;
 * - a daily digest of the day before, at the configured UTC hour;
 * - database errors, janitor failures, and the size budget reaching 80 % or being exceeded;
 * - an event loop that stays slow, and a burst of errors.
 *
 * Each condition goes through the notifier's cooldown, so a database that stays down is one message
 * every half hour (with a count of the ones held back), not one per request.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { ServerConfig } from "./config";
import { DAY_MS, dayOf } from "./db/days";
import type { Repository } from "./db/types";
import { figuresOf, type Janitor, type JobName } from "./janitor";
import { redact, type Notifier } from "./notifier";

const LAG_CHECK_MS = 10_000;
const DIGEST_CHECK_MS = 60_000;
/** The delay must be seen on this many checks in a row, so one slow moment is not an alert. */
const LAG_CHECKS_IN_A_ROW = 2;
const MB = 1024 * 1024;

export interface AlertsDeps {
  config: ServerConfig;
  notifier: Notifier;
  clock: () => number;
  repository: Repository | null;
  janitor: Janitor | null;
  /** What the server holds right now, for the digest. */
  live: () => { connections: number; rooms: number };
  version: string;
}

export interface BudgetEvent {
  ratio: number;
  sizeBytes: number;
  maxBytes: number;
  level: number;
}

export interface Alerts {
  start(): void;
  stop(): void;
  /** The start notice. */
  started(): Promise<void>;
  /** An error the server could not handle, for the error-burst rule. */
  recordError(): void;
  dbError(scope: string, error: unknown): void;
  janitorFailed(job: JobName, error: unknown): void;
  budget(event: BudgetEvent): void;
  /** One reading of the event-loop delay (99th percentile, milliseconds). */
  checkLag(p99Ms: number): void;
  /** Sends the digest when it is due. */
  checkDigest(): Promise<void>;
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

const short = (error: unknown): string =>
  redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);

export function createAlerts(deps: AlertsDeps): Alerts {
  const { config, notifier, clock, repository, janitor } = deps;
  const settings = config.notify;
  const startedAt = clock();
  const errorTimes: number[] = [];
  let slowChecks = 0;
  // A start after the digest hour does not repeat that day's digest; a start before it waits for it.
  let digestDay: string | null =
    settings.digestHourUtc !== null && new Date(startedAt).getUTCHours() >= settings.digestHourUtc
      ? dayOf(startedAt)
      : null;
  let timers: Array<ReturnType<typeof setInterval>> = [];
  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

  async function digest(day: string): Promise<void> {
    if (!repository) return;
    // The day is closed before it is counted, so the digest never shows a half-finished rollup.
    if (janitor) await janitor.rollup(day);
    else await repository.rollupDay(day);
    const f = figuresOf(day, await repository.dailyStats(day, day));
    const modes = Object.entries(f.gamesByMode)
      .map(([mode, n]) => `${mode} ${n}`)
      .join(", ");
    const size = await repository.sizeBytes();
    const maxBytes = config.dbMaxMb * MB;
    const budget =
      maxBytes > 0 ? ` of ${config.dbMaxMb} MB (${Math.round((size / maxBytes) * 100)} %)` : "";
    const now = deps.live();
    await notifier.notify({
      kind: "digest",
      severity: "info",
      title: `daily digest for ${day}`,
      lines: [
        `Games: ${f.games}${modes ? ` (${modes})` : ""}`,
        `Players: ${f.playersActive} active, ${f.playersNew} new, ${f.sessions} sessions`,
        `Play time: ${formatDuration(f.playSeconds * 1000)}`,
        `JS errors reported: ${f.jsErrors}`,
        `Right now: ${now.connections} connections, ${now.rooms} rooms`,
        `Database: ${repository.driver}, ${(size / MB).toFixed(1)} MB${budget}`,
        `Up ${formatDuration(clock() - startedAt)}, version ${deps.version}`,
      ],
    });
  }

  const alerts: Alerts = {
    start() {
      if (timers.length > 0) return;
      if (settings.lagMs > 0) {
        histogram = monitorEventLoopDelay({ resolution: 20 });
        histogram.enable();
        timers.push(
          setInterval(() => {
            if (!histogram) return;
            const p99 = histogram.percentile(99) / 1e6;
            histogram.reset();
            alerts.checkLag(p99);
          }, LAG_CHECK_MS),
        );
      }
      if (settings.digestHourUtc !== null && repository) {
        timers.push(setInterval(() => void alerts.checkDigest().catch(() => {}), DIGEST_CHECK_MS));
      }
      for (const timer of timers) timer.unref();
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
      timers = [];
      histogram?.disable();
      histogram = null;
    },
    async started() {
      const now = deps.live();
      await notifier.notify({
        kind: "restart",
        severity: "info",
        title: "started",
        lines: [
          `Version ${deps.version}, Node ${process.version}, database ${repository?.driver ?? config.database.driver}`,
          `Listening on ${config.host}:${config.port}; ${now.rooms} rooms held`,
        ],
      });
    },
    recordError() {
      if (settings.errorSpikeCount <= 0) return;
      const now = clock();
      errorTimes.push(now);
      while (errorTimes.length > 0 && now - errorTimes[0]! > settings.errorSpikeWindowMs)
        errorTimes.shift();
      if (errorTimes.length >= settings.errorSpikeCount) {
        void notifier.notify({
          kind: "error-spike",
          severity: "alert",
          title: "many errors in a short time",
          lines: [
            `${errorTimes.length} errors in the last ${formatDuration(settings.errorSpikeWindowMs)}.`,
            "Look at the server log (level error) for the cause.",
          ],
        });
      }
    },
    dbError(scope, error) {
      alerts.recordError();
      void notifier.notify({
        kind: "db-failure",
        severity: "alert",
        title: "the database is failing",
        lines: [`In ${scope}: ${short(error)}`],
      });
    },
    janitorFailed(job, error) {
      void notifier.notify({
        kind: "janitor-failure",
        key: `janitor-failure:${job}`,
        severity: "warn",
        title: `the ${job} maintenance job failed`,
        lines: [short(error), "It tries again on its next run."],
      });
    },
    budget(event) {
      const percent = Math.round(event.ratio * 100);
      const used = `${(event.sizeBytes / MB).toFixed(1)} of ${(event.maxBytes / MB).toFixed(0)} MB`;
      if (event.ratio >= 1) {
        void notifier.notify({
          kind: "budget",
          key: "budget:over",
          severity: "alert",
          title: "the database is over its size budget",
          lines: [
            `${used} (${percent} %) after purging with a retention cut ${event.level} time(s) in half.`,
            event.level >= 6
              ? "Retention cannot be cut further; raise DB_MAX_MB or free disk space."
              : "The retention stays cut until the database is well under the budget.",
          ],
        });
      } else {
        void notifier.notify({
          kind: "budget",
          key: "budget:warn",
          severity: "warn",
          title: "the database is nearly at its size budget",
          lines: [`${used} (${percent} %). Retention is cut automatically at 100 %.`],
        });
      }
    },
    checkLag(p99Ms) {
      if (settings.lagMs <= 0) return;
      slowChecks = p99Ms > settings.lagMs ? slowChecks + 1 : 0;
      if (slowChecks >= LAG_CHECKS_IN_A_ROW) {
        void notifier.notify({
          kind: "lag",
          severity: "warn",
          title: "the server is running slowly",
          lines: [
            `The event loop is delayed by ${Math.round(p99Ms)} ms (limit ${settings.lagMs} ms) over ${slowChecks} checks.`,
            "Too many players or bots for this machine, or the disk is slow.",
          ],
        });
      }
    },
    async checkDigest() {
      const hour = settings.digestHourUtc;
      if (hour === null || !repository) return;
      const now = clock();
      const today = dayOf(now);
      if (new Date(now).getUTCHours() < hour || digestDay === today) return;
      digestDay = today;
      await digest(dayOf(now - DAY_MS));
    },
  };
  return alerts;
}
