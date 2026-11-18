/**
 * The Grafana dashboards and the Prometheus alert rules under deploy/ name metrics and labels by
 * hand. This test reads /metrics from the real server and checks that everything they refer to
 * exists, so a renamed metric breaks the build instead of leaving an empty panel. It also checks
 * the dashboards' structure (unique ids, nothing overlapping, nothing wider than the grid).
 * The configuration files themselves are validated with the vendors' own tools by
 * tests/harness/check_deploy.py.
 */
import { readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerApp, type ServerApp } from "../../apps/server/src/app";
import { loadConfig } from "../../apps/server/src/config";
import { openRepository, type Repository } from "../../apps/server/src/db";

const DEPLOY = join(__dirname, "..", "..", "deploy");
const DASHBOARDS = join(DEPLOY, "grafana", "dashboards");
const RULES = join(DEPLOY, "prometheus", "rules", "tetrizz.yml");

interface Panel {
  id: number;
  type: string;
  title: string;
  datasource: { type: string; uid: string };
  gridPos: { x: number; y: number; w: number; h: number };
  targets?: { expr?: string }[];
}
interface Dashboard {
  uid: string;
  title: string;
  panels: Panel[];
}

let app: ServerApp;
let repository: Repository;
/** metric name -> label name -> values seen, from the real /metrics. */
const exposed = new Map<string, Map<string, Set<string>>>();

function get(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  repository = await openRepository({ driver: "sqlite", path: ":memory:" });
  const config = {
    ...loadConfig({ LOG_LEVEL: "silent", PORT: "0", METRICS: "on", DB_DRIVER: "sqlite" }).config,
    statsLogMs: 0,
    janitor: { ...loadConfig({}).config.janitor, startDelayMs: 3_600_000 },
  };
  app = await createServerApp(config, { repository, version: "0.0.0" });
  // One pass of each maintenance job, so the series that only exist after a run are in /metrics.
  await app.janitor!.runLive();
  await app.janitor!.runSettle();
  const port = await app.listen();
  // The job duration histogram is filled while a scrape runs, so its series show from the second scrape on.
  await get(port, "/metrics");
  const text = await get(port, "/metrics");
  const add = (name: string) => {
    if (!exposed.has(name)) exposed.set(name, new Map());
    return exposed.get(name)!;
  };
  for (const line of text.split("\n")) {
    const type = /^# TYPE (\S+) (\S+)/.exec(line);
    if (type) {
      const [, name, kind] = type as unknown as [string, string, string];
      add(name);
      if (kind === "histogram") for (const s of ["_bucket", "_sum", "_count"]) add(name + s);
      if (kind === "summary") for (const s of ["_sum", "_count"]) add(name + s);
      continue;
    }
    const sample = /^([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})?\s/.exec(line);
    if (!sample || line.startsWith("#")) continue;
    const labels = add(sample[1]!);
    for (const m of (sample[2] ?? "").matchAll(/(\w+)="([^"]*)"/g)) {
      const set = labels.get(m[1]!) ?? new Set<string>();
      set.add(m[2]!);
      labels.set(m[1]!, set);
    }
  }
});
afterAll(async () => {
  await app?.shutdown().catch(() => {});
  await repository?.close().catch(() => {});
});

const dashboards: Dashboard[] = readdirSync(DASHBOARDS)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DASHBOARDS, f), "utf8")) as Dashboard);

const promExprs = (): { where: string; expr: string }[] => [
  ...dashboards.flatMap((d) =>
    d.panels
      .filter((p) => p.datasource.type === "prometheus")
      .flatMap((p) =>
        (p.targets ?? []).map((t) => ({ where: `${d.title} / ${p.title}`, expr: t.expr ?? "" })),
      ),
  ),
  ...[...readFileSync(RULES, "utf8").matchAll(/^\s*expr:\s*(.+(?:\n\s{10,}.+)*)/gm)].map((m) => ({
    where: "alert rules",
    expr: m[1]!.replace(/\s+/g, " "),
  })),
];

