# Running TetriZZ on a VPS with Docker

The files are at the top of the repository: `Dockerfile`, `compose.yaml` (page, TLS and the room server with
SQLite), `compose.postgres.yaml` (adds PostgreSQL), `compose.monitoring.yaml` (adds Prometheus, Alertmanager, Grafana, Loki and
friends) and the `deploy/` folder with their configuration. The step-by-step guides per host (GitHub Pages, Vercel,
Cloudflare, VPS) come with the deployment guides; this file explains the stack itself.

## What runs

| Service         | File       | What it does                                                                                        | Memory ceiling |
| --------------- | ---------- | --------------------------------------------------------------------------------------------------- | -------------- |
| `caddy`         | base       | The only service reachable from outside (80, 443): TLS, the page, `/ws`, `/api/v1`, `/healthz`.     | 96 MB          |
| `server`        | base       | The room server. Reached only through Caddy. SQLite file in `./data/sqlite`.                        | 256 MB         |
| `postgres`      | postgres   | PostgreSQL 18 instead of the SQLite file. Reached only by the server.                               | 384 MB         |
| `prometheus`    | monitoring | Scrapes `server:8787/metrics`, the machine, itself. 30 days or 1 GB of history.                     | 384 MB         |
| `alertmanager`  | monitoring | Delivers the alerts to Telegram and Discord and pings the outside heartbeat. `127.0.0.1:9093` only. | 64 MB          |
| `grafana`       | monitoring | Three dashboards (Overview, Live, Health). Published on `127.0.0.1:3000` only.                      | 384 MB         |
| `loki`, `alloy` | monitoring | Logs of the stack's containers, kept 7 days; IPv4 addresses are replaced with `<ip>` before store.  | 256 + 192 MB   |
| `node-exporter` | monitoring | CPU, memory, disk and network of the machine.                                                       | 64 MB          |

The ceilings add up to about 350 MB for the base stack, 740 MB with PostgreSQL and 2 GB with monitoring too (sums of the limits, not measured use); plan the VPS accordingly. `init` and
`init-monitoring` are one-shot jobs that create the data folders and give each one to the user its service runs as.

## First start

```sh
git clone <your fork> tetrizz && cd tetrizz
cp deploy/env.example .env        # edit: SITE_ADDRESS, and the passwords for the files you use
docker compose up -d --build
```

With `SITE_ADDRESS=:80` the site answers on plain HTTP on any name (a first test). With a host name
(`SITE_ADDRESS=play.example.org`) Caddy gets and renews the certificate itself; ports 80 and 443 must reach the
machine and the name must point at it. Open the address: the page finds its server by itself, because Caddy hands it
`/config.json` that points it at its own address (the page adds `/ws`). Nothing is built into the page.

Choose the parts in `.env`, once, and plain `docker compose ...` and the scripts use them:

```sh
COMPOSE_FILE=compose.yaml                                               # SQLite
COMPOSE_FILE=compose.yaml:compose.postgres.yaml                         # PostgreSQL
COMPOSE_FILE=compose.yaml:compose.postgres.yaml:compose.monitoring.yaml # and monitoring
```

## Two places for settings

- `.env` holds the stack's own settings: address, ports, memory ceilings, passwords, backup rotation.
  `deploy/env.example` lists them all with comments.
- `server.env` (optional) holds any setting of the room server itself: `cp apps/server/.env.example server.env` and
  keep the lines you change (retention, limits, Telegram, Discord, `ALLOWED_ORIGINS`...). `docs/SERVER.md` explains
  each. The stack sets `HOST`, `PORT`, `TRUST_PROXY`, `DB_DRIVER`, `SQLITE_PATH`, `DATABASE_URL` and (with monitoring)
  `METRICS` itself and those win over `server.env`.

Both files are in `.gitignore`. After changing either: `docker compose up -d`.

## Where things are

Everything that must survive is under `./data` and nothing is kept only inside a container: `data/sqlite`,
`data/postgres`, `data/caddy` (certificates), `data/prometheus`, `data/grafana`, `data/loki`, `data/alloy`. Those
folders belong to the users the containers run as, so use `sudo` to look into them. Only Caddy publishes ports to
the world; Grafana publishes `127.0.0.1:3000`: reach it from your computer with
`ssh -L 3000:127.0.0.1:3000 you@server` and open `http://localhost:3000` (user `admin`, `GRAFANA_ADMIN_PASSWORD`).
The server and Caddy run with every Linux capability dropped except the one Caddy needs for ports 80 and 443, with
`no-new-privileges`, and the server has a read-only root file system.

## Updating

