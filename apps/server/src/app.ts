/**
 * The server: HTTP health endpoints and the WebSocket at `/ws`, around the reference room model.
 *
 * The room rules (who may enter, who is host, which events reach whom, how long a dropped seat is
 * held) are NOT written here. `createReferenceServer` in `@tetrizz/protocol` is the one copy of
 * them; this file gives it real sockets and real timers and adds what a model leaves out: the
 * origin allowlist, limits per address and per connection, heartbeats, slow-reader protection,
 * scrypt passwords and a graceful stop.
 */
import websocket from "@fastify/websocket";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import {
  createReferenceServer,
  parseClientMessage,
  SERVER_MAX_FRAME_BYTES,
  SERVER_SOCKET_PATH,
  type PasswordRules,
} from "@tetrizz/protocol";
import type { RawData, WebSocket } from "ws";
import { createAlerts, type Alerts } from "./alerts";
import { registerApi, type Api, type ApiStats } from "./api";
import type { DatabaseSettings, ServerConfig } from "./config";
import { openRepository, type DatabaseOptions, type Repository } from "./db";
import { createJanitor, type Janitor } from "./janitor";
import { createConnectionGate, createFloodGuard, createKeyedBuckets, ipKey } from "./limits";
import { createMetrics, registerMetricsRoute, type Metrics } from "./metrics";
import { createNotifier, type Notifier } from "./notifier";
import { isOriginAllowed } from "./origin";
import { createScryptPasswords } from "./passwords";

export interface ServerStats {
  /** Sockets open now. */
  connections: number;
  rooms: number;
  /** Connections let in since the start. */
  accepted: number;
  refused: { origin: number; shuttingDown: number; total: number; perIp: number; rate: number };
  messagesIn: number;
  messagesDropped: number;
  /** Requests that carried a password and were turned away because the address used up its checks. */
  passwordLimited: number;
  closed: { flood: number; binary: number; heartbeat: number; hello: number; slowReader: number };
}

export interface ServerDeps {
  /** Stores and checks room passwords; scrypt unless a test passes a cheaper one. */
  passwords?: PasswordRules;
  /** Monotonic milliseconds for the limiters. */
  now?: () => number;
  version?: string;
  /** A database that is already open (tests); the server then leaves closing it to the caller. */
  repository?: Repository;
  /** Wall-clock milliseconds since the epoch, for stored times. */
  clock?: () => number;
  /** Told about every database failure, besides the owner's notification. */
  onDbError?: (scope: string, error: unknown) => void;
  /** The HTTP client for Telegram and Discord messages (tests pass a recorder). */
  fetch?: typeof fetch;
  /** Waits between a failed message and its one retry (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
}

export interface ServerApp {
  fastify: FastifyInstance;
  /** The open database, or null when none is configured. */
  repository: Repository | null;
  /** Counters of `/api/v1`, or null without a database. */
  apiStats(): ApiStats | null;
  /** The maintenance job, or null without a database. */
  janitor: Janitor | null;
  /** The rules that decide what the owner is told. */
  alerts: Alerts;
  notifier: Notifier;
  metrics: Metrics;
  /** Starts listening on the configured address and returns the port in use. */
  listen(): Promise<number>;
  stats(): ServerStats;
  /** Tells every page the server is going away, stops listening, and resolves when all is closed. */
  shutdown(): Promise<void>;
}

/** WebSocket close codes the server uses. */
const CLOSE_NORMAL = 1000;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_UNSUPPORTED = 1003;
const CLOSE_POLICY = 1008;
const CLOSE_TRY_LATER = 1013;

/** Dropped messages within five seconds after which a connection is cut. */
const FLOOD_ABUSE_DROPS = 200;
const JANITOR_MS = 60_000;

function databaseOptions(
  settings: Exclude<DatabaseSettings, { driver: "off" }>,
  now: () => number,
  onError: (e: Error) => void,
): DatabaseOptions {
  if (settings.driver === "sqlite") return { driver: "sqlite", path: settings.path, now };
  return {
    driver: "postgres",
    url: settings.url,
    poolMax: settings.poolMax,
    ...(settings.schema !== undefined ? { schema: settings.schema } : {}),
    onError,
    now,
  };
}

const textOf = (data: RawData): string =>
  Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");

/** The number of proxies in front of the server becomes "trust that many hops". */
function trustProxyOf(
  setting: ServerConfig["trustProxy"],
): string | boolean | ((address: string, hop: number) => boolean) {
  if (typeof setting !== "number") return setting;
  return (_address: string, hop: number) => hop < setting;
}

