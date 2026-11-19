# Running TetriZZ on a VPS with Docker

The files are at the top of the repository: `Dockerfile`, `compose.yaml` (page, TLS and the room server with
SQLite), `compose.postgres.yaml` (adds PostgreSQL), `compose.monitoring.yaml` (adds Prometheus, Grafana, Loki and
friends) and the `deploy/` folder with their configuration. The step-by-step guides per host (GitHub Pages, Vercel,
Cloudflare, VPS) come with the deployment guides; this file explains the stack itself.

## What runs

| Service         | File       | What it does                                                                                       | Memory ceiling |
| --------------- | ---------- | -------------------------------------------------------------------------------------------------- | -------------- |
| `caddy`         | base       | The only service reachable from outside (80, 443): TLS, the page, `/ws`, `/api/v1`, `/healthz`.    | 96 MB          |
| `server`        | base       | The room server. Reached only through Caddy. SQLite file in `./data/sqlite`.                       | 256 MB         |
| `postgres`      | postgres   | PostgreSQL 18 instead of the SQLite file. Reached only by the server.                              | 384 MB         |
| `prometheus`    | monitoring | Scrapes `server:8787/metrics`, the machine, itself. 30 days or 1 GB of history.                    | 384 MB         |
| `grafana`       | monitoring | Three dashboards (Overview, Live, Health). Published on `127.0.0.1:3000` only.                     | 384 MB         |
| `loki`, `alloy` | monitoring | Logs of the stack's containers, kept 7 days; IPv4 addresses are replaced with `<ip>` before store. | 256 + 192 MB   |
| `node-exporter` | monitoring | CPU, memory, disk and network of the machine.                                                      | 64 MB          |

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
PostgreSQL, Prometheus, Loki and Grafana, and start things in order (init, then database, then server, then Caddy).
`docker compose ps` shows the result. `GET /healthz` says the process runs; `GET /readyz` also checks the database.
Both are public (through Caddy) and reveal nothing else. `/metrics` is never routed by Caddy.

## Monitoring

The Overview dashboard shows today's players, sessions, play time, games by mode and errors, and the database
against its budget; Live shows connections, rooms, refusals, message rates, heartbeat round trip, event loop and
the server's log; Health shows the machine, the maintenance job, notifications, firing alerts and warnings in the
logs. They are files in `deploy/grafana/dashboards` and are read-only in Grafana: change one in the editor, use
Export, and put the JSON back in the file.

The alert rules are in `deploy/prometheus/rules/tetrizz.yml` with unit tests next to them. Prometheus evaluates
them and shows them (Alerts page, and the "Alerts firing" tile and table on the Health dashboard). **Nothing sends
them anywhere yet**: the server's own Telegram and Discord messages cover what the server sees from inside, but
"the server is down" and "the disk is full" need a sender (Alertmanager or Grafana contact points), which is an open
decision (see `docs/PROGRESS.md`). Until then, `scripts/healthcheck.sh` with an uptime service (see Backups) covers
"is it up".

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
tests; Loki 3.7.9 and Alloy 1.21.2 validate their files; the Dockerfile's steps were replayed without Docker in a clean
copy that holds only the files it copies (production install, both builds, the runtime layout started, its health check
command passes); the scripts pass shellcheck and nine tests against a real SQLite database with a stand-in for
`docker compose`; the dashboards and rules are checked against the server's real `/metrics`.

Not run: `docker build` and `docker compose up` themselves. The `deploy-stack` job in CI does that for the three
variants (it builds, starts, checks the front door, backs up, restores, and for monitoring also checks the targets,
the three provisioned dashboards, both datasources and that logs reach Loki). Until it has gone green once, treat
these as untested: the health check commands inside the Grafana, Loki and Prometheus images, Alloy's use of the Docker
socket, the node exporter mounts, PostgreSQL with all capabilities dropped but five, and Grafana 13 loading the
dashboards.
