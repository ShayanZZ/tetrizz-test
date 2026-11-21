# The own server (`apps/server`)

A small Node server that lets pages share rooms without Supabase or the public relay. It speaks
the protocol in `packages/protocol/src/server.ts` over one WebSocket at `/ws`.

**It stays a relay.** The room rules (who may enter, who is host, which events reach whom, how long a
dropped seat is held) are not written in the server: it runs `createReferenceServer` from
`packages/protocol/src/server-room.ts`, the same code the unit tests and the page's checks use, so the
model and the server cannot drift. The server adds sockets, real timers, scrypt passwords and the
protections below. Game logic stays in the pages.

## Run it

```
npm install
npm run build -w @tetrizz/server      # apps/server/dist/index.js (one file; fastify and @fastify/websocket stay in node_modules)
PORT=8787 ALLOWED_ORIGINS=https://play.example.org npm start -w @tetrizz/server
```

Needs Node 22.13 or newer (the repository pins the Node 26 LTS in `.nvmrc`). Stop it with SIGTERM or
Ctrl-C: it tells every page it is going away (close code 1001), stops listening and exits 0. Rooms live
in memory, so a restart ends every room; pages that reconnect find theirs gone and say so.

Point a page at it with `TETRIZZ_SERVER_URL` at build time or `config.json` beside the page
(`docs/DEPLOYMENT.md`).

Endpoints: `GET /healthz` (always `{"status":"ok"}`), `GET /readyz` (`ready`, or 503 while stopping),
`/ws` (the socket). Everything else is 404. There is no `/metrics` yet.

## Settings (environment variables)

`apps/server/.env.example` lists them with their defaults. A value that is set but wrong stops the start
and the message names every one; nothing falls back silently.

