/**
 * `/api/v1`: the part of the server that stores what the owner learns about play.
 *
 *   POST   /api/v1/telemetry                  one batch of events, games and history
 *   PUT    /api/v1/players/:id/telemetry      `{ "optOut": true | false }`
 *   DELETE /api/v1/players/:id                erases everything stored about the player
 *
 * The routes exist only when a database is configured. A page may be served from another host than
 * the server, so answers carry CORS headers for the origins the operator allows (the same rule as
 * the WebSocket). No address is stored: addresses are map keys of the limiters and nothing else.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  isPlayerId,
  PLAYERS_PATH,
  parseTelemetryBatch,
  TELEMETRY_MAX_BODY_BYTES,
  TELEMETRY_PATH,
} from "@tetrizz/protocol";
import type { ServerConfig } from "./config";
import { DAY_MS } from "./db/days";
import type { Repository } from "./db/types";
import { createKeyedBuckets, ipKey } from "./limits";
import { isOriginAllowed } from "./origin";
import { ingestBatch } from "./telemetry";

export interface ApiStats {
  requests: number;
  refusedOrigin: number;
  rateLimited: number;
  invalid: number;
  newPlayerLimited: number;
  dbErrors: number;
  telemetry: {
    batches: number;
    optedOut: number;
    eventsStored: number;
    eventsDuplicate: number;
    gamesStored: number;
    gamesDuplicate: number;
    historyStored: number;
    historyDuplicate: number;
    itemsRejected: number;
    itemsStale: number;
  };
  optOutChanges: number;
  playersDeleted: number;
}

export interface ApiDeps {
  repository: Repository;
  config: ServerConfig;
  /** Monotonic milliseconds for the limiters. */
  now: () => number;
  /** Wall-clock milliseconds since the epoch. */
  clock: () => number;
  /** Told about every database failure, for the log and the alerts. */
  onDbError?: (scope: string, error: unknown) => void;
}

export interface Api {
  stats(): ApiStats;
  /** Forgets limiter entries that have refilled; call now and then. */
  sweep(): void;
}

const emptyStats = (): ApiStats => ({
  requests: 0,
  refusedOrigin: 0,
  rateLimited: 0,
  invalid: 0,
  newPlayerLimited: 0,
  dbErrors: 0,
  telemetry: {
    batches: 0,
    optedOut: 0,
    eventsStored: 0,
    eventsDuplicate: 0,
    gamesStored: 0,
    gamesDuplicate: 0,
    historyStored: 0,
    historyDuplicate: 0,
    itemsRejected: 0,
    itemsStale: 0,
  },
  optOutChanges: 0,
  playersDeleted: 0,
});

const API_PREFIX = "/api/v1";
const CORS_METHODS = "POST, PUT, DELETE, OPTIONS";
const CORS_MAX_AGE_SECONDS = "600";

/** The part of a path after the API prefix, which the plugin below is registered under. */
const relative = (path: string): string => path.slice(API_PREFIX.length);

