export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly time: number;
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const CAPACITY = 200;

let threshold = RANK.warn;
const ring: LogEntry[] = [];

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function write(level: LogLevel, scope: string, args: readonly unknown[]): void {
  if (RANK[level] < threshold) return;
  const entry: LogEntry = { time: Date.now(), level, scope, message: args.map(describe).join(" ") };
  ring.push(entry);
  if (ring.length > CAPACITY) ring.shift();
  try {
    console[level === "debug" ? "debug" : level](`[${scope}]`, ...args);
  } catch {
    /* a missing or locked-down console must never break the game */
  }
}

export const log = {
  debug: (scope: string, ...args: unknown[]): void => write("debug", scope, args),
  info: (scope: string, ...args: unknown[]): void => write("info", scope, args),
  warn: (scope: string, ...args: unknown[]): void => write("warn", scope, args),
  error: (scope: string, ...args: unknown[]): void => write("error", scope, args),
};

export function setLogLevel(level: string | null | undefined): void {
  if (level && level in RANK) threshold = RANK[level as LogLevel];
}

export function getLogLevel(): LogLevel {
  return (Object.keys(RANK) as LogLevel[]).find((l) => RANK[l] === threshold) ?? "warn";
}

export function recentLogs(): readonly LogEntry[] {
  return ring.slice();
}

export function clearLogs(): void {
  ring.length = 0;
}

/** For promise chains where a failure is expected and harmless: `.catch(swallow("scope"))`. */
export function swallow(scope: string): (error: unknown) => void {
  return (error) => log.debug(scope, error);
}
