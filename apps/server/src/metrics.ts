/**
 * `/metrics` for Prometheus.
 *
 * The counters the server already keeps (`stats()`, the API's counters, the janitor's figures) are
 * read when a scrape comes in, so nothing is counted twice and no hot path gets slower. The one
 * thing recorded as it happens is the ping round trip, which is a histogram.
 *
 * Whoever can reach the address can read it, so it is off unless `METRICS=on`, and then it answers
 * only a request that carries the bearer token (when one is set) or that did not come through a
 * proxy. Everything else is a plain 404, as if the route did not exist.
 */
import { timingSafeEqual } from "node:crypto";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "@prometheus-io/client";
import type { FastifyInstance } from "fastify";
import type { ApiStats } from "./api";
import type { ServerStats } from "./app";
import type { MetricsSettings } from "./config";
import type { JanitorStatus, JobName } from "./janitor";
import type { NotifierStats } from "./notifier";

export interface MetricSources {
  server(): ServerStats;
  api(): ApiStats | null;
  janitor(): JanitorStatus | null;
  notifier(): NotifierStats;
  /** Resolves `true` when the database answers; `null` when there is none. */
  database(): Promise<boolean | null>;
}

export interface Metrics {
  readonly contentType: string;
  render(): Promise<string>;
  /** A ping was answered after this many milliseconds. */
  observePing(ms: number): void;
}

export interface MetricsInfo {
  version: string;
  driver: string;
}

const PING_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];
const JOB_BUCKETS = [0.01, 0.05, 0.25, 1, 5, 30, 120];

