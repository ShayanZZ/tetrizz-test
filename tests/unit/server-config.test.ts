import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/server/src/config";

describe("server settings", () => {
  it("has working defaults and no problems", () => {
    const { config, problems } = loadConfig({});
    expect(problems).toEqual([]);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.seatGraceMs).toBe(30_000);
    expect(config.trustProxy).toBe(false);
    expect(config.origins.allowSameOrigin).toBe(true);
    expect(config.origins.allowFile).toBe(false);
    expect(config.origins.allowMissing).toBe(false);
    expect(config.origins.allowed.size).toBe(0);
  });

  it("treats empty values as unset", () => {
    const { config, problems } = loadConfig({ PORT: "  ", ALLOWED_ORIGINS: "", LOG_LEVEL: "" });
    expect(problems).toEqual([]);
    expect(config.port).toBe(8787);
    expect(config.logLevel).toBe("info");
  });

  it("reads numbers, seconds and flags", () => {
    const { config, problems } = loadConfig({
      PORT: "9000",
      HOST: "0.0.0.0",
      SEAT_GRACE_SECONDS: "45",
      HEARTBEAT_SECONDS: "10",
      MAX_ROOMS: "20",
      ALLOW_FILE_ORIGIN: "yes",
      ALLOW_SAME_ORIGIN: "0",
      LOG_LEVEL: "DEBUG",
      STATS_LOG_SECONDS: "0",
    });
    expect(problems).toEqual([]);
    expect(config.port).toBe(9000);
    expect(config.host).toBe("0.0.0.0");
    expect(config.seatGraceMs).toBe(45_000);
    expect(config.heartbeatMs).toBe(10_000);
    expect(config.maxRooms).toBe(20);
    expect(config.origins.allowFile).toBe(true);
    expect(config.origins.allowSameOrigin).toBe(false);
    expect(config.logLevel).toBe("debug");
    expect(config.statsLogMs).toBe(0);
  });

  it("lists every wrong value and keeps the default for it", () => {
    const { config, problems } = loadConfig({
      PORT: "99999",
      SEAT_GRACE_SECONDS: "-1",
      MAX_ROOMS: "lots",
      ALLOW_FILE_ORIGIN: "maybe",
      LOG_LEVEL: "loud",
    });
    expect(problems).toHaveLength(5);
    expect(problems.join("\n")).toContain("PORT");
    expect(problems.join("\n")).toContain("SEAT_GRACE_SECONDS");
    expect(problems.join("\n")).toContain("MAX_ROOMS");
    expect(problems.join("\n")).toContain("ALLOW_FILE_ORIGIN");
    expect(problems.join("\n")).toContain("LOG_LEVEL");
    expect(config.port).toBe(8787);
    expect(config.maxRooms).toBe(200);
    expect(config.origins.allowFile).toBe(false);
  });

  it("normalises allowed origins and refuses anything that is not a bare origin", () => {
    const ok = loadConfig({ ALLOWED_ORIGINS: "https://Play.Example, http://localhost:5173/ ,," });
    expect(ok.problems).toEqual([]);
    expect([...ok.config.origins.allowed].sort()).toEqual([
      "http://localhost:5173",
      "https://play.example",
    ]);
    for (const bad of [
      "play.example",
      "ftp://play.example",
      "https://play.example/game",
      "https://play.example?x=1",
      "*",
    ]) {
      const result = loadConfig({ ALLOWED_ORIGINS: bad });
      expect(result.problems, bad).toHaveLength(1);
      expect(result.config.origins.allowed.size).toBe(0);
    }
  });

  it("accepts a proxy count or addresses for TRUST_PROXY, never plain true", () => {
    expect(loadConfig({ TRUST_PROXY: "1" }).config.trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: "0" }).config.trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "false" }).config.trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "10.0.0.0/8, loopback" }).config.trustProxy).toBe(
      "10.0.0.0/8,loopback",
    );
    expect(loadConfig({ TRUST_PROXY: "172.18.0.2" }).problems).toEqual([]);
    expect(loadConfig({ TRUST_PROXY: "true" }).problems).toHaveLength(1);
    expect(loadConfig({ TRUST_PROXY: "10.0.0.0/99" }).problems).toHaveLength(1);
    expect(loadConfig({ TRUST_PROXY: "everyone" }).problems).toHaveLength(1);
  });

  it("reads the metrics, janitor and notification settings", () => {
    const { config, problems } = loadConfig({
      METRICS: "on",
      METRICS_TOKEN: "scrape-token-0123456789",
      JANITOR: "off",
      JANITOR_LIVE_SECONDS: "60",
      JANITOR_SETTLE_MINUTES: "30",
      JANITOR_LOOKBACK_DAYS: "5",
      TELEGRAM_BOT_TOKEN: "123456789:AAFakeTokenFakeTokenFakeTokenFake_x",
      TELEGRAM_CHAT_ID: "-1001234",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc",
      SERVER_NAME: "Home VPS",
      NOTIFY_DIGEST_HOUR_UTC: "0",
      NOTIFY_LAG_MS: "250",
      NOTIFY_ERROR_SPIKE: "5",
      NOTIFY_ERROR_WINDOW_SECONDS: "120",
      NOTIFY_COOLDOWN_MINUTES: "10",
    });
    expect(problems).toEqual([]);
    expect(config.metrics).toEqual({ enabled: true, token: "scrape-token-0123456789" });
    expect(config.janitor).toMatchObject({
      enabled: false,
      liveMs: 60_000,
      settleMs: 1_800_000,
      lookbackDays: 5,
    });
    expect(config.notify.telegram).toEqual({
      token: "123456789:AAFakeTokenFakeTokenFakeTokenFake_x",
      chatId: "-1001234",
    });
    expect(config.notify.discordWebhook).toBe("https://discord.com/api/webhooks/1/abc");
    expect(config.notify).toMatchObject({
      serverName: "Home VPS",
      digestHourUtc: 0,
      lagMs: 250,
      errorSpikeCount: 5,
      errorSpikeWindowMs: 120_000,
      cooldownMs: 600_000,
    });
  });

  it("keeps metrics off, the janitor on and every channel unset by default", () => {
    const { config } = loadConfig({});
    expect(config.metrics).toEqual({ enabled: false, token: null });
    expect(config.janitor.enabled).toBe(true);
    expect(config.notify.telegram).toBeNull();
    expect(config.notify.discordWebhook).toBeNull();
    expect(config.notify.digestHourUtc).toBe(7);
    expect(loadConfig({ NOTIFY_DIGEST_HOUR_UTC: "off" }).config.notify.digestHourUtc).toBeNull();
  });

  it("names every wrong metrics or notification value and never repeats a secret", () => {
    const { problems } = loadConfig({
      METRICS: "yes",
      METRICS_TOKEN: "short",
      TELEGRAM_BOT_TOKEN: "not-a-token-at-all-but-secret",
      DISCORD_WEBHOOK_URL: "http://example.org/hook",
      NOTIFY_DIGEST_HOUR_UTC: "24",
    });
    const text = problems.join("\n");
    expect(text).toContain("METRICS must be on or off");
    expect(text).toContain("METRICS_TOKEN");
    expect(text).toContain("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together");
    expect(text).toContain("does not look like a bot token");
    expect(text).toContain("DISCORD_WEBHOOK_URL must be an https:// webhook address");
    expect(text).toContain("NOTIFY_DIGEST_HOUR_UTC");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("example.org");
  });

  it("requires a chat for the bot and rejects an odd chat id", () => {
    const token = "123456789:AAFakeTokenFakeTokenFakeTokenFake_x";
    expect(loadConfig({ TELEGRAM_CHAT_ID: "-1001" }).problems.join()).toContain(
      "must be set together",
    );
    expect(
      loadConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "abc def" }).problems.join(),
    ).toContain("TELEGRAM_CHAT_ID");
    expect(
      loadConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "@my_channel" }).problems,
    ).toEqual([]);
  });
});
