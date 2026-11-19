/**
 * deploy/alertmanager/entrypoint.sh makes Alertmanager's configuration from the ALERT_* settings.
 * These tests run it under `sh` (render only) and check what it writes: where the secrets end up,
 * which receivers exist, and that a wrong setting stops it with a message that names the setting.
 * `amtool check-config` and the routing checks run in tests/harness/check_deploy.py, where amtool is.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SOURCE = join(__dirname, "..", "..", "deploy", "alertmanager");
const runnable = process.platform === "linux" && spawnSync("sh", ["-c", "true"]).status === 0;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tzz-am-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function render(settings: Record<string, string>) {
  const result = spawnSync("sh", [join(SOURCE, "entrypoint.sh")], {
    env: {
      PATH: process.env.PATH ?? "",
      ALERTMANAGER_RENDER_ONLY: "1",
      ALERTMANAGER_RUN_DIR: dir,
      ALERTMANAGER_SOURCE_DIR: SOURCE,
      ...settings,
    },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

const config = () => readFileSync(join(dir, "alertmanager.yml"), "utf8");

describe.skipIf(!runnable)("alertmanager entrypoint", () => {
  it("makes a valid-looking configuration with no integrations at all", () => {
    const r = render({});
    expect(r.status).toBe(0);
    expect(r.out).toContain("nowhere");
    expect(config()).toMatch(/receivers:\n {2}- name: owner\n {2}- name: heartbeat\n$/);
    expect(readdirSync(dir)).toEqual(["alertmanager.yml"]);
  });

  it("keeps every secret in a file of its own, readable by its owner only, and out of the YAML", () => {
    const settings = {
      ALERT_TELEGRAM_BOT_TOKEN: "123456:ABC-secret-token",
      ALERT_TELEGRAM_CHAT_ID: "-1001234567890",
      ALERT_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/secret-hook",
      ALERT_HEARTBEAT_URL: "https://hc-ping.com/secret-uuid",
    };
    expect(render(settings).status).toBe(0);
    const yaml = config();
    for (const secret of [
      settings.ALERT_TELEGRAM_BOT_TOKEN,
      settings.ALERT_DISCORD_WEBHOOK_URL,
      settings.ALERT_HEARTBEAT_URL,
    ]) {
      expect(yaml).not.toContain(secret);
    }
    expect(yaml).toContain("chat_id: -1001234567890");
    expect(readFileSync(join(dir, "telegram-token"), "utf8")).toBe(
      settings.ALERT_TELEGRAM_BOT_TOKEN,
    );
    expect(readFileSync(join(dir, "discord-webhook"), "utf8")).toBe(
      settings.ALERT_DISCORD_WEBHOOK_URL,
    );
    expect(readFileSync(join(dir, "heartbeat-url"), "utf8")).toBe(settings.ALERT_HEARTBEAT_URL);
    for (const file of ["telegram-token", "discord-webhook", "heartbeat-url"]) {
      expect(statSync(join(dir, file)).mode & 0o077).toBe(0);
    }
  });

  it("sends the heartbeat only to the heartbeat receiver, with no resolved message", () => {
    render({ ALERT_HEARTBEAT_URL: "https://hc-ping.com/x" });
    const yaml = config();
    expect(yaml).toMatch(
      /- name: heartbeat\n {4}webhook_configs:\n {6}- url_file: .*heartbeat-url\n {8}send_resolved: false/,
    );
    expect(yaml).not.toContain("telegram_configs");
  });

  it.each([
    ["a token without a chat id", { ALERT_TELEGRAM_BOT_TOKEN: "x" }, "ALERT_TELEGRAM_CHAT_ID"],
    ["a chat id without a token", { ALERT_TELEGRAM_CHAT_ID: "12" }, "ALERT_TELEGRAM_BOT_TOKEN"],
    [
      "a chat id that is not a number",
      { ALERT_TELEGRAM_BOT_TOKEN: "x", ALERT_TELEGRAM_CHAT_ID: "me" },
      "must be a number",
    ],
    [
      "a chat id of only a minus sign",
      { ALERT_TELEGRAM_BOT_TOKEN: "x", ALERT_TELEGRAM_CHAT_ID: "-" },
      "must be a number",
    ],
    [
      "a Discord address without https",
      { ALERT_DISCORD_WEBHOOK_URL: "http://discord.example/x" },
      "https://",
    ],
    [
      "a heartbeat address without a scheme",
      { ALERT_HEARTBEAT_URL: "hc-ping.com/x" },
      "ALERT_HEARTBEAT_URL",
    ],
  ])("refuses %s", (_label, settings, message) => {
    const r = render(settings);
    expect(r.status).toBe(1);
    expect(r.err).toContain(message);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("never prints a secret", () => {
    const r = render({
      ALERT_TELEGRAM_BOT_TOKEN: "123456:ABC-secret-token",
      ALERT_TELEGRAM_CHAT_ID: "5",
    });
    expect(r.out + r.err).not.toContain("secret-token");
  });
});