describe("monitoring files refer to metrics the server really exposes", () => {
  it("reads a plausible /metrics", () => {
    expect(exposed.has("tetrizz_connections")).toBe(true);
    expect(exposed.has("tetrizz_ping_seconds_bucket")).toBe(true);
    expect(exposed.has("nodejs_eventloop_lag_p99_seconds")).toBe(true);
    expect(exposed.has("process_resident_memory_bytes")).toBe(true);
  });

  it("every tetrizz_, nodejs_ and process_ name in a query exists", () => {
    const missing: string[] = [];
    for (const { where, expr } of promExprs()) {
      for (const m of expr.matchAll(/\b((?:tetrizz|nodejs|process)_[a-z0-9_]+)\b/g)) {
        if (!exposed.has(m[1]!)) missing.push(`${where}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every label matcher on a tetrizz_ metric names a label and values that exist", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const { where, expr } of promExprs()) {
      for (const sel of expr.matchAll(/\b(tetrizz_[a-z0-9_]+)\{([^}]*)\}/g)) {
        const labels = exposed.get(sel[1]!);
        for (const m of sel[2]!.matchAll(/(\w+)\s*(=~|!~|=|!=)\s*"([^"]*)"/g)) {
          // Prometheus adds job and instance, and renames the server's own "job" label to exported_job.
          const name = m[1] === "exported_job" ? "job" : m[1]!;
          if (name === "instance" || (name === "job" && m[1] === "job")) continue;
          const seen = labels?.get(name);
          if (!seen) {
            problems.push(`${where}: ${sel[1]} has no label ${name}`);
            continue;
          }
          if (m[2] === "=" || m[2] === "=~") {
            for (const value of m[3]!.split(m[2] === "=~" ? "|" : "\u0000")) {
              checked++;
              if (!seen.has(value))
                problems.push(`${where}: ${sel[1]}{${name}="${value}"} is never exposed`);
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it("every 'by (label)' of a tetrizz_ aggregation is a label of the metric inside it", () => {
    const problems: string[] = [];
    for (const { where, expr } of promExprs()) {
      for (const agg of expr.matchAll(/by \(([^)]*)\)\s*\((.*?)\)/g)) {
        const metric = /(tetrizz_[a-z0-9_]+)/.exec(agg[2]!)?.[1];
        if (!metric) continue;
        const labels = exposed.get(metric);
        for (const raw of agg[1]!.split(",").map((s) => s.trim())) {
          if (raw === "le") continue;
          const name = raw === "exported_job" ? "job" : raw;
          if (!labels?.has(name)) problems.push(`${where}: ${metric} has no label ${raw}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("dashboard files", () => {
  it("are the three that were promised, with distinct uids", () => {
    expect(dashboards.map((d) => d.uid)).toEqual([
      "tetrizz-health",
      "tetrizz-live",
      "tetrizz-overview",
    ]);
  });

  for (const d of dashboards) {
    describe(d.title, () => {
      it("has unique panel ids and titles that say something", () => {
        const ids = d.panels.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const p of d.panels) expect(p.title.trim().length).toBeGreaterThan(2);
      });

      it("keeps every panel inside the 24-column grid and none on top of another", () => {
        for (const p of d.panels) {
          expect(p.gridPos.x + p.gridPos.w).toBeLessThanOrEqual(24);
          expect(p.gridPos.w).toBeGreaterThan(0);
          expect(p.gridPos.h).toBeGreaterThan(0);
        }
        for (const [i, a] of d.panels.entries()) {
          for (const b of d.panels.slice(i + 1)) {
            const apart =
              a.gridPos.x + a.gridPos.w <= b.gridPos.x ||
              b.gridPos.x + b.gridPos.w <= a.gridPos.x ||
              a.gridPos.y + a.gridPos.h <= b.gridPos.y ||
              b.gridPos.y + b.gridPos.h <= a.gridPos.y;
            expect(apart, `${a.title} overlaps ${b.title}`).toBe(true);
          }
        }
      });

      it("uses only the datasources that provisioning creates", () => {
        for (const p of d.panels) expect(["prometheus", "loki"]).toContain(p.datasource.uid);
      });
    });
  }
});