```sh
git pull
docker compose up -d --build        # rebuilds what changed, restarts what changed
docker compose pull                 # also fetches newer images for PostgreSQL and the monitoring tools
```

The versions are pinned in `Dockerfile` (`NODE_VERSION`, `CADDY_VERSION`) and in the compose files (PostgreSQL,
Prometheus, Grafana, Loki, Alloy, node exporter). Look the current stable ones up before changing them, take the
latest Node **LTS** rather than the newest release, and let the `deploy-stack` CI job confirm that the tags exist
and that the stack comes up. PostgreSQL major versions (18 to 19) need a dump and restore or `pg_upgrade`; the
data folder is `data/postgres/<major>/docker`, so the old one stays beside the new.

## Backups

```sh
bash scripts/backup.sh                  # one copy now
bash scripts/restore.sh backups/daily/tetrizz-sqlite-20261117-031700.db.gz
bash scripts/healthcheck.sh             # one line per check, exit code 0 when all is well
```

Nightly, from cron (`crontab -e`):

```cron
17 3 * * * cd /opt/tetrizz && bash scripts/backup.sh >> backups/backup.log 2>&1
*/5 * * * * cd /opt/tetrizz && bash scripts/healthcheck.sh >/dev/null && curl -fsS -m 10 https://hc-ping.com/<your-uuid>
```

- SQLite: a snapshot taken while the server runs, checked (integrity, tables) and compressed. PostgreSQL: `pg_dump` in
  the custom format, checked with `pg_restore --list`. A copy that fails its check is never kept, and nothing is
  rotated away before a new one succeeded.
- `backups/daily` keeps the newest 7, `backups/weekly` the newest 4 (one new copy a week). Change them with
  `BACKUP_KEEP_DAILY` and `BACKUP_KEEP_WEEKLY` in `.env`.
- Off-site: install `rclone`, configure a remote and set `BACKUP_RCLONE_REMOTE=remote:folder` in `.env`. Each new
  daily copy is uploaded (copy only, nothing on the remote is ever deleted: prune it with the provider's lifecycle
  rules). A failed upload makes the script exit with code 2 while the local copy stays.
- Restore stops the server, checks the file before it touches anything, keeps the old SQLite file as
  `tetrizz.db.before-restore-<time>` (or dumps the current PostgreSQL database first) and starts the server again.
  Try a restore once on a copy of your setup before you need it.

## Health checks

The server image checks `/healthz` itself and Caddy checks its admin endpoint; the compose files add checks for
PostgreSQL, Prometheus, Alertmanager and Grafana, and start things in order (init, then database, then server, then Caddy).
Loki has no check of its own (its image has no shell, wget or curl to ask with); Prometheus scrapes it instead, and
`MonitoringComponentDown` fires when it stops answering. `docker compose ps` shows the result. `GET /healthz` says the process runs; `GET /readyz` also checks the database.
Both are public (through Caddy) and reveal nothing else. `/metrics` is never routed by Caddy.

## Monitoring

The Overview dashboard shows today's players, sessions, play time, games by mode and errors, and the database
against its budget; Live shows connections, rooms, refusals, message rates, heartbeat round trip, event loop and
the server's log; Health shows the machine, the maintenance job, notifications, firing alerts and warnings in the
logs. They are files in `deploy/grafana/dashboards` and are read-only in Grafana: change one in the editor, use
Export, and put the JSON back in the file.

The alert rules are in `deploy/prometheus/rules/tetrizz.yml` with unit tests next to them. Prometheus evaluates
them, shows them (Alerts page, and the "Alerts firing" tile and table on the Health dashboard) and sends the firing
ones to Alertmanager, which delivers them (next section).

## Alerts

Alertmanager is part of the monitoring stack. Its routing is `deploy/alertmanager/routes.yml`; where messages go comes
from four settings in `.env`, which `deploy/alertmanager/entrypoint.sh` turns into its configuration each time the
container starts (the secrets are written to a memory-only folder inside the container, never to disk):

| Setting                                              | What it does                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` | Telegram. Both or neither. A group's chat id starts with a minus sign.              |
| `ALERT_DISCORD_WEBHOOK_URL`                          | A Discord channel's webhook address (`https://...`).                                |
| `ALERT_HEARTBEAT_URL`                                | The outside heartbeat (below). `https://` or `http://`.                             |
| `ALERTMANAGER_PORT`                                  | Where Alertmanager's page listens on `127.0.0.1` (default 9093; use an SSH tunnel). |