export function createMetrics(sources: MetricSources, info: MetricsInfo): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  /** A gauge whose value is read from `read` at scrape time. */
  const gauge = (
    name: string,
    help: string,
    read: (g: Gauge<string>) => void | Promise<void>,
    labelNames: string[] = [],
  ): Gauge<string> =>
    new Gauge<string>({
      name,
      help,
      labelNames,
      registers: [registry],
      async collect() {
        // A gauge without labels starts at 0 in this client and `reset()` brings that 0 back, which
        // would read as a value where there is none (no budget, no database, no run yet). So the
        // series is removed first and exists only when `read` sets it; labelled gauges drop stale series.
        if (labelNames.length > 0) this.reset();
        else this.remove();
        await read(this);
      },
    });

  /** A counter that mirrors a total the server keeps itself. */
  const total = (
    name: string,
    help: string,
    read: (set: (value: number, labels?: Record<string, string>) => void) => void,
    labelNames: string[] = [],
  ): Counter<string> =>
    new Counter<string>({
      name,
      help,
      labelNames,
      registers: [registry],
      collect() {
        this.reset();
        read((value, labels) => (labels ? this.inc(labels, value) : this.inc(value)));
      },
    });

  gauge(
    "tetrizz_info",
    "Version and database driver; the value is always 1.",
    (g) => g.set({ version: info.version, driver: info.driver }, 1),
    ["version", "driver"],
  );
  gauge("tetrizz_connections", "WebSocket connections open now.", (g) =>
    g.set(sources.server().connections),
  );
  gauge("tetrizz_rooms", "Rooms held now.", (g) => g.set(sources.server().rooms));

  total("tetrizz_connections_accepted_total", "Connections let in.", (set) =>
    set(sources.server().accepted),
  );
  total(
    "tetrizz_connections_refused_total",
    "Connections turned away, by reason.",
    (set) => {
      for (const [reason, n] of Object.entries(sources.server().refused)) set(n, { reason });
    },
    ["reason"],
  );
  total(
    "tetrizz_connections_closed_total",
    "Connections the server cut, by reason.",
    (set) => {
      for (const [reason, n] of Object.entries(sources.server().closed)) set(n, { reason });
    },
    ["reason"],
  );
  total("tetrizz_messages_received_total", "Messages received from pages.", (set) =>
    set(sources.server().messagesIn),
  );
  total("tetrizz_messages_dropped_total", "Messages dropped by the per-connection limit.", (set) =>
    set(sources.server().messagesDropped),
  );
  total(
    "tetrizz_password_limited_total",
    "Requests with a password turned away by the per-address limit.",
    (set) => set(sources.server().passwordLimited),
  );

  const ping = new Histogram({
    name: "tetrizz_ping_seconds",
    help: "Round trip of the server's heartbeat ping.",
    buckets: PING_BUCKETS,
    registers: [registry],
  });

  total("tetrizz_api_requests_total", "Requests to /api/v1.", (set) =>
    set(sources.api()?.requests ?? 0),
  );
  total(
    "tetrizz_api_refused_total",
    "Requests to /api/v1 that were refused, by reason.",
    (set) => {
      const a = sources.api();
      if (!a) return;
      set(a.refusedOrigin, { reason: "origin" });
      set(a.rateLimited, { reason: "rate" });
      set(a.invalid, { reason: "invalid" });
      set(a.identityRefused, { reason: "identity" });
      set(a.newPlayerLimited, { reason: "new_players" });
    },
    ["reason"],
  );
  total("tetrizz_telemetry_batches_total", "Telemetry batches received.", (set) =>
    set(sources.api()?.telemetry.batches ?? 0),
  );
  total(
    "tetrizz_telemetry_opted_out_total",
    "Telemetry batches from players who opted out.",
    (set) => set(sources.api()?.telemetry.optedOut ?? 0),
  );
  total(
    "tetrizz_telemetry_items_total",
    "Telemetry items, by kind and outcome.",
    (set) => {
      const t = sources.api()?.telemetry;
      if (!t) return;
      set(t.eventsStored, { kind: "event", outcome: "stored" });
      set(t.eventsDuplicate, { kind: "event", outcome: "duplicate" });
      set(t.gamesStored, { kind: "game", outcome: "stored" });
      set(t.gamesDuplicate, { kind: "game", outcome: "duplicate" });
      set(t.historyStored, { kind: "history", outcome: "stored" });
      set(t.historyDuplicate, { kind: "history", outcome: "duplicate" });
      set(t.itemsRejected, { kind: "any", outcome: "rejected" });
      set(t.itemsStale, { kind: "any", outcome: "stale" });
    },
    ["kind", "outcome"],
  );
  total("tetrizz_players_deleted_total", "Players whose data was deleted on request.", (set) =>
    set(sources.api()?.playersDeleted ?? 0),
  );
  total("tetrizz_db_errors_total", "Database failures met while serving /api/v1.", (set) =>
    set(sources.api()?.dbErrors ?? 0),
  );
  gauge(
    "tetrizz_db_up",
    "1 when the database answers, 0 when it does not; absent without a database.",
    async (g) => {
      const up = await sources.database();
      if (up !== null) g.set(up ? 1 : 0);
    },
  );

  const jobDuration = new Histogram<string>({
    name: "tetrizz_janitor_job_seconds",
    help: "Time the janitor jobs take.",
    labelNames: ["job"],
    buckets: JOB_BUCKETS,
    registers: [registry],
  });
  const observedJobs: Record<JobName, number> = { live: 0, settle: 0 };
  total(
    "tetrizz_janitor_runs_total",
    "Janitor job runs, by job and result.",
    (set) => {
      const status = sources.janitor();
      if (!status) return;
      for (const job of ["live", "settle"] as const) {
        set(status.jobs[job].ok, { job, result: "ok" });
        set(status.jobs[job].failed, { job, result: "failed" });
      }
    },
    ["job", "result"],
  );
  gauge(
    "tetrizz_janitor_last_ok_timestamp_seconds",
    "When each janitor job last succeeded.",
    (g) => {
      const status = sources.janitor();
      if (!status) return;
      for (const job of ["live", "settle"] as const) {
        const at = status.jobs[job].lastOkAt;
        if (at !== null) g.set({ job }, at / 1000);
      }
    },
    ["job"],
  );
  gauge(
    "tetrizz_janitor_last_job_seconds",
    "Duration of each janitor job's last run.",
    (g) => {
      const status = sources.janitor();
      if (!status) return;
      for (const job of ["live", "settle"] as const) {
        const ms = status.jobs[job].lastMs;
        if (ms !== null) {
          g.set({ job }, ms / 1000);
          // The histogram gets one sample per finished run, noticed at the next scrape.
          const runs = status.jobs[job].ok + status.jobs[job].failed;
          if (runs > observedJobs[job]) {
            observedJobs[job] = runs;
            jobDuration.observe({ job }, ms / 1000);
          }
        }
      }
    },
    ["job"],
  );
  total(
    "tetrizz_purged_rows_total",
    "Rows deleted by the retention purge, by table.",
    (set) => {
      const status = sources.janitor();
      if (!status) return;
      set(status.purged.events, { table: "events" });
      set(status.purged.games, { table: "games" });
      set(status.purged.sessions, { table: "sessions" });
    },
    ["table"],
  );
  gauge(
    "tetrizz_retention_cut_level",
    "How many times the retention was cut in half to fit the size budget.",
    (g) => {
      const status = sources.janitor();
      if (status) g.set(status.budget.level);
    },
  );
  gauge("tetrizz_db_size_bytes", "Size of the database.", (g) => {
    const size = sources.janitor()?.sizeBytes;
    if (size !== null && size !== undefined) g.set(size);
  });
  gauge(
    "tetrizz_db_budget_bytes",
    "The size budget (DB_MAX_MB); absent when there is none.",
    (g) => {
      const max = sources.janitor()?.budget.maxBytes ?? 0;
      if (max > 0) g.set(max);
    },
  );
  gauge(
    "tetrizz_db_rows",
    "Rows per table, as of the last settle pass.",
    (g) => {
      const counts = sources.janitor()?.counts;
      if (!counts) return;
      for (const [table, n] of Object.entries(counts)) g.set({ table }, n);
    },
    ["table"],
  );

  const today = (
    name: string,
    help: string,
    pick: (t: NonNullable<JanitorStatus["today"]>) => number,
  ): void => {
    gauge(name, help, (g) => {
      const t = sources.janitor()?.today;
      if (t) g.set(pick(t));
    });
  };
  today("tetrizz_players_active_today", "Players active today (UTC).", (t) => t.playersActive);
  today("tetrizz_players_new_today", "Players first seen today (UTC).", (t) => t.playersNew);
  today("tetrizz_sessions_today", "Sessions started today (UTC).", (t) => t.sessions);
  today("tetrizz_play_seconds_today", "Time played today (UTC).", (t) => t.playSeconds);
  today("tetrizz_js_errors_today", "JavaScript errors reported today (UTC).", (t) => t.jsErrors);
  gauge(
    "tetrizz_games_today",
    "Games today (UTC) by mode; the least played modes are summed as other.",
    (g) => {
      const t = sources.janitor()?.today;
      if (!t) return;
      for (const [mode, n] of Object.entries(t.gamesByMode)) g.set({ mode }, n);
    },
    ["mode"],
  );

  total(
    "tetrizz_notifications_total",
    "Messages to the owner, by result.",
    (set) => {
      const n = sources.notifier();
      set(n.sent, { result: "sent" });
      set(n.failed, { result: "failed" });
      set(n.suppressed, { result: "held_back" });
    },
    ["result"],
  );

  return {
    contentType: registry.contentType,
    render: () => registry.metrics(),
    observePing: (ms) => ping.observe(ms / 1000),
  };
}