| Variable                                            | Default                    | Meaning                                                                                        |
| --------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| `HOST`, `PORT`                                      | `127.0.0.1`, `8787`        | Where to listen. Use `0.0.0.0` in a container.                                                 |
| `ALLOWED_ORIGINS`                                   | none                       | Comma-separated origins (`https://play.example.org`, no path) that may connect.                |
| `ALLOW_SAME_ORIGIN`                                 | `true`                     | A page served from the host the socket is opened on may connect (Origin host = Host header).   |
| `ALLOW_FILE_ORIGIN`                                 | `false`                    | The `null` origin of the single-file build opened from disk. Sandboxed frames send it too.     |
| `ALLOW_MISSING_ORIGIN`                              | `false`                    | A handshake without an Origin header (a script). Browsers always send one.                     |
| `TRUST_PROXY`                                       | `false`                    | `false`, the number of proxies in front (1 for Caddy), or their addresses. Never `true`.       |
| `SEAT_GRACE_SECONDS`                                | `30`                       | How long a dropped player's seat and host role are held. `0` removes the seat at once.         |
| `MAX_ROOMS`                                         | `200`                      | Rooms at once; a further `create` is answered `busy`.                                          |
| `MAX_CONNECTIONS`                                   | `500`                      | Sockets at once.                                                                               |
| `MAX_CONNECTIONS_PER_IP`                            | `8`                        | Sockets from one address (an IPv6 address counts by its /64).                                  |
| `CONNECTS_PER_MINUTE_PER_IP`                        | `30`                       | New sockets per minute from one address.                                                       |
| `MESSAGES_PER_SECOND`, `MESSAGE_BURST`              | `30`, `100`                | One connection's message budget (match play sends about 10 a second).                          |
| `PASSWORD_CHECKS_PER_MINUTE`                        | `60`                       | Room creates, joins and password changes that carry a password, per address (burst 20).        |
| `HEARTBEAT_SECONDS`                                 | `20`                       | Ping interval; a socket silent for one more round is cut.                                      |
| `LOG_LEVEL`                                         | `info`                     | `fatal` to `trace`, or `silent`.                                                               |
| `STATS_LOG_SECONDS`                                 | `300`                      | A summary line of counters; `0` turns it off.                                                  |
| `SHUTDOWN_GRACE_SECONDS`                            | `5`                        | How long a stop waits for pages to close before cutting them.                                  |
| `DB_DRIVER`                                         | `off`                      | `off` (rooms only, nothing stored, no `/api/v1`), `sqlite` or `postgres`.                      |
| `SQLITE_PATH`                                       | `./data/sqlite/tetrizz.db` | The SQLite file (its folder is created). `:memory:` keeps nothing across restarts.             |
| `DATABASE_URL`                                      | none                       | `postgres://user:pass@host:5432/db`; required for `postgres`. Never written to the log.        |
| `DB_SCHEMA`, `DB_POOL_MAX`                          | none, `5`                  | PostgreSQL schema (a plain name) and connections in the pool.                                  |
| `RETENTION_EVENTS_DAYS`                             | `30`                       | Raw events older than this are dropped (after their day was rolled up).                        |
| `RETENTION_GAMES_DAYS`                              | `180`                      | Finished games, same rule. Daily rollups are kept for ever.                                    |
| `RETENTION_SESSIONS_DAYS`                           | `180`                      | Sessions, same rule.                                                                           |
| `DB_MAX_MB`                                         | `0`                        | Soft ceiling for the database in MB; `0` is none. See [The janitor](#the-janitor).             |
| `JANITOR`                                           | `on`                       | The maintenance job (rollups, purge, size budget). Needs a database.                           |
| `JANITOR_LIVE_SECONDS`                              | `300`                      | How often today is rolled up.                                                                  |
| `JANITOR_SETTLE_MINUTES`                            | `60`                       | How often the last days are rolled up again, old rows purged and the size checked.             |
| `JANITOR_LOOKBACK_DAYS`                             | `3`                        | Days before today rolled up again each time, for offline pages that upload late.               |
| `JANITOR_PURGE_BATCH`                               | `5000`                     | Rows deleted per statement while purging.                                                      |
| `METRICS`, `METRICS_TOKEN`                          | `off`, none                | `/metrics` for Prometheus; see [Metrics](#metrics). A token is 16 to 200 printable characters. |
| `SERVER_NAME`                                       | `TetriZZ server`           | Starts every message to the owner, so several servers can share one chat.                      |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`            | none                       | Both or neither. The chat is a number (a group's is negative) or `@channelname`.               |
| `DISCORD_WEBHOOK_URL`                               | none                       | An `https://` webhook address.                                                                 |
| `NOTIFY_DIGEST_HOUR_UTC`                            | `7`                        | UTC hour (0 to 23) of the daily digest, or `off`.                                              |
| `NOTIFY_LAG_MS`                                     | `500`                      | Event-loop delay that raises an alert; `0` is off.                                             |
| `NOTIFY_ERROR_SPIKE`, `NOTIFY_ERROR_WINDOW_SECONDS` | `20`, `300`                | Unexpected errors within the window that raise an alert; `0` is off.                           |
| `NOTIFY_COOLDOWN_MINUTES`                           | `30`                       | The least time between two messages of the same kind.                                          |
| `TELEMETRY_REQUESTS_PER_MINUTE`                     | `30`                       | Changing requests to `/api/v1` per address (burst 10).                                         |
| `NEW_PLAYERS_PER_HOUR_PER_IP`                       | `60`                       | Player ids an address may bring in per hour that the server has not seen (burst 20).           |

## What it does around the room model

- **Origin.** Checked before the upgrade; a page that is not allowed gets a plain HTTP 403. This keeps
  other people's sites from using the server. It is not a login: a program that is not a browser can send
  any Origin it likes.
- **Limits per address.** Sockets open, sockets per minute, and password checks. Addresses are used only as
  keys in memory while they matter; they are never written to the log, and request lines are not logged.
- **Limits per connection.** A frame over 64 KB closes with 1009. A binary frame closes with 1003. Messages
  over the budget are dropped; a connection that keeps flooding (over 200 drops in five seconds) closes with 1008. A page that stops reading, with more than 1 MB waiting to be sent to it, is cut. A socket that sends
  nothing at all for 10 s after connecting is cut.
- **Heartbeats.** A ping every `HEARTBEAT_SECONDS`; a socket that has not answered by the next round is
  cut, which starts its seat hold.
- **Passwords.** Stored as `scrypt$N$r$p$salt$hash` (N 16384, r 8, p 1, about 27 ms a check) and compared
  in constant time; the text a player typed is not kept and is never sent to another page. The cost is in
  the stored value, so it can be raised later and old hashes still check. When an address has used up its
  password checks, a create or join with a password is answered `busy` (a password change is dropped).
- **Seat hold.** The model holds a dropped player's seat for `SEAT_GRACE_SECONDS` with real timers (unref'd,
  so a pending hold never keeps a stopping process alive).

Close codes: 1000 normal (a bad message, a refused version, a replaced connection), 1001 the server is
stopping, 1003 binary frame, 1008 flooding, 1009 frame too big, 1013 try later (too many sockets, in total
or from one address, or too many connects a minute).

## Who a player is

A page makes one random secret, the _player key_ (32 bytes as 64 lowercase hex characters), and keeps it in the browser (`tetris_pkey`, in the tab's storage and the browser's). Its _player id_ is derived from the key with a one-way hash: the first 32 hex characters of the SHA-256 of `tetrizz-player-id-v1:` followed by the key (`packages/protocol/src/identity.ts`, the same code on the page and the server). Ids are public: every roster lists them, `kick` and `host` use them. The key is what proves an id is yours.

- **Rooms.** `hello` carries `id` and `key`. The server recomputes the id from the key and answers `refused` with reason `identity` (and closes) when they differ or the key is missing, before anything else is allowed. So nobody can replace another player's connection, take a held seat back, or be host in their place. The server stores nothing for this, so it holds across restarts, and a player cannot be locked out of an id by someone who learned it first.
- **`/api/v1`.** The same rule for batches, opt-out and erasure (above).
- **Where the key goes.** To this server only, inside the connection to it. Never through a room, a relay, Supabase or the LAN hub, and never into an export. On plain `ws://` and `http://` it is readable on the wire like everything else, so run the server behind HTTPS (the VPS stack's Caddy does).
- **Losing it.** Clearing the browser's data makes a new player. The old id's rows stay until the retention removes them, and nobody can erase them early.
- **Not covered.** Someone who takes the key out of the browser itself; and rooms on the relay, Supabase and the LAN, where no server checks ids.
- **Old pages.** A page from before this change sends no key; its `hello` is refused with `identity` and it plays on the other backends.

## Behind a reverse proxy

Proxy `/ws` to the server and keep the `Host` header. With Caddy that is a `reverse_proxy` line, which
forwards WebSocket upgrades by itself; set `TRUST_PROXY=1` so limits count visitors and not the proxy. A
page on the same host as `/ws` needs no `ALLOWED_ORIGINS`. `docs/DEPLOYMENT.md` has the page side.
`deploy/Caddyfile` does exactly this (tried: a socket from the site's own origin is accepted, one from another
origin gets 403, and `/metrics` is not routed), and `docs/DOCKER.md` runs it all in containers.

## `/api/v1` (only with a database)

With `DB_DRIVER=sqlite` or `postgres` the server also answers these; without a database they are 404.
The wire format is in `packages/protocol/src/telemetry.ts` (the page uses the same parser). What the page sends, and what it never sends, is written for operators in `PRIVACY.md`; keep that file and any privacy statement you publish in step with the server you run.

| Request                                                 | What it does                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/telemetry`                                | One batch of events, finished games and history lines, an optional session and device. Answers what was stored, what the server already had, what was rejected and what was too old. JSON or `text/plain` (what `sendBeacon` sends without a preflight), up to 256 KB. |
| `PUT /api/v1/players/<id>/telemetry` `{"optOut": true}` | Switches telemetry off or on for a player. An opted-out player's batches are answered `optedOut` and nothing is stored or updated.                                                                                                                                     |
| `DELETE /api/v1/players/<id>`                           | Erases everything stored about the player (anonymous rollups stay). The answer is the same whether or not anything existed.                                                                                                                                            |

How a batch is treated:

- Every item has an id the page made up; a second copy changes nothing, so a page may retry freely.
- Times are moved by the difference between the server's clock on arrival and the page's `sentAt`, never into the future. An event older than its retention is dropped (`stale`); one that arrives more than five minutes after it happened, or that the page marked, is stored as recorded offline.
- Only the sender's own row of a game is stored; rows for other players are rejected, so nobody can write results under another id.
- One match is one game. Every human player's page reports the match under the same game id with only its own row. The first report creates the game; a later report for the same id adds its own row (the answer says `joined`) and leaves the game's other fields (duration, bots, device, app version) as the first report had them. A repeat of a row already stored is a duplicate. A report is refused (counted in `rejected`, nothing written) when its mode differs from the game's, its start time is more than two minutes from the game's, or the game already has 16 rows.
- A single item that does not fit the format is left out and counted in `rejected`; a request that is not shaped right is a 400.
- The device is what the `User-Agent` header says (parsed with `bowser`: class, OS and version, browser and major version, engine), overridden by whatever the page sends (Chromium's client hints give the real Android and Windows versions).
- No address is stored. Addresses key the limiters in memory only: `TELEMETRY_REQUESTS_PER_MINUTE` per address and `NEW_PLAYERS_PER_HOUR_PER_IP` for ids the server has not seen (429 with `Retry-After`).
- The page may be served from another host: answers carry CORS headers for the origins `ALLOWED_ORIGINS` lists (and the page's own host); any other origin, and a request with no `Origin` header, is a 403 unless the operator allows it (`ALLOW_MISSING_ORIGIN`, `ALLOW_FILE_ORIGIN`).
- A database failure is a 503 with no detail; the server keeps running, `/readyz` says `"database": "down"` and still answers 200 (rooms do not need the database).
- **Every request proves the player id is the sender's own** (see "Who a player is"): a batch carries the player key in its `key` field, `PUT` and `DELETE` send `Authorization: Bearer <key>`. A key that does not belong to the id is a 403 `{"ok":false,"error":"identity"}`, counted in `tetrizz_api_refused_total{reason="identity"}`; a batch with no key at all is a 400. The key is never stored or logged.

## The janitor

`apps/server/src/janitor.ts`, started when the server listens (after ten seconds) and only with a database.
One job runs at a time; a failing job is logged, counted, reported to the owner and tried again on its
next turn, and never stops the server.

- **Live pass** (every `JANITOR_LIVE_SECONDS`): rolls up today so today's numbers are current, and
  refreshes the "today" figures of `/metrics`. The first live pass after midnight UTC also closes the day
  that just ended.
- **Settle pass** (every `JANITOR_SETTLE_MINUTES`): rolls up the last `JANITOR_LOOKBACK_DAYS` days again
  (an offline page can upload events long after they happened), purges rows older than the retention,
  gives the space back (once a day, or whenever rows were deleted), counts the rows and checks the size.
  The first settle after every start rolls up the last 14 days, so a server that was down leaves no gaps.
- Raw rows are deleted only from days that were rolled up. A day older than that window that was never
  rolled up keeps its raw rows (disk is spent, no data is lost).
- **Size budget** (`DB_MAX_MB`): at 80 % one warning a day goes to the owner. Over 100 % every retention
  is halved (events 30 to 15 to 7 days, never below one day, at most six times) with a purge and a compaction
  after each step, until the database fits. The cut is lifted one step at a time when the size is below 70 %.
  PostgreSQL gives space back to the system only after a `VACUUM FULL`, so on PostgreSQL the budget acts on
  what the database reports and a cut can stay in force; watch `tetrizz_retention_cut_level`.

## Metrics

Off by default. With `METRICS=on`, `GET /metrics` answers in the Prometheus text format. It is meant for
the monitoring stack on the same private network and is not given to the internet:

- With `METRICS_TOKEN` set, a request must carry `Authorization: Bearer <token>`.
- Without a token, only a request that did not come through a proxy is answered (one with `X-Forwarded-For`
  or `Forwarded` gets a plain 404, like every refused request).
- Keep it out of the reverse proxy's routes as well; the Caddy file of the deployment guide does not
  forward it.

Counters the server already keeps are read at scrape time. Names start with `tetrizz_`: `connections`,
`rooms`, `connections_accepted_total`, `connections_refused_total{reason}`, `connections_closed_total{reason}`,
`messages_received_total`, `messages_dropped_total`, `password_limited_total`, `ping_seconds` (histogram of the
heartbeat round trip), `api_requests_total`, `api_refused_total{reason}`, `telemetry_batches_total`,
`telemetry_items_total{kind,outcome}` (games also have `joined`), `db_errors_total`, `db_up`, `janitor_runs_total{job,result}`,
`janitor_job_seconds`, `janitor_last_ok_timestamp_seconds{job}`, `purged_rows_total{table}`,
`retention_cut_level`, `db_size_bytes`, `db_budget_bytes`, `db_rows{table}`, today's `games_today{mode}`
(the twelve most played modes, the rest as `other`), `players_active_today`, `players_new_today`,
`sessions_today`, `play_seconds_today`, `js_errors_today`, and `notifications_total{result}`. The process
and Node metrics (CPU, memory, event loop, garbage collection) use their standard names. The row counts and
the today figures come from the janitor, not from a query per scrape, so a scrape never touches the large
tables. A figure that does not exist (no database, no budget, no run yet) is absent, not 0.

## Messages to the owner

`notifier.ts` delivers, `alerts.ts` decides. Telegram (`sendMessage`) and a Discord webhook are independent;
with neither set nothing is sent. A message that cannot be delivered is retried once (network error, 429
or 5xx), then counted and logged by channel and status only; the bot token and webhook address are never
written to the log. Discord messages cannot ping anyone.

| Message                       | When                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| started                       | every time the server starts listening (version, Node, database)                                         |
| daily digest                  | once a day at `NOTIFY_DIGEST_HOUR_UTC`: yesterday's games by mode, players, play time, errors, now, size |
| database failing              | any database error (pool, API, janitor)                                                                  |
| maintenance job failed        | the live or settle pass threw (one cooldown per job)                                                     |
| database near/over its budget | 80 % (once a day) and 100 % (with the retention cut)                                                     |
| server running slowly         | event-loop delay above `NOTIFY_LAG_MS` on two checks in a row                                            |
| many errors                   | `NOTIFY_ERROR_SPIKE` unexpected errors within the window                                                 |

Every kind has a cooldown (`NOTIFY_COOLDOWN_MINUTES`, a minute for start and digest); messages held back are
counted in the next one. A start after the digest hour does not repeat that day's digest, so a server that was
down at the digest hour skips that day. Text is plain, with the `SERVER_NAME` first.

## Tests

- `tests/unit/server-*.test.ts`: settings, origin policy, scrypt, limiters, the telemetry format, clock correction and device parsing (pure code).
- `tests/server/api.test.ts`: `/api/v1` on a real port with an in-memory SQLite database: storing, duplicates, one match reported by several players (rows joined, refused, limited, opted out, two real page clients), clock skew, offline and stale events, opt-out, deletion, origin and CORS, both limiters, database failure, no database.
- `tests/server/notifier.test.ts`, `janitor.test.ts`, `alerts.test.ts`, `metrics.test.ts`: delivery, cooldowns and retries with a recording `fetch`; rollups, purge, size budget and failures against an in-memory SQLite database and a moving clock; the alert rules; `/metrics` access, content and scrape behaviour, and the start and failure messages through the real server.
- `tests/server/server-app.test.ts`: the server on a real port with real `ws` clients: rooms and relay,
  passwords, seat hold with real timers, origin, limits, heartbeats, slow reader, shutdown. The room rules
  themselves are tested against the model in `tests/unit/server-protocol.test.ts`.
- `tests/harness/check_server_real.py`: the built page and the built server process in Chromium, with a TCP
  proxy between them that can cut one player's connection (the usage is in the file's header).
  `check_server_room.py` runs the same page against a fake server.

## The database layer

`apps/server/src/db/` is the storage code for what comes next: players, devices, sessions, finished
games, raw events, daily rollups and per-player history. One `Repository` interface, two databases
behind it: SQLite (Node's built-in `node:sqlite`, no native add-on) and PostgreSQL (`pg`). Both run the
same SQL, and `tests/server/db-contract.test.ts` runs the same tests against both.

- Migrations are numbered `.sql` files in `db/migrations/sqlite` and `db/migrations/postgres`, bundled
  into the server and recorded with a checksum. The server refuses to start on a database made by a
  newer version, or when an applied migration was edited. Never edit one that has shipped; add the next.
- Writes that a page may repeat (a game, an event, a session) are idempotent by an id the page makes up.
- `rollupDay` turns one UTC day of raw rows into the numbers that are kept forever; `purge` deletes old
  raw rows but only from days that were rolled up; `deletePlayer` removes everything about one player.
- To run the PostgreSQL tests locally:
  `TEST_POSTGRES_URL=postgres://user:pass@127.0.0.1:5432/dbname npx vitest run tests/server/db-contract`
  (each test works in its own schema and drops it). Without the variable they run on SQLite only.

The server opens it at start from the settings above and closes it on a stop. A wrong address stops
the start with the driver's message (the address itself is never printed). `node:sqlite` is loaded only
when SQLite is chosen, so a server with `DB_DRIVER=off` prints no experimental-feature warning.

## Not here yet

The room list endpoint (waiting for an owner decision, see `docs/PROGRESS.md`; the Docker files, backup scripts, monitoring stack and the business dashboards are in `docs/DOCKER.md`). Reconnects (seats resumed)
are not counted in `/metrics` yet. Rooms and players are in memory only.