A wrong value (a token without a chat id, a chat id that is not a number, an address without `https://`) stops the
container with a message that names the setting. With none of them set the alerts are still evaluated and visible in
Prometheus and Alertmanager, and delivered nowhere. These are separate from the room server's own `TELEGRAM_*` and
`DISCORD_WEBHOOK_URL` in `server.env` (what the server sees from inside), so you may use another bot or channel.
After changing `.env`: `docker compose up -d alertmanager`.

How alerts are sent: one message per problem, grouped by alert name (the first one after 30 seconds, then at most
every 5 minutes while it changes, and again every 4 hours while it lasts, every hour for critical ones); a cause
silences what follows from it (`HostDiskCritical` over `HostDiskLow`, `TetrizzDatabaseOverBudget` over
`TetrizzDatabaseNearBudget`, `TetrizzServerDown` over the server's other alerts); resolved alerts send a message too.
To mute something for a while: `docker compose exec alertmanager amtool silence add alertname=HostDiskLow --duration=2h
--comment="moving data" --alertmanager.url=http://127.0.0.1:9093`.

**The heartbeat.** If the whole VPS is down, Prometheus and Alertmanager are down with it, and nothing on the machine
can say so. So one alert, `Watchdog`, always fires, and Alertmanager sends it (and only it) to `ALERT_HEARTBEAT_URL`
once a minute. Create a check at an outside service that alerts you when the pings stop, and put its ping address
there: for example healthchecks.io (a check with a period of 5 minutes and a grace time of 5 minutes, and Telegram,
Discord or email as the way it tells you), Better Stack or Uptime Kuma's push monitor. The ping is a POST with the
alert's JSON in the body; the services above accept that. It silently stops if the machine, Prometheus or Alertmanager
dies, which is the point.

Two alerts watch the alerting itself: `MonitoringComponentDown` (Loki, Alloy or Alertmanager stopped answering
Prometheus for 5 minutes) and `AlertDeliveryFailing` (more than 2 failed deliveries in 30 minutes: look at
`docker compose logs alertmanager` for the reason, usually a wrong token, chat id or webhook address).

Things to know:

- Alloy reads the other containers' logs through the Docker socket (mounted read-only, but the Docker API behind it is
  not). That makes the `alloy` container trusted with the machine. To leave logs out, delete the `alloy` and `loki`
  services from `compose.monitoring.yaml` and the Loki datasource and the two log panels (or accept the empty panels).
- The server labels its maintenance series `job` (`live`, `settle`); Prometheus keeps its own `job` label and renames
  the server's to `exported_job`. The rules and dashboards use that name.
- Prometheus history is capped by time and size (`PROMETHEUS_RETENTION_TIME`, `PROMETHEUS_RETENTION_SIZE`), Loki by
  `LOKI_RETENTION`; both are in `.env`.

## What has and has not been run

Run, with the real tools (Docker was not available to the author's sandbox): Docker Compose 5.7.1 renders all four
combinations and refuses to start without the passwords; Caddy 2.11.7 validates the Caddyfile and ran in front of the
built server and page (headers, caching, `/metrics` blocked, WebSocket upgrade accepted from the site's own origin and
refused with 403 from another); promtool 3.13.5 checks the Prometheus configuration and the rules and ran their unit
tests; Loki 3.7.9 and Alloy 1.21.2 validate their files; Alertmanager 0.35.0 and amtool check the rendered configuration for
three settings and the routes, and a real Alertmanager sent the Watchdog alert to a local webhook and suppressed an alert
that a cause inhibits; the Dockerfile's steps were replayed without Docker in a clean
copy that holds only the files it copies (production install, both builds, the runtime layout started, its health check
command passes); the scripts pass shellcheck and nine tests against a real SQLite database with a stand-in for
`docker compose`; the dashboards and rules are checked against the server's real `/metrics`.

CI has run the stack: the first run (19 Nov 2026, the Phase 8c-4b zip in a test repository) built and started the
base and PostgreSQL variants and the whole monitoring variant up to Loki, and showed two faults that are fixed since: a
check that piped `curl` into `grep -q` failed on the page (curl exit 23 under `pipefail`), and the Loki image, which has
no shell or wget, can never pass a health check, so Grafana and Alloy waited for it for ever. Everything after those
points has not run yet in CI: the targets, Loki's readiness, the datasources, the dashboards, Alloy shipping logs,
the Watchdog reaching a heartbeat address, backup and restore (the second part of each variant). Treat these as
untested until `deploy-stack` has gone green once: the health check commands inside the Grafana and Alertmanager
images, Alloy's use of the Docker socket, the node exporter mounts, Alertmanager's memory-only folder (`tmpfs` with
the `nobody` user), and Grafana 13 loading the dashboards.
