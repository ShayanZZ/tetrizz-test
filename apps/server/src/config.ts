/**
 * The server's settings, read from environment variables once at start. Nothing is read from a
 * file and nothing here is secret. A value that is set but wrong is a problem the operator must fix:
 * `loadConfig` lists every one instead of quietly falling back to a default.
 */
import { isIP } from "node:net";
import { SERVER_SEAT_GRACE_MS } from "@tetrizz/protocol";
import type { OriginPolicy } from "./origin";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
const LOG_LEVELS: readonly string[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
];

/** Where the server keeps what it learns about play. `off` keeps nothing: rooms still work. */
export type DatabaseSettings =
  | { driver: "off" }
  | { driver: "sqlite"; path: string }
  | { driver: "postgres"; url: string; schema?: string; poolMax: number };

/** How long each kind of row is kept, in days. Daily rollups are kept for ever. */
export interface RetentionSettings {
  eventsDays: number;
  gamesDays: number;
  sessionsDays: number;
}

export interface TelemetrySettings {
  /** Requests to `/api/v1` that change something, per address. */
  requestsPerMinute: number;
  requestBurst: number;
  /** Player ids one address may bring in per hour (an id the server has not seen before). */
  newPlayersPerHour: number;
}

/** `/metrics` for Prometheus. Off by default; see docs/SERVER.md for who may read it. */
export interface MetricsSettings {
  enabled: boolean;
  /** When set, a request must carry `Authorization: Bearer <token>`. */
  token: string | null;
}

/** The background job that rolls days up, purges old rows and watches the size budget. */
export interface JanitorSettings {
  enabled: boolean;
  /** How often today's rollup is refreshed. */
  liveMs: number;
  /** How often the last days are rolled up again, old rows are purged and the size is checked. */
  settleMs: number;
  /** Days before today that the settle pass rolls up again, for offline uploads that arrive late. */
  lookbackDays: number;
  /** Rows deleted per statement while purging. */
  purgeBatch: number;
  /** Days rolled up once after every start, so a server that was down does not leave gaps. */
  catchUpDays: number;
  /** Wait after the server starts listening before the first run. */
  startDelayMs: number;
}

/** Messages to the owner. Telegram and Discord are optional and independent. */
export interface NotifySettings {
  telegram: { token: string; chatId: string } | null;
  discordWebhook: string | null;
  /** Put at the start of every message so several servers can share one chat. */
  serverName: string;
  /** UTC hour of the daily digest, or null for none. */
  digestHourUtc: number | null;
  /** Event-loop delay (99th percentile over ten seconds) above which an alert is sent; 0 is off. */
  lagMs: number;
  /** Errors within the window that make a spike; 0 is off. */
  errorSpikeCount: number;
  errorSpikeWindowMs: number;
  /** The least time between two messages of the same kind. */
  cooldownMs: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Fastify's `trustProxy`: false, the number of proxies in front, or a list of proxy addresses. */
  trustProxy: false | number | string;
  logLevel: LogLevel;
  origins: OriginPolicy;
  /** How long a dropped player's seat is held, in milliseconds. */
  seatGraceMs: number;
  maxRooms: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
  connectsPerMinutePerIp: number;
  messagesPerSecond: number;
  messageBurst: number;
  /** Password checks (room create, join with a password, password change) per address. */
  passwordChecksPerMinute: number;
  passwordBurst: number;
  /** How often a silent socket is pinged; one that has not answered by the next round is cut. */
  heartbeatMs: number;
  /** A socket that sends nothing at all this long after connecting is cut. */
  helloTimeoutMs: number;
  /** A page that is this far behind on reading is cut instead of letting memory grow. */
  maxBufferedBytes: number;
  shutdownGraceMs: number;
  /** Zero turns the periodic summary line off. */
  statsLogMs: number;
  database: DatabaseSettings;
  retention: RetentionSettings;
  /** Soft ceiling for the database in megabytes; 0 means no ceiling. */
  dbMaxMb: number;
  telemetry: TelemetrySettings;
  metrics: MetricsSettings;
  janitor: JanitorSettings;
  notify: NotifySettings;
}

export interface LoadedConfig {
  config: ServerConfig;
  problems: string[];
}

type Env = Record<string, string | undefined>;

const PROXY_NAMES = new Set(["loopback", "linklocal", "uniquelocal"]);

function isProxyEntry(entry: string): boolean {
  if (PROXY_NAMES.has(entry) || isIP(entry) !== 0) return true;
  const [address = "", bits = ""] = entry.split("/");
  const max = isIP(address) === 6 ? 128 : 32;
  return isIP(address) !== 0 && /^\d{1,3}$/.test(bits) && Number(bits) <= max;
}