export async function createServerApp(
  config: ServerConfig,
  deps: ServerDeps = {},
): Promise<ServerApp> {
  const now = deps.now ?? (() => performance.now());
  const clock = deps.clock ?? Date.now;
  const options: FastifyServerOptions = {
    logger: { level: config.logLevel },
    // Requests are not logged: a request line would carry the address, and none is kept.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: trustProxyOf(config.trustProxy),
  };
  const fastify: FastifyInstance = Fastify(options);
  await fastify.register(websocket, { options: { maxPayload: SERVER_MAX_FRAME_BYTES } });

  // The alert rules need the database and the janitor, which are made after the first database
  // error could happen (the pool reports from the moment it opens), so they are reached through here.
  const late: { alerts: Alerts | null } = { alerts: null };
  const onDbError = (scope: string, error: unknown): void => {
    fastify.log.error({ scope, err: error }, "database error");
    late.alerts?.dbError(scope, error);
    deps.onDbError?.(scope, error);
  };
  // A request that ended in an error the server did not expect counts towards the error-burst alert.
  fastify.addHook("onError", async () => {
    late.alerts?.recordError();
  });
  let repository: Repository | null = deps.repository ?? null;
  const ownsRepository = repository === null && config.database.driver !== "off";
  if (repository === null && config.database.driver !== "off") {
    repository = await openRepository(
      databaseOptions(config.database, clock, (error) => onDbError("pool", error)),
    );
  }
  const api: Api | null = repository
    ? registerApi(fastify, { repository, config, now, clock, onDbError })
    : null;

  const notifier = createNotifier(config.notify, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    clock,
    log: fastify.log,
  });
  const janitor: Janitor | null = repository
    ? createJanitor({
        repository,
        settings: config.janitor,
        retention: config.retention,
        dbMaxMb: config.dbMaxMb,
        clock,
        log: fastify.log,
        onFailure: (job, error) => late.alerts?.janitorFailed(job, error),
        onBudget: (event) => late.alerts?.budget(event),
      })
    : null;

  const counters: ServerStats = {
    connections: 0,
    rooms: 0,
    accepted: 0,
    refused: { origin: 0, shuttingDown: 0, total: 0, perIp: 0, rate: 0 },
    messagesIn: 0,
    messagesDropped: 0,
    passwordLimited: 0,
    closed: { flood: 0, binary: 0, heartbeat: 0, hello: 0, slowReader: 0 },
  };

  // Real timers for the seat hold; unref so a pending hold never keeps a stopping process alive.
  const later = (task: () => void, ms: number): (() => void) => {
    const handle = setTimeout(task, ms);
    handle.unref();
    return () => clearTimeout(handle);
  };

  const rooms = createReferenceServer({
    graceMs: config.seatGraceMs,
    maxRooms: config.maxRooms,
    later,
    passwords: deps.passwords ?? createScryptPasswords(),
  });
  const gate = createConnectionGate({
    maxTotal: config.maxConnections,
    maxPerKey: config.maxConnectionsPerIp,
    perMinutePerKey: config.connectsPerMinutePerIp,
    now,
  });
  const passwordBudget = createKeyedBuckets({
    capacity: config.passwordBurst,
    refillPerSecond: config.passwordChecksPerMinute / 60,
    now,
  });

  /** Every open socket, whether it has answered since the last heartbeat, and when it was pinged. */
  const sockets = new Map<WebSocket, { alive: boolean; pingedAt: number | null }>();
  let shuttingDown = false;

  fastify.get("/healthz", async () => ({ status: "ok" }));
  fastify.get("/readyz", async (_request, reply) => {
    if (shuttingDown) return reply.code(503).send({ status: "shutting-down" });
    if (!repository) return { status: "ready" };
    // Rooms do not need the database, so a database that is down is reported, not fatal.
    const database = await repository.ping().then(
      () => "ok",
      () => "down",
    );
    return { status: "ready", database };
  });

  fastify.get(
    SERVER_SOCKET_PATH,
    {
      websocket: true,
      // Runs before the upgrade, so a refused page gets a plain HTTP answer.
      preValidation: async (request, reply) => {
        if (shuttingDown) {
          counters.refused.shuttingDown++;
          return reply.code(503).send({ error: "shutting-down" });
        }
        if (!isOriginAllowed(config.origins, request.headers.origin, request.headers.host)) {
          counters.refused.origin++;
          return reply.code(403).send({ error: "origin-not-allowed" });
        }
      },
    },
    (socket: WebSocket, request: FastifyRequest) => {
      const key = ipKey(request.ip);
      const verdict = gate.admit(key);
      if (verdict !== "ok") {
        if (verdict === "total") counters.refused.total++;
        else if (verdict === "per-ip") counters.refused.perIp++;
        else counters.refused.rate++;
        socket.close(CLOSE_TRY_LATER, verdict);
        return;
      }
      counters.accepted++;
      const state = { alive: true, pingedAt: null as number | null };
      sockets.set(socket, state);

      const flood = createFloodGuard({
        perSecond: config.messagesPerSecond,
        burst: config.messageBurst,
        abuseAfter: FLOOD_ABUSE_DROPS,
        now,
      });
      let helloTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        counters.closed.hello++;
        socket.terminate();
      }, config.helloTimeoutMs);
      helloTimer.unref();

      const send = (text: string): void => {
        if (socket.readyState !== socket.OPEN) return;
        if (socket.bufferedAmount > config.maxBufferedBytes) {
          counters.closed.slowReader++;
          socket.terminate();
          return;
        }
        socket.send(text);
      };
      const link = rooms.connect(send, () => socket.close(CLOSE_NORMAL));
      // Once the server has decided to close, frames already in the receive buffer are ignored.
      let closing = false;

      socket.on("pong", () => {
        state.alive = true;
        if (state.pingedAt !== null) metrics.observePing(now() - state.pingedAt);
        state.pingedAt = null;
      });

      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (closing) return;
        state.alive = true;
        if (helloTimer) {
          clearTimeout(helloTimer);
          helloTimer = null;
        }
        if (isBinary) {
          closing = true;
          counters.closed.binary++;
          socket.close(CLOSE_UNSUPPORTED, "text only");
          return;
        }
        counters.messagesIn++;
        const budget = flood.check();
        if (budget !== "ok") {
          counters.messagesDropped++;
          if (budget === "abuse") {
            closing = true;
            counters.closed.flood++;
            socket.close(CLOSE_POLICY, "too many messages");
          }
          return;
        }
        const text = textOf(data);
        // Hashing a password costs real CPU time, so each address has a budget of them.
        if (text.includes('"password"')) {
          const m = parseClientMessage(text);
          if (
            m &&
            (m.t === "create" || m.t === "join" || m.t === "settings") &&
            m.password &&
            !passwordBudget.take(key)
          ) {
            counters.passwordLimited++;
            if (m.t !== "settings")
              send(JSON.stringify({ t: "refused", rid: m.rid, reason: "busy" }));
            return;
          }
        }
        link.receive(text);
      });

      socket.on("error", (error: Error) => {
        fastify.log.debug({ err: error.message }, "socket error");
      });

      socket.on("close", () => {
        if (helloTimer) clearTimeout(helloTimer);
        sockets.delete(socket);
        gate.release(key);
        link.close();
      });
    },
  );

  const heartbeat = setInterval(() => {
    for (const [socket, state] of sockets) {
      if (!state.alive) {
        counters.closed.heartbeat++;
        socket.terminate();
        continue;
      }
      state.alive = false;
      try {
        state.pingedAt = now();
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, config.heartbeatMs);
  const sweeper = setInterval(() => {
    gate.sweep();
    passwordBudget.sweep();
    api?.sweep();
  }, JANITOR_MS);
  heartbeat.unref();
  sweeper.unref();

  const stats = (): ServerStats => ({
    ...counters,
    refused: { ...counters.refused },
    closed: { ...counters.closed },
    connections: sockets.size,
    rooms: rooms.roomCount(),
  });

  const metrics = createMetrics(
    {
      server: stats,
      api: () => api?.stats() ?? null,
      janitor: () => janitor?.status() ?? null,
      notifier: () => notifier.stats(),
      database: async () =>
        repository
          ? repository.ping().then(
              () => true,
              () => false,
            )
          : null,
    },
    { version: deps.version ?? "dev", driver: repository?.driver ?? config.database.driver },
  );
  registerMetricsRoute(fastify, config.metrics, metrics);

  const alerts = createAlerts({
    config,
    notifier,
    clock,
    repository,
    janitor,
    live: () => ({ connections: sockets.size, rooms: rooms.roomCount() }),
    version: deps.version ?? "dev",
  });
  late.alerts = alerts;

  let summary: ReturnType<typeof setInterval> | null = null;
  if (config.statsLogMs > 0) {
    summary = setInterval(() => fastify.log.info(stats(), "stats"), config.statsLogMs);
    summary.unref();
  }

  fastify.addHook("onClose", async () => {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    if (summary) clearInterval(summary);
  });

  return {
    fastify,
    repository,
    apiStats: () => api?.stats() ?? null,
    janitor,
    alerts,
    notifier,
    metrics,
    async listen() {
      await fastify.listen({ host: config.host, port: config.port });
      const address = fastify.server.address();
      janitor?.start();
      alerts.start();
      void alerts.started();
      return typeof address === "object" && address ? address.port : config.port;
    },
    stats,
    async shutdown() {
      shuttingDown = true;
      alerts.stop();
      for (const socket of sockets.keys()) socket.close(CLOSE_GOING_AWAY, "server stopping");
      // A page that never answers the close is cut after the grace period.
      const cutoff = setTimeout(() => {
        for (const socket of sockets.keys()) socket.terminate();
      }, config.shutdownGraceMs);
      try {
        await fastify.close();
        // A job that is running finishes before the database it uses is closed.
        await janitor?.stop();
        await notifier.idle();
      } finally {
        clearTimeout(cutoff);
        if (ownsRepository && repository) await repository.close();
      }
    },
  };
}
