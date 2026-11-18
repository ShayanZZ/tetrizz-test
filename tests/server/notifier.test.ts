/** Delivery to Telegram and Discord: what is sent, what is held back, what never leaks. */
import { describe, expect, it } from "vitest";
import type { NotifySettings } from "../../apps/server/src/config";
import { createNotifier, formatNotice, redact, type Notice } from "../../apps/server/src/notifier";

const TOKEN = "123456789:AAFakeTokenFakeTokenFakeTokenFake_x";
const HOOK = "https://discord.com/api/webhooks/1/secret-part";

const settings = (over: Partial<NotifySettings> = {}): NotifySettings => ({
  telegram: { token: TOKEN, chatId: "-1001" },
  discordWebhook: HOOK,
  serverName: "Test box",
  digestHourUtc: 7,
  lagMs: 500,
  errorSpikeCount: 20,
  errorSpikeWindowMs: 300_000,
  cooldownMs: 30 * 60_000,
  ...over,
});

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function recorder(plan: Array<number | "network"> = []): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const fake = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = plan[n++] ?? 200;
    if (next === "network")
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    return new Response("{}", { status: next });
  }) as unknown as typeof fetch;
  return { fetch: fake, calls };
}

const notice = (over: Partial<Notice> = {}): Notice => ({
  kind: "db-failure",
  severity: "alert",
  title: "the database is failing",
  lines: ["In rollup: boom"],
  ...over,
});

const noSleep = async (): Promise<void> => {};

describe("notifier", () => {
  it("sends to both channels, with no mention allowed on Discord", async () => {
    const { fetch, calls } = recorder();
    const n = createNotifier(settings(), { fetch, sleep: noSleep });
    expect(n.channels).toEqual(["telegram", "discord"]);
    expect(await n.notify(notice())).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]!.body.chat_id).toBe("-1001");
    expect(String(calls[0]!.body.text)).toBe(
      "[ALERT] Test box: the database is failing\nIn rollup: boom",
    );
    expect(calls[1]!.url).toBe(HOOK);
    expect(calls[1]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(n.stats()).toEqual({ sent: 1, failed: 0, suppressed: 0 });
  });

  it("does nothing when no channel is set up", async () => {
    const { fetch, calls } = recorder();
    const n = createNotifier(settings({ telegram: null, discordWebhook: null }), { fetch });
    expect(n.channels).toEqual([]);
    expect(await n.notify(notice())).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("holds back a repeat inside the cooldown and says how many on the next message", async () => {
    const { fetch, calls } = recorder();
    let now = 1_000_000;
    const n = createNotifier(settings({ discordWebhook: null }), {
      fetch,
      clock: () => now,
      sleep: noSleep,
    });
    await n.notify(notice());
    await n.notify(notice());
    await n.notify(notice());
    expect(calls).toHaveLength(1);
    expect(n.stats().suppressed).toBe(2);
    now += 31 * 60_000;
    await n.notify(notice());
    expect(calls).toHaveLength(2);
    expect(String(calls[1]!.body.text)).toContain("2 like this were held back");
  });

  it("keeps separate cooldowns per key", async () => {
    const { fetch, calls } = recorder();
    const n = createNotifier(settings({ discordWebhook: null }), { fetch, sleep: noSleep });
    await n.notify(notice({ kind: "janitor-failure", key: "janitor-failure:live" }));
    await n.notify(notice({ kind: "janitor-failure", key: "janitor-failure:settle" }));
    expect(calls).toHaveLength(2);
  });

  it("retries once after a network error or a 5xx, but not after a rejected request", async () => {
    const a = recorder(["network", 200]);
    const n1 = createNotifier(settings({ discordWebhook: null }), {
      fetch: a.fetch,
      sleep: noSleep,
    });
    expect(await n1.notify(notice())).toBe(true);
    expect(a.calls).toHaveLength(2);

    const b = recorder([503, 503]);
    const n2 = createNotifier(settings({ discordWebhook: null }), {
      fetch: b.fetch,
      sleep: noSleep,
    });
    expect(await n2.notify(notice())).toBe(false);
    expect(b.calls).toHaveLength(2);
    expect(n2.stats().failed).toBe(1);

    const c = recorder([400]);
    const n3 = createNotifier(settings({ discordWebhook: null }), {
      fetch: c.fetch,
      sleep: noSleep,
    });
    expect(await n3.notify(notice())).toBe(false);
    expect(c.calls).toHaveLength(1);
  });

  it("counts the message as sent when one channel works and the other does not", async () => {
    const { fetch } = recorder([200, 400]);
    const n = createNotifier(settings(), { fetch, sleep: noSleep });
    expect(await n.notify(notice())).toBe(true);
  });

  it("never logs the bot token or the webhook address", async () => {
    const lines: string[] = [];
    const log = {
      warn: (o: object, m: string) => lines.push(JSON.stringify([o, m])),
      debug: (o: object, m: string) => lines.push(JSON.stringify([o, m])),
    };
    const { fetch } = recorder(["network", "network", "network", "network"]);
    const n = createNotifier(settings(), { fetch, sleep: noSleep, log });
    await n.notify(notice());
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("secret-part");
    expect(all).toContain("ECONNRESET");
  });

  it("cuts a long message to what each service accepts", async () => {
    const { fetch, calls } = recorder();
    const n = createNotifier(settings(), { fetch, sleep: noSleep });
    await n.notify(notice({ lines: ["x".repeat(9000)] }));
    expect(String(calls[0]!.body.text).length).toBeLessThanOrEqual(4000);
    expect(String(calls[1]!.body.content).length).toBeLessThanOrEqual(1900);
  });

  it("does not hold back a start notice for half an hour, only for a minute", async () => {
    const { fetch, calls } = recorder();
    let now = 5_000_000;
    const n = createNotifier(settings({ discordWebhook: null }), { fetch, clock: () => now });
    await n.notify(notice({ kind: "restart", severity: "info" }));
    now += 90_000;
    await n.notify(notice({ kind: "restart", severity: "info" }));
    expect(calls).toHaveLength(2);
  });

  it("redacts credentials in an address and formats the head line", () => {
    expect(redact("connect postgres://user:hunter2@db:5432/x failed")).toBe(
      "connect postgres://***@db:5432/x failed",
    );
    expect(formatNotice("Box", { kind: "test", severity: "warn", title: "t", lines: [] })).toBe(
      "[WARNING] Box: t",
    );
  });
});