export function loadConfig(env: Env): LoadedConfig {
  const problems: string[] = [];
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^-?\d+$/.test(raw) || n < min || n > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
      return fallback;
    }
    return n;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const raw = read(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    problems.push(`${name} must be true or false (got "${raw}")`);
    return fallback;
  };

  const hourOrOff = (name: string, fallback: number | null): number | null => {
    const raw = read(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (raw === "off") return null;
    const n = Number(raw);
    if (!/^\d{1,2}$/.test(raw) || n > 23) {
      problems.push(`${name} must be a whole hour from 0 to 23, or off (got "${raw}")`);
      return fallback;
    }
    return n;
  };

  const allowed = new Set<string>();
  for (const entry of (read("ALLOWED_ORIGINS") ?? "").split(",")) {
    const text = entry.trim();
    if (!text) continue;
    try {
      const url = new URL(text);
      const plain = url.pathname === "/" && !url.search && !url.hash && !url.username;
      if ((url.protocol !== "http:" && url.protocol !== "https:") || !plain) throw new Error();
      allowed.add(url.origin);
    } catch {
      problems.push(`ALLOWED_ORIGINS entry "${text}" must look like https://play.example`);
    }
  }

  let trustProxy: ServerConfig["trustProxy"] = false;
  const proxyRaw = read("TRUST_PROXY");
  if (proxyRaw !== undefined && proxyRaw.toLowerCase() !== "false") {
    if (/^\d+$/.test(proxyRaw)) {
      trustProxy = Number(proxyRaw) > 0 ? Number(proxyRaw) : false;
    } else if (proxyRaw.split(",").every((e) => isProxyEntry(e.trim()))) {
      trustProxy = proxyRaw
        .split(",")
        .map((e) => e.trim())
        .join(",");
    } else {
      problems.push(
        'TRUST_PROXY must be false, the number of proxies in front of the server (1 for Caddy), or a comma-separated list of proxy addresses; "true" would let anyone choose the address they are limited by',
      );
    }
  }

  const logRaw = read("LOG_LEVEL")?.toLowerCase();
  let logLevel: LogLevel = "info";
  if (logRaw !== undefined) {
    if (LOG_LEVELS.includes(logRaw)) logLevel = logRaw as LogLevel;
    else problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (got "${logRaw}")`);
  }

  const dbRaw = read("DB_DRIVER")?.toLowerCase();
  let database: DatabaseSettings = { driver: "off" };
  if (dbRaw === undefined || dbRaw === "off" || dbRaw === "none") {
    database = { driver: "off" };
  } else if (dbRaw === "sqlite") {
    database = { driver: "sqlite", path: read("SQLITE_PATH") ?? "./data/sqlite/tetrizz.db" };
  } else if (dbRaw === "postgres") {
    const url = read("DATABASE_URL");
    const schema = read("DB_SCHEMA");
    if (url === undefined || !/^postgres(ql)?:\/\//i.test(url)) {
      problems.push(
        "DATABASE_URL must start with postgres:// or postgresql:// when DB_DRIVER=postgres",
      );
    }
    if (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) {
      problems.push(
        `DB_SCHEMA must be a plain name of letters, digits and underscores (got "${schema}")`,
      );
    }
    database = {
      driver: "postgres",
      url: url ?? "",
      ...(schema !== undefined ? { schema } : {}),
      poolMax: int("DB_POOL_MAX", 5, 1, 50),
    };
  } else {
    problems.push(`DB_DRIVER must be off, sqlite or postgres (got "${dbRaw}")`);
  }

  const telegramToken = read("TELEGRAM_BOT_TOKEN");
  const telegramChat = read("TELEGRAM_CHAT_ID");
  if ((telegramToken === undefined) !== (telegramChat === undefined)) {
    problems.push("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together");
  }
  if (telegramToken !== undefined && !/^\d{3,}:[A-Za-z0-9_-]{20,}$/.test(telegramToken)) {
    problems.push("TELEGRAM_BOT_TOKEN does not look like a bot token (123456:ABC...)");
  }
  if (
    telegramChat !== undefined &&
    !/^-?\d{1,20}$|^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegramChat)
  ) {
    problems.push("TELEGRAM_CHAT_ID must be a number (a group's is negative) or @channelname");
  }
  let discordWebhook: string | null = null;
  const discordRaw = read("DISCORD_WEBHOOK_URL");
  if (discordRaw !== undefined) {
    try {
      const url = new URL(discordRaw);
      if (url.protocol !== "https:" || url.username || url.hash) throw new Error();
      discordWebhook = url.href;
    } catch {
      problems.push("DISCORD_WEBHOOK_URL must be an https:// webhook address");
    }
  }
  const metricsRaw = read("METRICS")?.toLowerCase();
  if (metricsRaw !== undefined && !["on", "off"].includes(metricsRaw)) {
    problems.push(`METRICS must be on or off (got "${metricsRaw}")`);
  }
  const metricsToken = read("METRICS_TOKEN");
  if (metricsToken !== undefined && !/^[\x21-\x7e]{16,200}$/.test(metricsToken)) {
    problems.push("METRICS_TOKEN must be 16 to 200 printable characters without spaces");
  }

  const config: ServerConfig = {
    host: read("HOST") ?? "127.0.0.1",
    port: int("PORT", 8787, 0, 65535),
    trustProxy,
    logLevel,
    origins: {
      allowed,
      allowSameOrigin: bool("ALLOW_SAME_ORIGIN", true),
      allowFile: bool("ALLOW_FILE_ORIGIN", false),
      allowMissing: bool("ALLOW_MISSING_ORIGIN", false),
    },
    seatGraceMs: int("SEAT_GRACE_SECONDS", SERVER_SEAT_GRACE_MS / 1000, 0, 600) * 1000,
    maxRooms: int("MAX_ROOMS", 200, 1, 100_000),
    maxConnections: int("MAX_CONNECTIONS", 500, 1, 100_000),
    maxConnectionsPerIp: int("MAX_CONNECTIONS_PER_IP", 8, 1, 10_000),
    connectsPerMinutePerIp: int("CONNECTS_PER_MINUTE_PER_IP", 30, 1, 100_000),
    messagesPerSecond: int("MESSAGES_PER_SECOND", 30, 1, 10_000),
    messageBurst: int("MESSAGE_BURST", 100, 1, 100_000),
    passwordChecksPerMinute: int("PASSWORD_CHECKS_PER_MINUTE", 60, 1, 100_000),
    passwordBurst: 20,
    heartbeatMs: int("HEARTBEAT_SECONDS", 20, 1, 600) * 1000,
    helloTimeoutMs: 10_000,
    maxBufferedBytes: 1024 * 1024,
    shutdownGraceMs: int("SHUTDOWN_GRACE_SECONDS", 5, 0, 120) * 1000,
    statsLogMs: int("STATS_LOG_SECONDS", 300, 0, 86_400) * 1000,
    database,
    retention: {
      eventsDays: int("RETENTION_EVENTS_DAYS", 30, 1, 3650),
      gamesDays: int("RETENTION_GAMES_DAYS", 180, 1, 3650),
      sessionsDays: int("RETENTION_SESSIONS_DAYS", 180, 1, 3650),
    },
    dbMaxMb: int("DB_MAX_MB", 0, 0, 10_000_000),
    telemetry: {
      requestsPerMinute: int("TELEMETRY_REQUESTS_PER_MINUTE", 30, 1, 100_000),
      requestBurst: 10,
      newPlayersPerHour: int("NEW_PLAYERS_PER_HOUR_PER_IP", 60, 1, 100_000),
    },
    metrics: { enabled: metricsRaw === "on", token: metricsToken ?? null },
    janitor: {
      enabled: bool("JANITOR", true),
      liveMs: int("JANITOR_LIVE_SECONDS", 300, 5, 3600) * 1000,
      settleMs: int("JANITOR_SETTLE_MINUTES", 60, 1, 1440) * 60_000,
      lookbackDays: int("JANITOR_LOOKBACK_DAYS", 3, 1, 30),
      purgeBatch: int("JANITOR_PURGE_BATCH", 5000, 10, 1_000_000),
      catchUpDays: 14,
      startDelayMs: 10_000,
    },
    notify: {
      telegram:
        telegramToken !== undefined && telegramChat !== undefined
          ? { token: telegramToken, chatId: telegramChat }
          : null,
      discordWebhook,
      serverName: read("SERVER_NAME") ?? "TetriZZ server",
      digestHourUtc: hourOrOff("NOTIFY_DIGEST_HOUR_UTC", 7),
      lagMs: int("NOTIFY_LAG_MS", 500, 0, 60_000),
      errorSpikeCount: int("NOTIFY_ERROR_SPIKE", 20, 0, 100_000),
      errorSpikeWindowMs: int("NOTIFY_ERROR_WINDOW_SECONDS", 300, 10, 86_400) * 1000,
      cooldownMs: int("NOTIFY_COOLDOWN_MINUTES", 30, 1, 1440) * 60_000,
    },
  };
  return { config, problems };
}
