/** `/metrics`, the start and failure messages, and the maintenance job, through the real server on a real port. */
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { playerIdFromKey, sha256Hex } from "@tetrizz/protocol";
import { WebSocket } from "ws";
import { createServerApp, type ServerApp } from "../../apps/server/src/app";
import { loadConfig, type ServerConfig } from "../../apps/server/src/config";
import { mayReadMetrics } from "../../apps/server/src/metrics";
import { openRepository, type Repository } from "../../apps/server/src/db";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const KEY_A = sha256Hex("metrics-test:a");
const A = playerIdFromKey(KEY_A);
const TOKEN = "scrape-token-0123456789";

const apps: ServerApp[] = [];
const repos: Repository[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.shutdown().catch(() => {});
  for (const r of repos.splice(0)) await r.close().catch(() => {});
});

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers["content-type"] ?? ""),
          text: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function post(port: number, path: string, body: unknown) {
  return new Promise<number>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          origin: `http://127.0.0.1:${port}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

interface Sent {
  url: string;
  body: { text?: string; content?: string };
}

async function start(
  env: Record<string, string> = {},
  wrap?: (r: Repository) => Repository,
  listen = true,
) {
  const repository = await openRepository({ driver: "sqlite", path: ":memory:", now: () => NOW });
  repos.push(repository);
  const sent: Sent[] = [];
  const fakeFetch = (async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const config: ServerConfig = {
    ...loadConfig({ LOG_LEVEL: "silent", PORT: "0", ...env }).config,
    statsLogMs: 0,
    heartbeatMs: 40,
    janitor: { ...loadConfig({}).config.janitor, startDelayMs: 3_600_000 },
  };
  const app = await createServerApp(config, {
    repository: wrap ? wrap(repository) : repository,
    clock: () => NOW,
    fetch: fakeFetch,
    sleep: async () => {},
    version: "9.9.9",
  });
  apps.push(app);
  const port = listen ? await app.listen() : 0;
  return { app, port, repository, sent };
}

const TELEGRAM = {
  TELEGRAM_BOT_TOKEN: "123456789:AAFakeTokenFakeTokenFakeTokenFake_x",
  TELEGRAM_CHAT_ID: "-1001",
};

describe("/metrics access", () => {
  it("is not there unless METRICS=on", async () => {
    const { port } = await start();
    expect((await get(port, "/metrics")).status).toBe(404);
  });

  it("answers a direct request, but not one that came through a proxy", async () => {
    const { port } = await start({ METRICS: "on" });
    const ok = await get(port, "/metrics");
    expect(ok.status).toBe(200);
    expect(ok.type).toContain("text/plain");
    expect((await get(port, "/metrics", { "x-forwarded-for": "203.0.113.9" })).status).toBe(404);
    expect((await get(port, "/metrics", { forwarded: "for=203.0.113.9" })).status).toBe(404);
  });

  it("with a token answers only that token, proxied or not", async () => {
    const { port } = await start({ METRICS: "on", METRICS_TOKEN: TOKEN });
    expect((await get(port, "/metrics")).status).toBe(404);
    expect(
      (await get(port, "/metrics", { authorization: "Bearer wrong-token-0123456789" })).status,
    ).toBe(404);
    expect(
      (
        await get(port, "/metrics", {
          authorization: `Bearer ${TOKEN}`,
          "x-forwarded-for": "203.0.113.9",
        })
      ).status,
    ).toBe(200);
  });

  it("decides in one place", () => {
    expect(mayReadMetrics({ enabled: false, token: null }, {})).toBe(false);
    expect(mayReadMetrics({ enabled: true, token: null }, {})).toBe(true);
    expect(
      mayReadMetrics({ enabled: true, token: TOKEN }, { authorization: `Bearer ${TOKEN}x` }),
    ).toBe(false);
  });
});

describe("/metrics content", () => {
  it("shows the server, API, maintenance and ping figures", async () => {
    const { app, port } = await start({ METRICS: "on" });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    await new Promise((r) => ws.once("open", r));
    const status = await post(port, "/api/v1/telemetry", {
      v: 1,
      playerId: A,
      key: KEY_A,
      sentAt: NOW,
      games: [
        {
          id: "game-00000001",
          mode: "sprint",
          startedAt: NOW - 60_000,
          durationMs: 45_000,
          players: [{ playerId: A, result: "finished", lines: 40, score: 1, pieces: 1 }],
        },
      ],
    });
    expect(status).toBe(200);
    await app.janitor!.runLive();
    await app.janitor!.runSettle();
    await new Promise((r) => setTimeout(r, 150)); // a few heartbeats
    const text = (await get(port, "/metrics")).text;
    ws.close();
    expect(text).toContain('tetrizz_info{version="9.9.9",driver="sqlite"} 1');
    expect(text).toMatch(/^tetrizz_connections 1$/m);
    expect(text).toMatch(/^tetrizz_connections_accepted_total 1$/m);
    expect(text).toMatch(/^tetrizz_api_requests_total 1$/m);
    expect(text).toContain('tetrizz_telemetry_items_total{kind="game",outcome="stored"} 1');
    expect(text).toContain('tetrizz_games_today{mode="sprint"} 1');
    expect(text).toMatch(/^tetrizz_db_up 1$/m);
    expect(text).toMatch(/^tetrizz_players_active_today 1$/m);
    expect(text).toContain('tetrizz_janitor_runs_total{job="live",result="ok"} 1');
    expect(text).toContain('tetrizz_db_rows{table="games"} 1');
    expect(text).toMatch(/^tetrizz_ping_seconds_count [1-9]/m);
    expect(text).toContain("process_cpu_seconds_total");
    expect(text).not.toMatch(/^tetrizz_db_budget_bytes /m); // no budget set
  });

  it("scrapes twice without counting twice", async () => {
    const { port } = await start({ METRICS: "on" });
    await get(port, "/metrics");
    const second = (await get(port, "/metrics")).text;
    expect(second).toMatch(/^tetrizz_connections_accepted_total 0$/m);
    expect(second).toMatch(/^tetrizz_api_requests_total 0$/m);
  });
});

describe("messages to the owner", () => {
  it("announces the start on Telegram when listening begins", async () => {
    const { app, sent } = await start(TELEGRAM);
    await app.notifier.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("/sendMessage");
    expect(sent[0]!.body.text).toContain("[INFO] TetriZZ server: started");
    expect(sent[0]!.body.text).toContain("Version 9.9.9");
  });

  it("tells the owner when the database fails during a request, and keeps the token out of it", async () => {
    const { app, port, sent } = await start(TELEGRAM, (r) => ({
      ...r,
      touchPlayer: async () => {
        throw new Error("connection refused");
      },
    }));
    const status = await post(port, "/api/v1/telemetry", {
      v: 1,
      playerId: A,
      key: KEY_A,
      sentAt: NOW,
      events: [],
    });
    expect(status).toBeGreaterThanOrEqual(500);
    await app.notifier.idle();
    const failure = sent.find((s) => String(s.body.text).includes("the database is failing"));
    expect(failure).toBeDefined();
    expect(String(failure!.body.text)).toContain("connection refused");
    // The token is part of the address it is sent to, and nowhere in what is said.
    expect(JSON.stringify(sent.map((s) => s.body))).not.toContain("AAFakeToken");
  });

  it("counts unexpected errors and raises the burst alert", async () => {
    const { app, sent } = await start({ ...TELEGRAM, NOTIFY_ERROR_SPIKE: "2" }, undefined, false);
    app.fastify.get("/boom", async () => {
      throw new Error("kaboom");
    });
    await app.fastify.inject({ method: "GET", url: "/boom" });
    await app.fastify.inject({ method: "GET", url: "/boom" });
    await app.notifier.idle();
    expect(sent.some((s) => String(s.body.text).includes("many errors in a short time"))).toBe(
      true,
    );
  });

  it("sends nothing when no channel is set up", async () => {
    const { app, sent } = await start();
    await app.notifier.idle();
    expect(app.notifier.channels).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});