export function registerApi(fastify: FastifyInstance, deps: ApiDeps): Api {
  const { repository, config } = deps;
  const stats = emptyStats();

  const requestBudget = createKeyedBuckets({
    capacity: config.telemetry.requestBurst,
    refillPerSecond: config.telemetry.requestsPerMinute / 60,
    now: deps.now,
  });
  // Brand-new ids are the cheap way to fill a database, so each address gets few of them.
  const newPlayerBudget = createKeyedBuckets({
    capacity: Math.min(20, config.telemetry.newPlayersPerHour),
    refillPerSecond: config.telemetry.newPlayersPerHour / 3600,
    now: deps.now,
  });

  const fail = (reply: FastifyReply, code: number, error: string) =>
    reply.code(code).send({ ok: false, error });

  const dbFailed = (reply: FastifyReply, scope: string, error: unknown) => {
    stats.dbErrors++;
    deps.onDbError?.(scope, error);
    return fail(reply, 503, "unavailable");
  };

  void fastify.register(
    async (api) => {
      // `sendBeacon` and simple cross-site posts send plain text; the body is still JSON.
      api.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => {
        try {
          done(null, JSON.parse(String(body)));
        } catch {
          done(Object.assign(new Error("body is not JSON"), { statusCode: 400 }), undefined);
        }
      });

      api.addHook("onRequest", async (request, reply) => {
        stats.requests++;
        reply.header("Cache-Control", "no-store");
        const origin = request.headers.origin;
        if (!isOriginAllowed(config.origins, origin, request.headers.host)) {
          stats.refusedOrigin++;
          return fail(reply, 403, "origin-not-allowed");
        }
        if (origin !== undefined) {
          reply.header("Access-Control-Allow-Origin", origin);
          reply.header("Vary", "Origin");
        }
      });

      // A browser asks first when the page and the server are on different hosts.
      api.route({
        method: "OPTIONS",
        url: "/*",
        handler: async (_request, reply) =>
          reply
            .code(204)
            .header("Access-Control-Allow-Methods", CORS_METHODS)
            .header("Access-Control-Allow-Headers", "Content-Type")
            .header("Access-Control-Max-Age", CORS_MAX_AGE_SECONDS)
            .send(),
      });

      api.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
        const code = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
        if (code >= 500) {
          stats.dbErrors++;
          deps.onDbError?.("api", error);
          return fail(reply, 500, "internal");
        }
        stats.invalid++;
        return fail(reply, code, code === 413 ? "too-large" : "invalid");
      });
      api.setNotFoundHandler((_request, reply) => fail(reply, 404, "not-found"));

      /** Takes one token of the address's budget; answers 429 itself when there is none. */
      const spendRequest = (request: FastifyRequest, reply: FastifyReply): boolean => {
        if (requestBudget.take(ipKey(request.ip))) return true;
        stats.rateLimited++;
        void reply.header("Retry-After", "30");
        void fail(reply, 429, "rate-limited");
        return false;
      };

      api.post(
        relative(TELEMETRY_PATH),
        { bodyLimit: TELEMETRY_MAX_BODY_BYTES },
        async (request, reply) => {
          if (!spendRequest(request, reply)) return reply;
          const parsed = parseTelemetryBatch(request.body);
          if (!parsed.ok) {
            stats.invalid++;
            return fail(reply, 400, "invalid");
          }
          const { batch, rejected } = parsed.value;
          const key = ipKey(request.ip);
          try {
            const outcome = await ingestBatch(repository, batch, rejected, {
              receivedAt: deps.clock(),
              userAgent: request.headers["user-agent"],
              eventsMaxAgeMs: config.retention.eventsDays * DAY_MS,
              gamesMaxAgeMs: config.retention.gamesDays * DAY_MS,
              admitNewPlayer: () => newPlayerBudget.take(key),
            });
            if (outcome.kind === "new-player-limit") {
              stats.newPlayerLimited++;
              void reply.header("Retry-After", "600");
              return fail(reply, 429, "rate-limited");
            }
            const { ack } = outcome;
            const t = stats.telemetry;
            t.batches++;
            if (ack.optedOut) t.optedOut++;
            t.eventsStored += ack.stored.events;
            t.eventsDuplicate += ack.duplicates.events;
            t.gamesStored += ack.stored.games;
            t.gamesDuplicate += ack.duplicates.games;
            t.historyStored += ack.stored.history;
            t.historyDuplicate += ack.duplicates.history;
            t.itemsRejected += ack.rejected;
            t.itemsStale += ack.stale;
            return ack;
          } catch (error) {
            return dbFailed(reply, "telemetry", error);
          }
        },
      );

      api.put<{ Params: { id: string }; Body: unknown }>(
        `${relative(PLAYERS_PATH)}/:id/telemetry`,
        { bodyLimit: 1024 },
        async (request, reply) => {
          if (!spendRequest(request, reply)) return reply;
          const { id } = request.params;
          const body = request.body as { optOut?: unknown } | null;
          if (!isPlayerId(id) || typeof body?.optOut !== "boolean") {
            stats.invalid++;
            return fail(reply, 400, "invalid");
          }
          try {
            // The flag lives on the player's row, so the row has to exist; it holds nothing else.
            await repository.touchPlayer(id, deps.clock());
            await repository.setTelemetryOptOut(id, body.optOut);
            stats.optOutChanges++;
            return { ok: true, optOut: body.optOut };
          } catch (error) {
            return dbFailed(reply, "opt-out", error);
          }
        },
      );

      api.delete<{ Params: { id: string } }>(
        `${relative(PLAYERS_PATH)}/:id`,
        async (request, reply) => {
          if (!spendRequest(request, reply)) return reply;
          const { id } = request.params;
          if (!isPlayerId(id)) {
            stats.invalid++;
            return fail(reply, 400, "invalid");
          }
          try {
            await repository.deletePlayer(id);
            stats.playersDeleted++;
            // The same answer whether or not anything was stored: the id is not an oracle.
            return { ok: true };
          } catch (error) {
            return dbFailed(reply, "delete-player", error);
          }
        },
      );
    },
    { prefix: API_PREFIX },
  );

  return {
    stats: () => ({ ...stats, telemetry: { ...stats.telemetry } }),
    sweep() {
      requestBudget.sweep();
      newPlayerBudget.sweep();
    },
  };
}
