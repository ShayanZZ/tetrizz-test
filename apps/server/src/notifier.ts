/**
 * Messages from the server to its owner, over Telegram and/or a Discord webhook.
 *
 * What is sent is decided elsewhere (`alerts.ts`); this file only delivers. Delivery never throws
 * and never blocks the caller for long: a message that cannot be sent is counted and logged, and
 * the server carries on. The bot token is part of the Telegram address, so errors are logged by
 * name and status only, never with the address.
 */
import type { NotifySettings } from "./config";

export type NoticeKind =
  | "restart"
  | "digest"
  | "budget"
  | "db-failure"
  | "janitor-failure"
  | "lag"
  | "error-spike"
  | "test";

export type Severity = "info" | "warn" | "alert";

export interface Notice {
  kind: NoticeKind;
  severity: Severity;
  title: string;
  lines: string[];
  /**
   * Notices with the same key share one cooldown; the kind is the key unless this says otherwise
   * (two different janitor jobs failing are two problems).
   */
  key?: string;
}

export interface NotifierStats {
  sent: number;
  failed: number;
  /** Notices held back because the same one was sent a moment ago. */
  suppressed: number;
}

export interface Notifier {
  /** Names of the channels that are set up; empty when nothing will be sent. */
  readonly channels: readonly string[];
  /** Delivers a notice unless its cooldown is running. Resolves `true` when something was sent. */
  notify(notice: Notice): Promise<boolean>;
  stats(): NotifierStats;
  /** Resolves when every message handed over so far has been delivered or given up. */
  idle(): Promise<void>;
}

export interface NotifierDeps {
  fetch?: typeof fetch;
  /** Wall-clock milliseconds. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: { warn(obj: object, msg: string): void; debug(obj: object, msg: string): void };
}

const SEND_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 1500;
const TELEGRAM_LIMIT = 4000;
const DISCORD_LIMIT = 1900;

/** Kinds that mark a single event, not a condition that persists: they are never held back for long. */
const SHORT_COOLDOWN: Partial<Record<NoticeKind, number>> = {
  restart: 60_000,
  digest: 60_000,
  test: 0,
};

const TAG: Record<Severity, string> = { info: "INFO", warn: "WARNING", alert: "ALERT" };

/** Removes anything that looks like `user:password@` from text that may reach a chat. */
export function redact(text: string): string {
  return text.replace(/\/\/[^/\s:@]+:[^@\s/]+@/g, "//***@");
}

export function formatNotice(serverName: string, notice: Notice, suppressed = 0): string {
  const head = `[${TAG[notice.severity]}] ${serverName}: ${notice.title}`;
  const tail =
    suppressed > 0 ? [`(${suppressed} like this were held back since the last message)`] : [];
  return [head, ...notice.lines, ...tail].join("\n");
}

function errorName(error: unknown): string {
  if (!(error instanceof Error)) return "error";
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = typeof cause?.code === "string" ? `:${cause.code}` : "";
  return `${error.name}${code}`;
}

export function createNotifier(settings: NotifySettings, deps: NotifierDeps = {}): Notifier {
  const doFetch = deps.fetch ?? fetch;
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const channels: string[] = [];
  if (settings.telegram) channels.push("telegram");
  if (settings.discordWebhook) channels.push("discord");

  const counters: NotifierStats = { sent: 0, failed: 0, suppressed: 0 };
  const lastSent = new Map<string, number>();
  const held = new Map<string, number>();
  let queue: Promise<void> = Promise.resolve();

  /** One attempt; resolves with an error word on failure and `null` on success. */
  async function attempt(url: string, body: unknown): Promise<string | null> {
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.ok) return null;
      void res.body?.cancel().catch(() => {});
      return `http-${res.status}`;
    } catch (error) {
      return errorName(error);
    }
  }

  async function post(channel: string, url: string, body: unknown): Promise<boolean> {
    let problem = await attempt(url, body);
    // A network error, a busy service or a rate limit is worth one more try; a rejected request is not.
    if (problem !== null && (!problem.startsWith("http-") || /^http-(429|5\d\d)$/.test(problem))) {
      await sleep(RETRY_DELAY_MS);
      problem = await attempt(url, body);
    }
    if (problem !== null) deps.log?.warn({ channel, problem }, "notification not delivered");
    return problem === null;
  }

  async function deliver(text: string): Promise<boolean> {
    const jobs: Array<Promise<boolean>> = [];
    if (settings.telegram) {
      const { token, chatId } = settings.telegram;
      jobs.push(
        post("telegram", `https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chatId,
          text: text.slice(0, TELEGRAM_LIMIT),
          disable_web_page_preview: true,
        }),
      );
    }
    if (settings.discordWebhook) {
      jobs.push(
        post("discord", settings.discordWebhook, {
          content: text.slice(0, DISCORD_LIMIT),
          // A message must never ping anybody.
          allowed_mentions: { parse: [] },
        }),
      );
    }
    const results = await Promise.all(jobs);
    return results.some(Boolean);
  }

  return {
    channels,
    async notify(notice) {
      if (channels.length === 0) return false;
      const key = notice.key ?? notice.kind;
      const now = clock();
      const cooldown = SHORT_COOLDOWN[notice.kind] ?? settings.cooldownMs;
      const before = lastSent.get(key);
      if (before !== undefined && now - before < cooldown) {
        counters.suppressed++;
        held.set(key, (held.get(key) ?? 0) + 1);
        return false;
      }
      lastSent.set(key, now);
      const text = redact(formatNotice(settings.serverName, notice, held.get(key) ?? 0));
      held.delete(key);
      // Messages go out one at a time, in the order they were made.
      const job = queue.then(() => deliver(text));
      queue = job.then(
        () => undefined,
        () => undefined,
      );
      const ok = await job;
      if (ok) counters.sent++;
      else counters.failed++;
      return ok;
    },
    stats: () => ({ ...counters }),
    idle: () => queue,
  };
}