/** True when the request may read `/metrics`. */
export function mayReadMetrics(
  settings: MetricsSettings,
  headers: {
    authorization?: string | undefined;
    forwarded?: string | undefined;
    xForwardedFor?: string | undefined;
  },
): boolean {
  if (!settings.enabled) return false;
  if (settings.token !== null) {
    const given = /^Bearer (\S+)$/.exec(headers.authorization ?? "")?.[1] ?? "";
    const a = Buffer.from(given);
    const b = Buffer.from(settings.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  // Without a token only a direct request will do; a proxy marks everything it forwards.
  return headers.forwarded === undefined && headers.xForwardedFor === undefined;
}

export function registerMetricsRoute(
  fastify: FastifyInstance,
  settings: MetricsSettings,
  metrics: Metrics,
): void {
  if (!settings.enabled) return;
  fastify.get("/metrics", async (request, reply) => {
    const h = request.headers;
    const allowed = mayReadMetrics(settings, {
      authorization: h.authorization,
      forwarded: h.forwarded,
      xForwardedFor: typeof h["x-forwarded-for"] === "string" ? h["x-forwarded-for"] : undefined,
    });
    if (!allowed) return reply.code(404).send({ error: "not-found" });
    return reply
      .header("content-type", metrics.contentType)
      .header("cache-control", "no-store")
      .send(await metrics.render());
  });
}
