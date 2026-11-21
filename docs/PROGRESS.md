# TetriZZ refactor — progress log

## Status

- **Phase 0 (safety net): done.** v1.2.0 reference build, deterministic harness, goldens, fixtures and a performance baseline exist.
- **Phase 1 (monorepo scaffold, tooling, CI, single-file pipeline): done.** The unchanged v1.2.0 page builds as a multi-file site and as one file, and both pass the full harness. Details below.
- **Phase 2 (format, dead code, comments): done.** The page and `sw.js` are Prettier-formatted, confirmed dead code is deleted, and every comment is stripped with a parser. Both builds pass the full harness. Details below.
- **Phase 3 (CSS split): done.** The stylesheet lives in 25 ordered files under `apps/web/src/styles/`, nine unused classes are removed, and both builds pass the full harness. Details below.
- **Phase 4 (JavaScript into modules): done.** The script is 36 feature modules plus 23 ordered startup files, with state objects, a typed event bus, a storage layer, a logger, a security pass, TypeScript setup and a version label. Both builds pass the harness (screenshot masks added for the label). Details below.
- **Phase 5 (shared rules in `packages/core`, injectable RNG and clock, one bot board helper set): done.** One implementation of collision, kicks, spin, scoring, bag and level tables now serves the solo game, the versus stations and the bots, and it is checked against the v1.2.0 page on 2,749 recorded cases. Details below.
- **Phase 6 (performance): done.** Bot code lives in `packages/bot`, bots plan in a Web Worker pool, planning is 2.6x faster, long frames are simulated in capped steps, the board layer cache works, a hidden overlay shows frame and bot-think times, quality drops automatically when frames stay slow, and Options has a Motion group. The first phone and laptop runs came back good (see Phase 6d), so the two open items are decided: the default pool policy stays automatic and redundant redraws are not skipped. Details below.
- **Phase 6d (bot pace and lobby fixes, from the first phone test): done.** Bots now reach the PPS they are set to (8.8 became 9.94 at 10 PPS on 16 ms frames) because lateness is carried to the next piece; typed bot LEVEL and BOT PPS values are stored; holding + or - on those steppers repeats. Details below.
- **Phase 6e (hidden tab, from the second phone/laptop test): done.** While the tab was hidden bots played about 4 PPS and the game clock ran at 0.82x real time, so the PPS shown (a whole-match average) sank the longer the tab stayed hidden. Both are fixed; details below.
- **Phase 7 (network layer, protocol package, config out of source): done.** 7a (network settings out of the source), 7b (protocol package, version on connect), 7c-1 (the message layer behind a Transport interface), 7c-2a and 7c-2b (leaving, kicking, host change, ready, creating and joining behind a RoomBackend interface), 7c-3 (the Supabase channel module, the lobby trying backends in `backendOrder()` order, a backend pick in Options), 7d-1 (the own server's wire protocol, a reference model of its room rules, and the client socket, Transport and RoomBackend) and 7d-2 (the page uses the own server: server rooms in the lobby, the SERVER pick, reconnect after a dropped socket) are done. The own server itself does not exist yet; the page's side is tested against a fake server hosted by Playwright.
- **Phase 8a (the two open server rules, decided by the owner): done.** The host can change a server room's password after it is made, and a player whose connection drops keeps the seat (and the host role) for a grace period and takes it back by joining again. Both are in the protocol, the reference model and the page; the real server does not exist yet. Details below.
- **Phase 8b (the real own server, `apps/server`): done.** Fastify and `@fastify/websocket` run `createReferenceServer` (one copy of the room rules) on real sockets with scrypt passwords and real timers, plus an origin allowlist, per-address and per-connection limits, heartbeats, slow-reader protection, `/healthz`, `/readyz`, JSON logs without addresses and a clean SIGTERM stop. Settings are environment variables. The built page was played against the built server in Chromium. Details below and in `docs/SERVER.md`.
- **Phase 8c-1 (the database layer, `apps/server/src/db`): done.** One repository interface with SQLite (Node's built-in `node:sqlite`) and PostgreSQL (`pg`) behind it, running the same SQL; numbered `.sql` migrations per dialect with checksums; tables for players, devices, sessions, games, events, player history and daily rollups; idempotent writes, rollups, safe purging, delete-by-player. 75 new tests run against both databases. Nothing in the server uses it yet. Details below.
- **Phase 8c-2a (the database inside the server, `/api/v1`): done.** The server opens the database from settings (`DB_DRIVER` off by default), and `POST /api/v1/telemetry`, `PUT /api/v1/players/:id/telemetry` and `DELETE /api/v1/players/:id` work with CORS, limits, clock correction, dedupe, opt-out and delete. The telemetry wire format is in `packages/protocol/src/telemetry.ts`. 36 new tests. The page sends nothing yet. Details below.
- **Phase 8c-2b (`/metrics`, the janitor, the notifier): done.** `/metrics` (off by default; bearer token, or only requests that did not come through a proxy; everything else a plain 404), a janitor that rolls up, purges, compacts and enforces `DB_MAX_MB`, and a notifier (Telegram, Discord) with alert rules and a daily digest. 39 new tests (469 pass, 2 skipped as before); typecheck, ESLint (0 errors) and Prettier are clean; the server builds to one file. The page is untouched. Details below.
- **Phase 8c-3 (the VPS stack: Dockerfile, compose files, Caddy, monitoring, backups): done, with one open decision and CI still to prove it.** `Dockerfile` (server and web images), `compose.yaml` (Caddy + server + SQLite), `compose.postgres.yaml`, `compose.monitoring.yaml` (Prometheus, Grafana, Loki, Alloy, node exporter, three dashboards, alert rules), `scripts/backup.sh`, `restore.sh`, `healthcheck.sh`, `docs/DOCKER.md`. Validated here with the vendors' own tools and a live Caddy in front of the built server; `docker build` and `docker compose up` could not be run here and are covered by the new `deploy-stack` CI job. Details below.
- **Phase 8c-4a (a bug in the VPS front door, and the static-host guides): done.** Found while writing the guides: Caddy's `/config.json` said `"url":"/ws"`, the page adds `/ws` itself, so on the VPS stack it opened `/ws/ws` (not forwarded) and fell back to the public relay without any sign. Fixed (`"/"`), with a unit test and a real-Caddy browser check. `docs/DEPLOYMENT.md` now covers GitHub Pages, Vercel, Cloudflare Pages, the VPS stack and a static page with a server on a VPS; new `.github/workflows/pages.yml`, `vercel.json`, `deploy/cloudflare/_headers`. Details below.
- **Phase 8c-4b (the player-id fix, the description text): done.** Ids are derived from a secret key that the server checks (rooms and `/api/v1`); see "Player identity". Also the description text replacement.
- **Phase 8c-4c (the first CI run read and fixed, Alertmanager): done, CI still to prove it.** The CI run of the 8c-4b zip (test repo `ShayanZZ/tetrizz-test`, 19 Nov 2026) showed four faults: the harness' solo traces (the old random player id drew one `Math.random` number at start), the stack check's `curl | grep -q` under `pipefail` (lite and postgres), and Loki's image having no shell or wget (monitoring). All fixed and, where possible, reproduced here first. Alertmanager is in the monitoring stack, with Telegram, Discord and an outside heartbeat. See "Phase 8c-4c".
- **Phase 8c-4d (the second CI run of the stack read, one test fault fixed): done, and proved by CI.** The run of the 8c-4d zip (test repo `ShayanZZ/tetrizz-test`, 19 Nov 2026) was green in every job: `check` (545 tests), `deploy-files`, `deploy-stack` lite, postgres and monitoring (now through the Watchdog heartbeat to "all good"), and `regression` (its informational screenshot step still reports the known font gap). `pages.yml` built and deployed. See "Phase 8c-4d" and "Phase 8d-1".
- **Phase 8d-1 (the page's telemetry client, not wired into the page yet): done.** `apps/web/src/telemetry/`: a capped queue (IndexedDB, memory fallback), coarse device facts, and a client that batches, retries with backoff, tells the server the player's choices (off, erase) and keeps them until they arrive. 19 new tests, every deliberate break caught; the page does not import it yet, so nothing the player sees has changed. Also the `?` in the stack check's heartbeat line is fixed. See "Phase 8d-1".
- **Phase 8d-2a (one game per match on the server, the page's real dependencies): done; the page is still not wired.** A match of several humans is one game with one row per player: the server adds a later page's own row to the game that exists (same mode, start within 2 minutes, at most 16 rows), the client takes a shared game id, and `telemetry/address.ts`, `page.ts` and `index.ts` hold the address rules, the match id and the real `fetch`, `sendBeacon`, storage, crypto and listener setup. 607 tests, nine deliberate breaks all caught. Nothing the player sees has changed. See "Phase 8d-2a".
- **Phase 8d-2b (the page's hooks, the client still not started): done.** `telemetry/tracker.ts` (what a game reports) and `telemetry/errors.ts` (script errors without anything identifying) are pure and unit-tested; `boot/37-telemetry.ts` reads the page's state and feeds them: solo games, versus and online matches, personal bests, perf samples, script errors, install, update. **The client is deliberately not started yet**, so nothing is sent; it starts in 8d-2c together with the TELEMETRY switch and the first-run notice. Details below.
- **Phase 8d-2c (the client started, the notice, Options, `PRIVACY.md`, room events): done.** The client starts at boot only after the first-run notice is answered (or was seen, or telemetry is off); Options has a Privacy group (USAGE DATA switch, WHAT IS SENT, ERASE MY DATA); `room_create` and `room_join` are recorded; `PRIVACY.md` is written; and a real-server browser check (`tests/harness/check_telemetry.py`) passes. It found and fixed a real bug: a player who left an online match lost their game row. Details in "Phase 8d-2c". (The notice and the Options Privacy group of this phase were removed again in 8d-2d.)
- **Phase 8d-2d (the owner's decision: players see nothing about usage data): done.** The first-run notice, the Options Privacy group (USAGE DATA, WHAT IS SENT, ERASE MY DATA), `ui/privacy.ts`, `telemetry/consent.ts`, `telemetry/notice.ts`, the storage key `tetris_telemetry_notice` and the question of a link to `PRIVACY.md` are gone. The client starts at boot whenever the page has an identity and a server that takes telemetry; a browser storage value `tetris_telemetry=off` still stops everything. `PRIVACY.md` is now a reference for operators. `check_telemetry.py` rewritten and passing (also with a deliberate break caught). See "Phase 8d-2d".
- **Phase 8d-2d CI (21 Nov 2026): green.** The owner pushed the 8d-2d zip to the test repo and reported both runs green (`.../runs/44902630536`, `.../runs/44902630485`). Read in the 8e chat: 44902630536 is `pages.yml` (build 54 s, deploy 13 s, site at `https://shayanzz.github.io/tetrizz-test/`, only `pages.yml` ran, so Settings, Pages, Source is on GitHub Actions). 44902630485 (presumably `ci.yml`) could not be opened here (GitHub rate-limited the fetch); it rests on the owner's word.
- **Phase 8e (business dashboards on PostgreSQL, the read-only role): done, CI still to prove the Grafana side.** `compose.analytics.yaml` adds a one-shot job that makes a read-only role (`deploy/postgres/init-analytics.sh`), a Grafana datasource `TetriZZ DB` and two dashboards, **Players and games** and **Player** (27 queries). The queries run as the role against rows the real repository wrote, with hostile payloads, in `tests/server/deploy-analytics.test.ts`. Details in "Phase 8e".
- **Next:** push the 8e zip to the test repo and read the CI run (the new `analytics` variant of `deploy-stack` is the first time a real Grafana loads these files and the standalone PostgreSQL datasource; the `monitoring` variant now also proves that the two empty placeholder provisioning files do no harm). Then: the room list endpoint (see "Open decisions" in Phase 8e: it needs an owner decision), accounts later, and Phase 9 (offline PWA, self-hosted fonts, update flow, service worker precache) from `docs/PLAN.md`.
- **Earlier plan for 8d-2:** wiring the client into the page: `telemetry/index.ts` (the page's real dependencies, see "Phase 8d-1"), the hooks that note games and sessions (see the list there), the TELEMETRY switch and ERASE MY DATA in Options, the first-run notice, `PRIVACY.md`, and a browser check against the fake and the real server. Push the zip to the test repo again afterwards. Then whatever `docs/PLAN.md` lists next (the room list endpoint, Grafana business dashboards on PostgreSQL, accounts later).
- Plan: `docs/PLAN.md` (unchanged; the corrections below supersede it where they differ).

## Phase 8e - business dashboards on PostgreSQL (done; Grafana itself not run here)

Started from `TetriZZ_phase8d2d.zip`. The owner's analytics wish (total games, per-player stats, tracked changes) needs SQL panels, which Grafana can only run against PostgreSQL (PLAN.md section 11).

**What exists**

- `compose.analytics.yaml` (fourth compose file, needs `compose.postgres.yaml` and `compose.monitoring.yaml`; `ANALYTICS_DB_PASSWORD` in `.env`, required). Service `init-analytics-db`: `postgres:18.7-alpine3.24` (already pinned for the database), user 70, read-only root, all capabilities dropped; waits for PostgreSQL and the server to be healthy (the server creates the tables) and runs `deploy/postgres/init-analytics.sh` at every `up`.
- `deploy/postgres/init-analytics.sh` (POSIX sh, psql): creates or updates role `grafana_ro` (`LOGIN`, no superuser, create db or create role, `CONNECTION LIMIT 5`, `default_transaction_read_only = on`, `statement_timeout = 30s`, `search_path` = the schema), grants `CONNECT`, `USAGE` and `SELECT` on all tables, and `ALTER DEFAULT PRIVILEGES` so tables a later migration creates are readable (it runs as the server's own login, so the defaults apply to the right owner). The password reaches psql through `\getenv` (not in the process arguments) and is quoted with `%L`. Role and schema names are restricted to letters, digits and `_`. Settings: `ANALYTICS_DB_USER` (default `grafana_ro`), `ANALYTICS_DB_SCHEMA` (default `public`, must match `DB_SCHEMA`).
- Grafana: `deploy/grafana/analytics/datasources.yml` (uid `tetrizz-db`, type `postgres` as in Grafana's provisioning docs, password `$ANALYTICS_DB_PASSWORD` from the environment, `postgresVersion: 1000`, five connections), `dashboards.yml` (provider for `/var/lib/grafana-dashboards-analytics`), and `dashboards/players.json` and `player.json`. **Mount trick:** Docker cannot create a mount point inside a read-only bind mount, so the base stack ships two empty placeholder files (`deploy/grafana/provisioning/datasources/analytics.yml`, `.../dashboards/analytics.yml`, each just `apiVersion: 1`) and the overlay mounts the real files over them (file over file needs no new mount point). `check_deploy.py` checks that every provisioning mount has its placeholder.
- Dashboards (generated by a throwaway script, not kept; the JSON is the source): **Players and games**, 6 stat tiles (players, games all time, active today, active 7 and 30 days, play hours) and 17 panels (games per day by mode and by device, active and new players, play time, sessions, games by mode, "do new players come back" (next day, within 7 days, each only over players old enough), app versions, devices, performance by device class, script errors, online rooms by backend). **Player**: a most-active table that links to the details (`var-player`), profile, games and hours per day, best by mode, personal-best scores over time, tracked changes (`player_history`), devices, recent games. The player variable is used as `${player:sqlstring}`, never `$player`.
- Time columns are `BIGINT` epoch milliseconds, so queries use `$__unixEpochFrom()::bigint * 1000` and never `$__timeFilter`.

**Found by running the SQL (not by reading it)**

- `$__unixEpochFrom() * 1000` and `30 * 86400000` overflow a 32-bit integer once Grafana substitutes a plain integer literal (8 of 27 panels failed with "integer out of range"). Fixed with `::bigint` casts.
- Event payloads come from players' browsers. A value that is not a number, or a number beyond `double precision` (`1e400`), makes a bare `::numeric`/`::float8` cast fail the whole panel. Every payload number goes through `CASE WHEN jsonb_typeof(..) = 'number' AND abs(..) < 1e9 THEN .. END`. The first test of this was not hostile (JavaScript's `1e400` is `Infinity`, which JSON turns into `null`); the test now inserts the huge number as raw SQL, and removing one guard makes it fail with "out of range for type double precision".
- The performance panel's "Samples" counted malformed events too; it counts only samples with a valid fps now.

**Checked**

- `tests/server/deploy-analytics.test.ts` (38 tests, 7 static and 31 live): static: unique panel ids, no overlapping grid places, only the `tetrizz-db` datasource, `time` column on time series, only the two epoch macros, no `$player`, no write statements. Live (needs `TEST_POSTGRES_URL` and `psql`; CI sets `REQUIRE_ANALYTICS_TESTS=1` so a missing one fails instead of skipping): the script runs twice, every panel query runs as the role against rows written through the repository (a player, device, session, game, events with garbage payloads, history, rollups), values are right (players, games, games by mode, the one valid performance sample, the error hash, profile, best by mode), the role gets `permission denied` for `DELETE`, `UPDATE`, `TRUNCATE`, `CREATE TABLE`, `DROP TABLE` even after its read-only flag is switched off, a table created later is readable, and a bad role name is refused.
- Also by hand on a seeded database (60 players, 754 sessions, 2,238 games, 4,249 events over 46 days, written through `repository`): every query returns plausible rows as the role.
- Whole suite with PostgreSQL 16 here: 45 files, 694 tests pass. Prettier clean, `tsc` clean, ESLint 0 errors (78 warnings, as before). `check_deploy.py` passes (new part "analytics": placeholders, the datasource has no password in the file, the provider path, unique dashboard uids; Docker Compose rendering of the fourth combination and the missing-password refusal run only where Docker exists, i.e. in CI).
- `tests/harness/check_stack.sh analytics` (new variant, also in the CI matrix): the monitoring checks, then Grafana's health check for the `tetrizz-db` datasource, a `DELETE` sent through Grafana must be refused, and every query of both dashboards is run through `/api/ds/query` by Grafana itself.

**Not checked (needs the CI run)**

- No Grafana and no Docker here (Grafana is not on conda-forge or any allowed source), so nothing loaded these files in Grafana. Unproven until CI: that Grafana 13.3.1 accepts `type: postgres` in provisioning (the docs of 12.4 show it; the datasource became a standalone plugin in 13.2 and is preinstalled), `postgresVersion: 1000`, the empty placeholder files, the file-over-file mounts, `$ANALYTICS_DB_PASSWORD` expansion, the panel layouts and options as rendered, and the data links. The macros were checked against Grafana's 13.3 docs (`$__unixEpochFrom()` exists) and expanded by hand here.
- The job's `psql` with PostgreSQL 18 (here: client 16 against server 16), and the alpine image's `sh`. `\getenv` needs psql 15 or newer.
- Panels run on a database with 60 players; nothing was measured at volume (the heavy ones are the return-rate and performance queries; both are bounded by the time range and the 180 and 30 day retention).

**Open decisions for the owner**

- _Room list endpoint_ (PLAN.md section 11, "room registry (list, create, join)"): not built. Rooms are private by code today; a list would show every room whose host did not set a password, so it needs a public/private choice in the create dialog, a lobby screen on the page, and a rule for what is shown (host name, players, mode, but not the code of a private room). Say whether it is wanted before it is built.
- The Player dashboard is by anonymous id only (accounts do not exist). Opted-out players are left out of the counts but their row remains (id and times).

## Phase 8d-2d - players see nothing about usage data (done)

Started from `TetriZZ_phase8d2c.zip`. Decision (owner, 21 Nov 2026), answering the open question of 8d-2c (should the notice link to `PRIVACY.md`): nothing about usage data is to be shown at all, because these are not personal data that players need to know or accept. So there is no link, and no notice either.

**Removed**

- The first-run notice, its text (`telemetry/notice.ts`) and the consent flow that held the client back until it was answered (`telemetry/consent.ts`, with its 9 unit tests in `tests/unit/telemetry-consent.test.ts`, including the test that kept the notice and `PRIVACY.md` in step).
- `ui/privacy.ts` (the notice dialog, the information dialog, the switch, ERASE MY DATA), the Options Privacy group (three rows and their handlers in `ui/screens.ts`) and `syncPrivacyGroup` in `ui/settings.ts`.
- The storage key `tetris_telemetry_notice` (`STORAGE_KEYS`, `TELEMETRY_NOTICE_KEY`).

**What the page does now**

- `startPageTelemetry()` (no argument) waits for the network settings, returns `unavailable` when the page has no identity or no server address that takes telemetry, and otherwise starts the client at once. Nothing is shown. `pageTelemetry()` is still null until the client has started.
- Kept on purpose: `tetris_telemetry=off` in browser storage. The client honours it (notes nothing, sends nothing, not even a first message). The harness pages that configure a server rely on it. It has no screen.
- Kept on purpose: the client's `setEnabled` and `eraseMyData`, the server's opt-out and erase endpoints and their tests. Nothing in the page's screens calls them now; accounts and a profile page will need them. Dead code in the page's sense, but part of the tested client.
- `PRIVACY.md` is rewritten as a reference for operators (what is sent, what is not, the controls that exist, retention, a note that whether players must be told depends on where they are and on local rules, not legal advice, and where a notice would go if it is ever needed). The notice and the Options text are no longer promised anywhere. `docs/PLAN.md` is unchanged and still describes the opt-out switch and a link; this entry supersedes it.

**Checked**

- `npx vitest run`: 44 files, 629 tests passed, 2 skipped (638 before, minus the 9 consent tests). Typecheck clean, Prettier clean, ESLint 0 errors (78 warnings, all in existing code).
- `tests/harness/check_telemetry.py` rewritten, 20 checks pass against the real built server: no dialog and nothing about usage data on the menu or in Options (A3 to A5, B1, B2); the client starts at once and `app_start` and a solo game reach the database (A1, A2, C1, C2); a page with `tetris_telemetry=off` makes no telemetry request and the server never hears of it (D1 to D3); two pages in one online room send one `room_create` and one `room_join` and the match is one game with two rows (E1 to E7). Deliberate break: putting a `data-privgrp` row back in Options made B1 and B2 fail; restored.
- Harness on both builds: solo traces, the 4-player bot trace and the fixtures identical to the goldens. Screens (single file): 76 shots, 24 failing, worst 8.4473 %, the same as before (the known font gap; no Options shot among them). `check_network_config`, `check_backend_pick` and `check_server_room` pass on the multi-file build.

**Not checked**

- ERASE MY DATA and the opt-out switch no longer run in a browser (no screen). The client and API tests cover the calls; `check_telemetry.py` no longer proves them end to end.
- `check_telemetry.py` is still not in CI. `check_front_door` (needs Caddy) and `check_server_real` (fails at A1 in this sandbox) were not run.
- CI has not run this zip.

**Open items**

- Rooms made through the LAN screen and the relay screen's own flow are not counted as room events (unchanged from 8d-2c).
- The client now starts at boot as soon as the network settings are known, so a very fast player can be in a game before it starts; those first moments are simply not noted.
- Accounts do not exist yet; when they do, `PRIVACY.md` must say what is linked to them.

## Phase 8d-2c - the client started, the notice, Options, `PRIVACY.md`, room events (done)

Started from `TetriZZ_phase8d2b.zip`. The page now sends telemetry when it has a server that takes it and the player has not said no. **Superseded in 8d-2d:** the first-run notice, the Options Privacy group and everything about them in this section were removed on the owner's decision; the rest stands.

**What was built**

- `telemetry/consent.ts` (pure, `startWhenAllowed`): decides when the client may start. No identity or no server address: nothing starts and nothing is shown. The player switched telemetry off earlier, or has seen the notice: the client starts. Otherwise the notice is shown and the client starts only after the answer; a page closed with the notice open has sent nothing. TURN OFF switches telemetry off before the client starts (`setEnabled(false)`), and the client tells the server at start.
- `telemetry/notice.ts`: the notice text (title, seven lines). `PRIVACY.md` says the same in more detail; `tests/unit/telemetry-consent.test.ts` keeps the two from drifting (the notice's promises must appear in `PRIVACY.md`).
- `telemetry/index.ts`: `startPageTelemetry(showNotice)` (the page supplies the dialog so this folder never imports the UI). The client exists as soon as it is made but `pageTelemetry()` stays null until it has started, so nothing is noted before the player could say no.
- `ui/privacy.ts`: the first-run notice (OK keeps it on; TURN OFF, or Esc, switches it off), the information dialog, the switch, and ERASE MY DATA (asks first, then says whether the server was reached; if not, the request is kept and sent later).
- Options: a Privacy group with USAGE DATA ON/OFF, WHAT IS SENT and ERASE MY DATA, shown only when the page has a telemetry server (`syncPrivacyGroup` in `ui/settings.ts`; hidden again once the server answered 404). The switch applies at once; it does not wait for SAVE.
- Storage key `tetris_telemetry_notice` (in `STORAGE_KEYS`; `TELEMETRY_NOTICE_KEY` in `telemetry/client.ts`).
- Events: `roomEntered { how, backend }` on the bus, emitted by `noteRoomEntered` from the six create/join success points in `net/online-lobby.ts` (a reconnect to a room the player already had is not a join); `boot/37-telemetry.ts` records `room_create` / `room_join` with `{ backend }`. New before-event `leaveOnlineRoom`, emitted at the start of `leaveOnlineRoom` and `forcedLeave`.
- `PRIVACY.md` at the repo root: what is sent, what is not, the player's choices, retention (events 30 days, games and sessions 180 days, daily totals without any player id for ever, a player's own daily numbers and personal bests until erased), notes for operators.

**A bug found and fixed**

A player who left an online match through the menu lost their game row (the match had one row instead of two). `leaveOnlineRoom` clears the room's state (the remote stations, the online flag) before it calls `quitToMenu`, so the quit hook could not read the page's own numbers. `boot/37-telemetry.ts` now reads them on the new `leaveOnlineRoom` before-event, while the room is whole (`quitVersus`). Proved with `check_telemetry.py`: with the hook removed, F5 fails; with it, it passes.

**How it was checked**

- `tests/harness/check_telemetry.py` (new; real time, about 2 minutes): the built page against the real built server with a SQLite file. Build the page with `TETRIZZ_SERVER_URL=http://127.0.0.1:18795`, then `python3 tests/harness/check_telemetry.py <dist> [<server>/index.js]`. It proves: the notice is shown and nothing is sent before it is answered; OK starts the client and the first batch (with `app_start`) arrives; the switch opts out and back in at the server, and a game played while off sends nothing; a game played while on reaches the database; ERASE MY DATA removes every row of the player; TURN OFF at the first start reaches the server as an opt-out with no event and no game; and two pages in one online room send one `room_create` and one `room_join`, and the match is ONE game with one row per player (the match id path, `takeMatchId`, now ran with two real pages).
- Lesson for harness checks: waiting for the database must go through the browser connection (`page.wait_for_timeout`), not `time.sleep`; the pages' requests pass through Playwright route handlers that only run while the connection is pumped, so a plain sleep stalls them and the page aborts its request after 10 seconds.
- The harness pages that configure a server (`check_server_room`, `check_server_real`, `check_backend_pick`, `check_front_door`, `check_network_config`, and `open_page` in `check_relay_handshake`) now set `tetris_telemetry=off`, so the notice does not block them and they send nothing. Pages that configure no server never show the notice.
- `npx vitest run`: 45 files, 638 tests passed, 2 skipped. 9 new tests (consent flow, notice against `PRIVACY.md`). Typecheck clean, Prettier clean, ESLint 0 errors (78 warnings in existing code).
- Harness, single-file and multi-file builds: solo traces and the 4-player bot trace identical to the goldens, fixtures pass. The screenshot part fails on 24 of 76 shots, worst 8.4473 %, the same numbers as the untouched 8d-1 and 8d-2a builds in this sandbox (the known font gap); the new Privacy rows are hidden on pages without a server, so no shot changed.
- `check_server_room` and `check_backend_pick` pass on the multi-file build after the last change; `check_network_config` passes. `check_front_door` needs Caddy and was skipped. `check_server_real.py` was not run (it fails at A1 in this sandbox, where the page's socket never reaches its proxy); `check_telemetry.py` ran two pages in a room on the real server with direct sockets, without that proxy.

**Open items**

- (Resolved in 8d-2d: there is no notice and no link.)
- Rooms made through the LAN screen and the relay screen's own flow (both end in `lanEnterOnlineLobby`) are not counted as room events; only the six online-lobby success points are.
- The notice is shown at boot after the network settings are known; a very fast player could be in a game by then. Not handled.
- `check_telemetry.py` is not in CI (it needs a page build for port 18795 and the server build).
- Accounts do not exist yet; when they do, `PRIVACY.md` must say what is linked to them.

## Phase 8d-2b - the page's hooks (done; the client is not started yet)

Started from `TetriZZ_phase8d2a.zip`. The page now notes its games and errors, but `pageTelemetry()` is still null, so every call is a no-op and nothing is sent. Starting the client is the first thing 8d-2c does, together with the TELEMETRY switch and the first-run notice, so that no page can send anything before the player can say no.

**What was added**

- `apps/web/src/telemetry/tracker.ts`: `createGameTracker(sink, playerId, now)`. Pure: takes snapshots, writes `record`, `recordGame` and `recordHistory` calls. Solo and versus are separate (`soloStarted/soloEnded/soloQuit`, `versusStarted/versusEnded/versusQuit`, `open()`).
- `apps/web/src/telemetry/errors.ts`: `describeError` (name, a message of at most 120 characters with long tokens blanked, `file.js:line` without any path, a hash of the top three stack frames) and `createErrorReporter` (each distinct hash once, at most five per page load).
- `apps/web/src/boot/37-telemetry.ts` (imported last in `main.ts`): the only place that reads page state for telemetry. Hooks on the event bus: `startCountdown` (before: close an open solo game as quit; after: note the start), `gameOver` (before: remember the saved best; after: report), `vsStartMatch`, `vsMatchEnd`, and the new `quitToMenu`. Plus `error`, `unhandledrejection`, `appinstalled` and the service worker's `controllerchange` (only when the page was already controlled, so a first install does not count as an update).
- `quitToMenu` now emits a `quitToMenu` before-event (the event map has it). Nothing listens besides telemetry, so the game is unchanged.
- `onlineSessionState.onlineMatchStamp` (`{ ts, order }`): the host sets it where it builds `settings.st`, a guest sets it in `onNetStart` from `settings.st` and `order`. The telemetry hook takes it at match start and clears it; a stamp older than two minutes is ignored. It feeds `matchGameId` so every page of one online match reports the same game id (8d-2a).

**What is reported (the rules, so the dashboards can rely on them)**

- A game that ended, or was left through the menu after at least one piece, is one game with the player's own row. A game left with no piece played is not reported. A tab that is closed or reloaded mid-game is not reported (there is no safe moment to read it).
- Modes: `endless`, `sprint`, `ultra`, `practice` for solo; `vs-<submode>` for local versus and `online-<submode>` for online (for example `vs-battle`, `online-wide`).
- Results: sprint is `win` when the line target was reached and `loss` when the board topped out first; endless, ultra and practice end as `finished`; versus is `win` or `loss`; leaving through the menu is `quit`.
- Versus rows use the player's own station (board 1). A page with no human on board 1 reports nothing. `bots` counts bot stations that are not remote online players; `botLevel` is the first bot's level. PPS and APM use the player's own play time; the game's `durationMs` is the longest play time of any player.
- Events: `game_start` (mode), `perf_sample` once per finished solo game or match with at least 120 frames (mode, fps, median, p95 and max frame ms, bot think ms, quality tier), `js_error`, `install`, `update_applied`. History: `personal_best` (score, or time in ms for sprint) using the page's own rule for a record.
- Decided here, easy to change: no separate `game_end` or `match_result` event, because the game row is that data and also covers quits.

**Checks**

- 22 new unit tests (`tests/unit/telemetry-tracker.test.ts`); ten deliberate breaks (quit with no piece, dropped match id, sprint win, seat clamp, personal best, start stamp, long tokens kept, dedupe, error limit, path leak) each failed the tests and were restored. Whole suite: 629 passed, 2 skipped. Prettier, ESLint (0 errors) and `tsc` clean; both builds pass.
- Harness on the single-file build: solo traces, the 4-player bot trace and the fixtures are unchanged (`verify.py --part solo`, `vs`, `fixtures`: PASS).
- Live-state check in Chromium on a throwaway build whose sink also logged to `window.__tseen` (not kept): a solo endless game to game over gave a `finished` row, `personal_best`, `perf_sample` and `game_start`; a sprint left through the menu gave a `quit` row; a versus match against one bot gave a `loss` row with `bots: 1`, `botLevel: 7`, PPS and APM; no page errors.

**Not checked yet**

- The online match id path (`takeMatchId`, the two-minute age rule, the host and guest stamps) has not run with two pages in a room; `matchGameId` itself is covered by 8d-2a's tests.
- Nothing was sent to a server (the client is not started). The end-to-end check against the fake and the real server belongs to 8d-2c.
- Screens part of the harness not rerun (no UI changed).

**Next: Phase 8d-2c**

1. Start the client at boot (`startPageTelemetry()` in `boot/37-telemetry.ts`), only with the switch and notice below in place.
2. Options: a TELEMETRY switch (shown only when a server is configured) and ERASE MY DATA behind the page's `askConfirm`; the choice goes to the server through the client's existing consent call.
3. The first-run notice (what is sent, what is not, how to turn it off), shown once.
4. `PRIVACY.md` at the repo root and a link from the notice.
5. Room events (`room_create`, `room_join`): entry points are scattered in `net/online-lobby.ts`, `net/relay.ts` and the LAN module (the `onlineRoomId =` assignments), so decide whether to add one `roomEntered` event and emit it from the success points.
6. Browser check: the built page against the fake server and the real server (`check_server_real.py` pattern), including two pages in one online room to prove the shared game id and the one-game-two-rows result.

## Phase 8d-2a - one game per match, the page's real dependencies (done; not wired into the page yet)

### Decision (owner, 20 Nov 2026)

A match of four humans is one game with four rows, not four games. More accurate for the dashboards; it needed a small server write, "add my row to this game".

### Server

- `recordGame(game, rules?)` now returns `created`, `joined`, `duplicate` or `refused`. When the id exists, the rows of the report that the game does not have yet are added in the same transaction; the game's own fields stay as the first report had them (so a multiplayer game's device class and app version are the first reporter's).
- A report belongs to an existing game only if its mode is the same and its start is within 2 minutes (`GAME_JOIN_WINDOW_MS`, option `gameJoinWindowMs`), and the game keeps at most `TELEMETRY_MAX_GAME_PLAYERS` (16) rows. Otherwise `refused`: nothing is written and the ack counts one in `rejected`. The check is inside the transaction; two joins at the same instant can overshoot the limit by a row (not tried on PostgreSQL).
- The ack has an optional `joined` count (left out when none); `/api/v1` stats have `gamesJoined`; `/metrics` has `telemetry_items_total{kind="game",outcome="joined"}`.
- The sender-only rule is unchanged (its existing test still passes, and a new one tries to smuggle in a third player's row while joining). An opted-out player adds nothing. ERASE MY DATA already handled shared games: it removes that player's row and the game only when no row is left (new contract test).
- A row joined after its day was rolled up shows in that day's numbers only when the day is rolled up again (a test shows that a second `rollupDay` picks it up). Not checked: whether the janitor rolls recent days up more than once.

### Page

- `GameReport.id` is optional: a valid shared id is used, anything else gets the client's own fresh id.
- `telemetry/address.ts`: `telemetryBase(configured, origin)` (http(s) or ws(s) URL, or a path on the page's origin; null switches telemetry off) and `matchGameId({room, stamp, order})`, a hash of the room id, the host's start stamp and the player order, valid for the server's id format, null when a part is missing (then each page reports under its own id).
- `telemetry/page.ts`: `createPageTelemetry(env)` (fetch with credentials omitted, no cache, a 10 s abort and `Retry-After`; `sendBeacon` with the string body; IndexedDB store or the memory store; storage that never throws; ids and jitter from crypto bytes, never `Math.random`) and `watchPage` (`online`, `pagehide`, hidden `visibilitychange`). All browser objects come in through `PageEnv`.
- `telemetry/index.ts`: `startPageTelemetry()` builds the env from the real `navigator`, `screen`, `matchMedia`, `netConfig`, `clock` and the player key, waits for `networkConfigReady()` (the runtime `config.json` may name the server), then starts the client; `pageTelemetry()` returns it or null. The two storage keys `tetris_telemetry` and `tetris_telemetry_todo` are in `STORAGE_KEYS`.

### Checked

- `npx vitest run`: 43 files, 607 tests passed, 2 skipped (the PostgreSQL contract). New: 6 shared-game contract tests (both databases' contract, run on SQLite here), 5 API tests including two real page clients reporting one match to the real API (the "feed the client's batches to the real server" item of 8d-1 is done: each client's start event, an event, a game and a history line were sent through `createTelemetryClient` to the real API and its queue emptied; the server then held both players' events and one game with both rows, and one client's ERASE MY DATA left the other's row), 26 page tests.
- Typecheck clean in every workspace, Prettier clean, ESLint 0 errors (78 warnings, none in the files of this step), both builds.
- Nine deliberate breaks, each failing at least one test: later row never added, same-mode/time check removed, row limit ignored, own-row filter removed, cookies sent, request timeout never armed, line-up left out of the match id, `ws:` not turned into `http:`, hidden check dropped. Files restored after each.
- Harness on the single-file build: solo traces and the 4-player bot trace identical to the goldens, fixtures pass. The screenshot part fails on 24 of 76 shots, worst 8.4473 %, and the untouched 8d-1 build fails the same 24 shots in this sandbox (the percentages differ by 0.0002 %), so it is the known font gap, not this step. The page does not import the telemetry code yet, so its behaviour is unchanged.

### Not checked

- `telemetry/index.ts` and the beacon path have not run in a browser (nothing imports `index.ts`); `createIndexedDbStore` still ran against `fake-indexeddb` only.
- PostgreSQL: the contract tests for the new join rules were not run on it (no database here; CI runs them).
- The harness' `Math.random` and boot rules are not exercised until the page starts the client.

### Plan for 8d-2b (the page)

1. Start the client at boot (`startPageTelemetry` after the identity), only when a server is configured.
2. The match id for online matches: the host makes `settings.st = {order, seed, ts}` and sends it in `start`; a guest's `onNetStart` copies it into the lobby state, the host's own copy is not stored, so keep the stamp on both sides (a new field in the online session state), build the id with `matchGameId({room, stamp, order})`, and fall back to the client's own id when any part is missing. The seed alone is not unique (it is the same for every match of a room).
3. Hooks: `game_start` and `game_end` (`startCountdown`, `gameOver`; solo modes use `game.score`, `lines`, `pieces`, `playMs`), `match_result` (`vsMatchEnd`), the game record for every mode with the player's own row, online room events, `js_error` (hashed stack, rate limited), `perf_sample`, `install`, `update_applied`, `personal_best` history.
4. Options: a TELEMETRY switch (only when a server is configured), ERASE MY DATA with a confirmation, and the first-run notice.
5. `PRIVACY.md`, and a browser check against the fake and the real server. Push the zip to the test repo afterwards.

## Phase 8d-1 - the page's telemetry client (done; not wired into the page yet)

### What the CI run of the 8c-4d zip showed (logs read in this chat)

- Every job passed: `check` (39 files, 545 tests, lint 0 errors and 78 warnings, types, both builds), `deploy-files`, `deploy-stack` lite and postgres and monitoring (`all good (monitoring)`: the Watchdog reached the heartbeat address through Prometheus and Alertmanager), `regression` (the screenshot step is informational: 72 of 76 shots differ, worst 8.76 %, the known font gap).
- `pages.yml`: build and `deploy-pages` v5 succeeded, the site is at `https://shayanzz.github.io/tetrizz-test/`. Whether Settings, Pages, Source is already "GitHub Actions" cannot be read from these logs; see 8c-4d.
- One odd line: `webhook deliveries failed so far: ?`. The step only prints; it never fails on it. Cause: Alertmanager 0.35's metric carries a `reason` label (`alertmanager_notifications_failed_total{integration="webhook",reason=...}`), so the exact-match grep found nothing. Fixed in `tests/harness/check_stack.sh`: it matches the label prefix and sums the series (tried on sample metrics). The `AlertDeliveryFailing` rule already uses `sum by (integration)`, so it was never affected. Not run in Docker; the next CI run shows a number.

### What exists (`apps/web/src/telemetry/`, imported by nothing yet)

- `queue.ts`: `createQueue(store, limits, warn)`. Items are events, games and history lines, each with the id the page made up. Capped at 1,000 items and 1 MB; an item over 8 KB is refused. When full it drops performance samples first, then other events, then history, then games, oldest first inside each group. `take` hands out the oldest items within the per-kind limits and a byte cap. Items noted before `load()` finishes are held and added after it, so they cannot take a stored item's place. A failing store is reported once and the queue goes on in memory. `createMemoryStore` is the fallback.
- `idb-store.ts`: `createIndexedDbStore(indexedDB)`, one object store keyed by `seq`.
- `device.ts`: `collectDevice(env)` never throws. It sends only what the server's user agent parsing cannot say: device class (touch and screen size, so an iPad that claims to be a Mac is a tablet), screen bucket (short side first, rounded to 20), pixel density (quarters), cores (a bucket), memory, language, display mode (single file, installed app, browser) and, from Chromium's high-entropy values, system name and version (Windows 11 read from platform version 13 or more) and Android model. Page fields override the server's parse (`mergeDevice`), so `os` is sent only when the high-entropy values were read.
- `client.ts`: `createTelemetryClient(deps)`; every outside thing (identity, server address, store, key-value storage, HTTP, beacon, clock, random, timers, online state) is injected. Calls: `start`, `record(kind, payload)`, `recordGame`, `recordHistory`, `flush`, `flushOnHide`, `setEnabled`, `eraseMyData`, `online`, `status`.

### How it behaves (decided here, easy to change)

- Nothing is noted or sent without an identity, a server address, and telemetry on. A server that answers 404 (no `/api/v1`) switches telemetry off for the rest of the page load and empties the queue; a 403 `identity` does the same.
- Sending: 20 s after the first item (1 s when 50 or more are waiting; 3 s after start), on `online`, and on page hide through `sendBeacon` (the key is in the body, so no header is needed). Up to 5 batches per flush, within the server's limits (200 events, 20 games, 50 history lines, about 200 KB). The POST is `text/plain`, so a page on another origin needs no preflight; PUT and DELETE carry `Authorization: Bearer <key>` and do.
- A batch is forgotten only after a 200 answer (the server answers stored, duplicate, rejected and stale items alike, all of which the page can forget). Network error, 5xx or 429: the queue stays and the wait grows from 30 s up to 15 min (with jitter, and at least the `Retry-After` the server sent). 400, 413 or 415: the batch is halved until a single item is left, which is dropped, so one bad item cannot block the queue.
- Every batch carries the session (id, start, `endedAt` = now, version, display mode, device class); the device goes with the first batch until the server has answered it. Items noted offline carry `offline: true`, and so does the session if it began offline. A page hide sends the queue and the new session end once; items already handed to the beacon are not handed over again, and stay queued until a normal answer confirms them (the server dedupes by id).
- The player's choices: `setEnabled(false)` empties the queue, stops noting, and tells the server (`PUT .../telemetry {optOut:true}`); a failure is remembered in `tetris_telemetry_todo` and retried at the next flush, start or `online`. `eraseMyData()` empties the queue and sends `DELETE`; if telemetry is off it then sends the opt-out again (the delete removes the flag). If the server says the player is opted out (another browser with the same key), the page switches off too, unless a choice of its own is still waiting to be sent.
- Storage keys: `tetris_telemetry` (`off` when switched off; absent means on) and `tetris_telemetry_todo`. **Both must be added to `STORAGE_KEYS` in `core/storage.ts` when the client is wired in**, and the todo key should not go into a settings export (a pending erase must not travel to another device).
- No `Math.random` is read (random bytes come from `crypto`, which the page identity needs anyway), so the harness' seeded sequence is not disturbed. Telemetry is off wherever no server is configured, which includes every harness page that does not configure one.

### Checked

- 19 new tests (`telemetry-queue`, `telemetry-device`, `telemetry-client`; `fake-indexeddb` 6.2.8 is a new dev dependency, looked up live on 20 Nov 2026 as the latest; published 8 Nov): 564 pass in total, 2 skipped as before; format, lint (0 errors, 78 warnings as before), typecheck and both builds clean. The built page is unchanged because nothing imports the new files.
- The tests found one real fault before it shipped: two flush timers (the 20 s one from `app_start` and the 3 s one from start) kept the later one, so the first batch waited 20 s. The timer now keeps the earlier deadline.
- Eleven deliberate breaks, each caught: samples not dropped first, cap not enforced, items noted before load not held, confirmed items never removed, no backoff on server errors, opt-out ignored, erase not repeating the opt-out, beacon repeating items, opt-out without the key, a refusal not remembered, an invalid batch never shrinking.

### Not checked

- No real browser: `createIndexedDbStore` ran against `fake-indexeddb` only (a private window or blocked storage would reject and fall back to memory; that path is tested with a failing store, not in Chromium). `sendBeacon` and `getHighEntropyValues` were not run anywhere.
- Not run against the real server: the client's request shapes were read from `api.ts` and `telemetry.ts` and checked against `parseTelemetryDevice`, but no test sends a batch built by the client into `parseTelemetryBatch` or the real `/api/v1`. Done in 8d-2a.
- The rule for who reports a game (8c-2a) was open here; decided in 8d-2a: one game per match, each page reports its own row.

### Plan for 8d-2 (the page)

1. `telemetry/index.ts`: real dependencies (identity from `net/identity.ts`, the server address from `netConfig` with the same rules as `serverSocketUrl` but http(s), `createIndexedDbStore(indexedDB)` or the memory store, `fetch` with a timeout and `Retry-After`, `navigator.sendBeacon`, `crypto` ids, the `online` and `pagehide`/`visibilitychange` listeners, `device` from `collectDevice` with the real `navigator`, `screen`, `matchMedia`).
2. Hooks: `app_start` (done by `start`), `game_start` and `game_end` (the `startCountdown` and `gameOver` events; solo modes use `game.score`, `lines`, `pieces`, `playMs`), `match_result` (`vsMatchEnd`), online room events, `js_error` (hashed stack, rate limited), `perf_sample` (from the overlay's counters), `install` and `update_applied`, `personal_best` history.
3. Options: a TELEMETRY switch (shown only when a server is configured), ERASE MY DATA with a confirmation, and the first-run notice (with onboarding).
4. `PRIVACY.md`, `docs/SERVER.md` and `CHANGELOG.md`.

## Phase 8c-4d - the second CI run of the stack (done)

### What the CI run showed (the 8c-4c zip, pushed to `ShayanZZ/tetrizz-test`; logs read in this chat)

- Passed: `check` (39 files, 545 tests, PostgreSQL 18, lint, types, both builds), `deploy-files` (every validator, the real-Caddy front door), `deploy-stack` lite and postgres to "all good" (images, front door, `scripts/healthcheck.sh`, backup, stop, restore, healthy again).
- `regression`: fixtures, solo traces and the 4-player trace pass on both builds (the 8c-4c `boot_draws` fix works on a real runner), and the relay, config, backend-pick and UI smoke checks pass. The informational screenshot step (`continue-on-error`) reports 72 of 76 shots different, 0.1 to 8.8 % of the pixels. That is the known gap in "Known gaps": the goldens were recorded in the sandbox's Chromium with its fallback fonts, the runner has other fonts. It is not a page fault and it is not a failed job. If a green screenshot step is wanted, the goldens have to be re-recorded on the runner (not done; see "Left open").
- `deploy-stack` (monitoring) passed, for the first time on a runner: Alertmanager healthy (the `tmpfs` option, the `nobody` user, `wget` in the image), Loki ready, Grafana's datasources and three dashboards, Alloy logs in Loki, `tetrizz_db_up` through Grafana, backup and restore with the monitoring stack up. It failed at the last step, the Watchdog heartbeat: "the heartbeat request is not the Watchdog alert", with only `POST /ping` and the headers in the sink's file.
- Cause: Alertmanager's log shows the first five attempts failing (the sink container was not started yet, normal) and then "Notify success" (attempts=6, 200 OK). The sink was `printf <response> | nc -l -p 8080` in busybox: `nc` stops when its input ends, so it wrote the headers and left without reading the 1,036-byte JSON body, which is where `Watchdog` is. Nothing is wrong in the stack; the test could not see what arrived.
- Fix (`tests/harness/check_stack.sh`): the sink is a few lines of Node (`http.createServer`, appends method, path and body to `/tmp/hits`) run with `--entrypoint node` from the already built `tetrizz-server:local`, so no extra image is pulled. Tried here as the same JS with a 1 KB JSON POST (method, path and body all recorded); `node --check` on the exact text that goes into `-e`; `bash -n` on the script.
- Also seen, harmless: Loki's "empty ring" line from its rate store in single-binary mode, node-exporter's InfiniBand collector error on the runner, Alertmanager retrying while the sink was not up.

### GitHub Pages in the test repo

Two Pages runs happened for the push: the repository's own `pages.yml` (built the page, deployed) and GitHub's built-in "pages build and deployment" with Jekyll, which built the repository root (its output is the README). The second one runs because Settings, Pages, Source is still "Deploy from a branch". Both deployed to the same site, so which one is live depends on which finished last (here `pages.yml`, by 20 s). Set Source to **GitHub Actions** (already in `docs/DEPLOYMENT.md`); then only `pages.yml` runs.

### Left open

- The heartbeat step has still not passed in CI (fixed here, not run in Docker).
- Screenshot goldens on a runner (above). Options: leave as is (informational), or have the job upload the runner's shots as an artifact and re-record the goldens from them.
- Telegram and Discord delivery, and the heartbeat against a real checking service, need a real deployment.
- File modes: the zip has the scripts executable, but git on Windows stores them as 644. Nothing needs the bit: CI, `compose.monitoring.yaml` and `docs/DOCKER.md` all run them as `bash scripts/...` or `sh`. The `git update-index --chmod=+x` step in the 8c-4c "Next" line is not needed.

## Phase 8c-4c - the first CI run of the stack, and Alertmanager (done)

### What the CI run showed (the 8c-4b zip, pushed unchanged to the owner's test repo; logs read in this chat)

- `check` (535 tests with PostgreSQL 18, lint, types, both builds) and `deploy-files` (every vendor validator including Docker Compose, Caddy, promtool, Loki, Alloy, shellcheck, and the real-Caddy front door) passed.
- `regression` failed at its first step: `verify.py --part solo` said the traces of endless, ultra, sprint and wide differ. Reproduced here at once (the very first snapshot, `cur` 6 instead of 5). Cause: the v1.2.0 page drew one number from `Math.random` at start to make its random player id (`tetris_pid`); since 8c-4b the id comes from `crypto.getRandomValues`, so the harness' seeded sequence, and with it every piece bag, was shifted by one. The goldens are right. Fix: `tests/harness/lib.py` skips one number for new builds (`boot_draws`; none for a path under `legacy/`). Both parts pass again on the multi-file and single-file builds. Lesson: the 8c-4b chat did not run `verify.py`; it must be part of any change that touches boot.
- `deploy-stack` (lite, postgres): images built, containers healthy, `/healthz`, `/readyz` and `/config.json` passed, then "the page is not served": `curl: (23) Failure writing output to destination`. Cause: `curl ... | grep -qi '<title>'` under `set -o pipefail`; `grep -q` leaves at the first match and curl, still writing the rest of a page bigger than a pipe buffer, fails. Fix: `check_body` fetches first and looks afterwards, for every such check in `check_stack.sh`; `count` and `inside` helpers likewise.
- `deploy-stack` (monitoring): everything up to Loki started; Loki stayed "unhealthy" and `docker compose up` stopped with "dependency failed to start". Cause found in the upstream Dockerfile (`cmd/loki/Dockerfile` at v3.7.9): the Loki image is `gcr.io/distroless/static:nonroot`, with no shell, wget or curl, so `CMD-SHELL wget ... || curl ...` can never succeed (the check script's own `docker compose exec loki wget` could not either). Loki itself is fine: the same configuration run here as a binary is ready after about 20 s. Fix: no health check on Loki, Alloy and Grafana use `service_started`, Prometheus scrapes Loki (and Alloy and Alertmanager) and `MonitoringComponentDown` fires when one stops answering, the stack check asks Loki through the Prometheus container (a busybox image with wget), and `check_deploy.py` fails a compose file that gives Loki a health check or waits for it to be healthy.
- Docker, Compose and the images work in CI as a whole: both Dockerfile targets built, the init jobs ran, Caddy and the server reached healthy, Prometheus reached healthy.
- Diagnostics: when a stack check fails it now prints each container's health check output (`docker inspect`, last probes with exit codes) before the log tails; the first run showed only that Loki was unhealthy and not why.
- 78 lint warnings (76 before; two came with the identity code); no errors.

### Alertmanager (decided by the owner: Alertmanager, not Grafana-managed alerting)

- `prom/alertmanager:v0.35.0` in `compose.monitoring.yaml` (looked up live on 19 Nov 2026: the newest release; published 9 Nov, v0.34.0 of 16 Aug is the fallback; 0.36 and 0.35.1 do not exist yet). One instance, `--cluster.listen-address=` (clustering needs a private address and Alertmanager exits without one: seen when run here without network). Health check `wget` on `/-/healthy` (the image is busybox-based, like Prometheus' that passed). Published on `127.0.0.1:9093` only.
- Configuration is made at container start: `deploy/alertmanager/routes.yml` (static: grouping, routes, inhibition) plus receivers written by `deploy/alertmanager/entrypoint.sh` (POSIX sh, runs as the image's `nobody` user) from `ALERT_TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID`, `ALERT_DISCORD_WEBHOOK_URL`, `ALERT_HEARTBEAT_URL` in `.env`. Secrets are written to files in a 1 MB `tmpfs` (`/run/alertmanager`, mode 0700) and referenced with `bot_token_file`, `webhook_url_file` and `url_file`, so the YAML holds none and nothing secret reaches disk. A wrong value stops the container with a message naming the setting.
- Routing: everything goes to receiver `owner` (Telegram and/or Discord); grouped by alert name, first message after 30 s, at most every 5 min while the group changes, repeated every 4 h (critical: every hour); resolved messages are sent. `Watchdog` (always firing, `vector(1)`) goes only to receiver `heartbeat` (a webhook POST once a minute, no resolved message). Inhibition: `HostDiskCritical` over `HostDiskLow`, `TetrizzDatabaseOverBudget` over `TetrizzDatabaseNearBudget`, `TetrizzServerDown` over the server's other alerts.
- Prometheus: `alerting` to `alertmanager:9093`; new scrape jobs `loki`, `alloy`, `alertmanager`; new rules `Watchdog`, `MonitoringComponentDown` (`up{job=~"loki|alloy|alertmanager"} == 0` for 5 min), `AlertDeliveryFailing` (more than 2 failed deliveries in 30 min); 18 rules with promtool tests for each new one.
- Decisions (easy to change): the heartbeat is the answer to "the whole VPS is down" (nothing on the machine can report that); Telegram and Discord are the two receivers because the room server's own notifier already uses them (email left out; a receiver is a few lines in `entrypoint.sh`); the `ALERT_*` settings are separate from the server's `TELEGRAM_*` so another bot or channel can be used; `.env` holds them (like the other secrets of the stack) instead of Docker secrets files, so there is one place to edit; no Grafana datasource for Alertmanager (its own page on `127.0.0.1:9093` and `amtool` show and silence alerts).
- `docs/DOCKER.md` has an "Alerts" section (settings, how messages are sent, silencing with `amtool`, creating the heartbeat check at healthchecks.io, Better Stack or Uptime Kuma).

### Checked here

- A real Alertmanager 0.35.0 binary with the rendered configuration and a local webhook: the Watchdog alert arrived at the heartbeat address as a POST at once, `TetrizzDatabaseErrors` was suppressed while `TetrizzServerDown` fired, an unrelated alert stayed active.
- `amtool check-config` on the configuration rendered for no integrations, Telegram only and everything; `amtool config routes test`: Watchdog goes to `heartbeat`, a critical alert, a warning and an unknown alert go to `owner`. All in `check_deploy.py` (CI fetches amtool 0.35.0).
- 10 new vitest tests for the entrypoint (secrets only in owner-only files and never in the YAML or the output, receivers, every refusal); a deliberate break (`umask 022`) was caught.
- promtool 3.13.5: config valid, 18 rules, all unit tests pass. shellcheck 0.11.0 clean on the scripts, `check_stack.sh` (now included) and the entrypoint (as `sh`). `check_deploy.py`: also checks the Loki rule above (a deliberate break was caught), that `prometheus.yml` has the alerting target and the three scrapes, and that every alert named in `routes.yml` exists as a rule.
- Full unit suite: 524 pass, 2 skipped (PostgreSQL contract tests without `TEST_POSTGRES_URL`; CI runs them); format, lint (0 errors) and typecheck clean. The browser regression sequence of the CI workflow ran in full here against both builds, with `HARNESS_SLOWDOWN=2`: all steps pass.

### Not checked

- Docker, again (none here): the new `alertmanager` service has not started in a container (the `tmpfs` option `uid=65534,gid=65534,mode=0700`, the `nobody` user writing `/alertmanager` and `/run/alertmanager`, `wget` in the image); the stack check's heartbeat sink is a `busybox:1.37.0` container running an `nc -l` loop, whose `nc` behaviour was not run here; the tag `prom/alertmanager:v0.35.0` was not pulled.
- Telegram and Discord delivery against the real services (the sandbox cannot reach them). The Telegram `parse_mode: HTML` default message was not read.
- Docker Compose rendering of the new service (only YAML parsing here; CI's `deploy-files` renders it).

## Phase 8c-4a - the front-door bug and the static-host guides (done)

### Bug found and fixed

- `serverSocketUrl` (page) adds the socket path `/ws` to the configured server address. Caddy's `/config.json` in the VPS stack said `{"server":{"url":"/ws"}}`, so the page opened `ws://host/ws/ws`; Caddy forwards only `/ws`, so the socket never reached the server and online play fell back to the relay without a message (the room code still appears). The 8c-3 checks passed because each part was right on its own: `check_stack.sh` even grepped for `"/ws"`, and the Caddy test used a raw WebSocket client at `/ws`. The same wrong value was in `docs/DEPLOYMENT.md` (the `config.json` example) and in `docs/DOCKER.md`.
- Fix: the value is `"/"` (the page's own address). Changed in `deploy/Caddyfile`, `tests/harness/check_stack.sh`, `tests/harness/check_network_config.py` (harmless there), `docs/DEPLOYMENT.md` (with a note that the page adds `/ws`) and `docs/DOCKER.md`.
- Seen failing before it was fixed: `tests/server/deploy-front-door.test.ts` reads the Caddyfile, merges the `config.json` it serves into the default settings, runs `serverSocketUrl` on it and requires the resulting path to be one Caddy forwards; it failed with `/ws/ws` and passes now. `tests/harness/check_front_door.py` runs real Caddy 2.11.7 on the Caddyfile, the built server and the built page, has Chromium make a room through it, and requires exactly one socket, at `ws://<site>/ws` (with the old value the socket was `/ws/ws`). `deploy-files` in CI runs it.

### Static hosts

- `.github/workflows/pages.yml`: checkout 7, setup-node 7 with `.nvmrc`, `npm ci`, `npm run build` with the four `TETRIZZ_` settings read from repository **variables**, `upload-pages-artifact` 5, `deploy-pages` 5 (versions looked up on 18 Nov 2026: both Pages actions are on v5, whose runtime is Node 24). `configure-pages` is not used (nothing in a Vite build needs it). Runs on push to `main` and by hand; it does not run the tests (documented).
- `vercel.json`: no framework, `npm ci`, `npm run build`, output `apps/web/dist`, the same three security headers as the Caddyfile, immutable caching for `/assets/*`. Vercel's documentation (18 Nov 2026) lists Node 26.x as the default and reads `engines.node` before the project setting; `.nvmrc` is not read.
- `deploy/cloudflare/_headers`: the same headers, copied next to the built page by the build command (`npm run build && cp deploy/cloudflare/_headers apps/web/dist/_headers`), so it is optional and the stray file does not end up in the other builds. Cloudflare Pages' build image (v3) defaults to Node 22.16.0 but reads `.nvmrc` (26 here); it does not read `engines` and does not accept `lts/*`.
- Sub-path: the built site was served under `/TetriZZ/` and opened in Chromium (a stand-in for a GitHub Pages project site): title and menu render, the service worker scope is `/TetriZZ/`, no request fails except the expected 404 for the missing `config.json`.
- `check_deploy.py` gained a "static hosts" part (always runs, needs only PyYAML): `vercel.json` build command and output folder match the root script and Vite's output, installs with `npm ci`; `_headers` parses and only `/assets` is immutable; the three files send the same security headers as the Caddyfile; `pages.yml` pins every action to a major version, takes Node from `.nvmrc`, publishes the same folder, has the permissions and environment GitHub Pages needs, and passes every `TETRIZZ_` setting listed in `.env.example`. Its no-Docker fallback for port strings with `${...}` was wrong (four false failures); fixed.

### Description text (done after the 8c-4a zip, in the 8c-4b chat)

- `apps/web/index.html` (`description` and `og:description`) and `apps/web/public/manifest.json` now say "a fast, competitive Tetris game" instead of "a modern guideline Tetris". The wording is a placeholder the owner can change; `legacy/manifest.json` and the legacy page were left as the v1.2.0 reference. Prettier clean, build output checked, 494 tests pass (2 skipped).

### Checked

- 494 unit and server tests pass (2 skipped as before; 2 new), `format:check` clean, ESLint 0 errors (76 warnings as before), typecheck clean, `check_network_config.py` passes, `check_deploy.py` passes with Caddy installed (Docker, promtool, Loki, Alloy and shellcheck not installed here, so those parts are skipped).

### Not checked

- The three host files have not run on the real hosts: the GitHub Pages workflow, Vercel's reading of `vercel.json` (including the header patterns) and Cloudflare's `_headers` (including whether its `Cache-Control` replaces the platform default for `/assets/*`). The first push to a real repository is their test.
- Docker was still not run here, so the CI result of `deploy-stack` is still the first real run of the images.
- GitHub Pages' ten-minute cache is the platform's documented default and was not measured.

## Phase 8c-3 - the VPS stack (done; Docker itself not run here)

### What exists

- `Dockerfile`: stages `manifests` > `deps-all` / `deps-prod` > `build-server` / `build-web`, and two targets. `server`: `node:26.13.1-trixie-slim`, production dependencies only (28 MB of `node_modules`), the bundled `dist`, `tools/`, runs as `node`, health check with `node -e fetch(...)` against `/healthz` (no curl in the image). `web`: `caddy:2.11.7-alpine` with `deploy/Caddyfile` and the built page in `/srv`, health check on Caddy's admin endpoint.
- `compose.yaml`: `init` (one-shot: makes `./data/...` and gives `data/sqlite` to the `node` user), `server` (read-only root, `/tmp` as a 16 MB tmpfs, all capabilities dropped, `no-new-privileges`, 256 MB, heap capped at 192 MB, SQLite in `./data/sqlite`, optional `server.env`), `caddy` (80, 443 tcp and udp; starts after the server is healthy). `compose.postgres.yaml`: `postgres:18.7-alpine3.24`, data in `./data/postgres` (mounted at `/var/lib/postgresql`, the PostgreSQL 18 layout), health check, the server switched to `DB_DRIVER=postgres` and waiting for it. `compose.monitoring.yaml`: `init-monitoring`, Prometheus v3.13.5 (the LTS line), Grafana 13.3.1, Loki 3.7.9, Alloy v1.21.2, node exporter v1.12.1; `METRICS=on` on the server; only Grafana publishes a port, on 127.0.0.1.
- `deploy/Caddyfile`: `/ws`, `/api/v1/*`, `/healthz`, `/readyz` to the server with the Host header kept; `/metrics` answered 404 by Caddy; `/config.json` answered by Caddy itself with the same-origin socket (so one page build runs anywhere); no-cache for the page, `sw.js` and manifest, immutable for `/assets`, a day for icons; no access log; security headers. `deploy/env.example` lists every setting of the stack.
- `deploy/prometheus` (scrape config, 15 alert rules in two groups, unit tests), `deploy/loki`, `deploy/alloy` (discovers the project's containers through the Docker socket, labels them `service`, replaces IPv4 addresses with `<ip>` before storing), `deploy/grafana` (provisioned datasources with fixed uids, a dashboard provider, three dashboards of 12, 17 and 16 panels).
- `apps/server/tools/sqlite-backup.mjs`: snapshot of the live database with `VACUUM INTO`, then an integrity check and a check that it is a TetriZZ database; also `--check FILE`.
- `scripts/backup.sh` (SQLite snapshot or `pg_dump -Fc`, verified, 7 daily and 4 weekly copies, optional `rclone copy` off-site, lock against overlap, exit code 2 for a failed upload only), `restore.sh` (checks the file first, asks for RESTORE, stops the server, keeps the old SQLite file or dumps the PostgreSQL database first, single-transaction restore, starts the server and waits until it is healthy), `healthcheck.sh` (containers, `/healthz` through Caddy, disk), `lib.sh`.
- Checks: `tests/server/deploy-scripts.test.ts` (9), `tests/server/deploy-monitoring.test.ts` (14), `tests/harness/check_deploy.py`, `tests/harness/check_stack.sh`, and two CI jobs (`deploy-files`, `deploy-stack` for lite, postgres and monitoring). `docs/DOCKER.md` explains the stack; `docs/SERVER.md`, `CHANGELOG.md`, `.gitignore` updated.

### Decisions made here (easy to change)

- **Versions** were looked up live on 17 Nov 2026: Node 26.13.1 is the current LTS (26.x became LTS in October; released 11 Nov), Caddy 2.11.7, PostgreSQL 18.7 (19 was still a release candidate on Docker Hub, so not used), Prometheus 3.13.5 (the LTS line; 3.15 is the newest but not LTS), Grafana 13.3.1, Loki 3.7.9, Alloy 1.21.2 (Promtail is not used), node exporter 1.12.1. The Docker Hub pages are cached snapshots from different days, so a newer patch release may exist; the release files of Caddy, promtool, Loki and Alloy at exactly those versions were downloaded and run here, the Docker tags were not pulled.
- **Debian slim, not Alpine, for the server image**: glibc, no surprises with `node:sqlite` or `pg`. Caddy and PostgreSQL use their Alpine images.
- **Bind mounts under `./data`, with one-shot `init` jobs**, because a bind mount Docker creates itself belongs to root and the services do not run as root. PostgreSQL needs none (its entrypoint takes its own folder).
- **`.env` for the stack, `server.env` for the server.** A server setting that is empty counts as unset (checked in `config.ts`), so nothing breaks when a variable is passed empty.
- **No `docker compose up --wait`**: it is not certain to accept one-shot services that exit 0, so the scripts poll health themselves (`wait_ready`).
- **The snapshot is made in the data folder, not `/tmp`**: the container's `/tmp` is a small tmpfs and counts against its memory.
- **Log shipping through the Docker socket** (Alloy). It is the one choice that works with the least code and it is also the one that trusts a container with the machine; documented in `docs/DOCKER.md`, with how to leave it out.
- **Prometheus renames the server's `job` label to `exported_job`** (its own `job` wins). Rules and dashboards use `exported_job`; a test checks that every label and label value they use exists in the real `/metrics`.
- **Off-site copies are `rclone copy`, never `sync`**: a wrong remote path then cannot delete anything.

### Checked

- Docker Compose 5.7.1 (`config`) renders lite, postgres, monitoring and all three together; a missing `POSTGRES_PASSWORD` or `GRAFANA_ADMIN_PASSWORD` stops it. A first version had a YAML error in the PostgreSQL file (a colon inside the error message); found and fixed that way.
- Caddy 2.11.7 validates the Caddyfile for `:80` and for a host name, and `caddy fmt` finds nothing to change. It ran in front of the built server and page: `/` and `/sw.js` no-cache, `/assets/*` immutable, icons a day, `/config.json` no-store, `/healthz` and `/readyz` through, `/metrics` 404 through Caddy (and refused directly when a forwarded-for header is present), a WebSocket from the site's own origin accepted, one from another origin 403. The first version had the cache rules wrong (assets and icons came back as no-cache because the catch-all header won); found by this run and fixed with a negative matcher.
- promtool 3.13.5: configuration valid, 15 rules found, unit tests pass (they first failed on a bad test series for the stalled-maintenance alert; fixed). Loki 3.7.9 `-verify-config` passes. Alloy 1.21.2 `validate` passes and fails with exit code 1 on a deliberately broken file.
- The Dockerfile's stages were replayed without Docker in a clean copy holding only the files it copies: production install, server build, page build, the runtime layout started and its health check command exits 0, the snapshot tool run as `backup.sh` runs it leaves nothing behind.
- shellcheck 0.11.0 is clean on all scripts. The nine script tests pass; breaking the scripts on purpose (no rotation, server never stopped, no check before the swap) made exactly the matching test fail each time. The monitoring tests catch a misspelt metric in a rule or a dashboard, and `check_deploy.py` catches an unpinned image or a published database port.

### Not done / open

- **`docker build` and `docker compose up` were not run** (no Docker daemon in the sandbox). The `deploy-stack` CI job does it for three variants; it has not run yet. Specifically unproven: the `wget`/`curl` health checks inside the Grafana, Loki and Prometheus images, Alloy reading the Docker socket and the `service` label, the node exporter mounts, PostgreSQL with all capabilities dropped but five, Caddy with only `NET_BIND_SERVICE`, Grafana 13 loading the dashboards (they are classic JSON, schema 39, written by a script; no Grafana was available to open them), and the memory ceilings (sums, not measured).
- **(Closed in 8c-4c: Alertmanager.)** Prometheus alerts were evaluated and shown but delivered nowhere. Options: Alertmanager (Telegram, Discord and email receivers; needs its secrets as files because it does not read the environment) or Grafana-managed alerting (contact points and rules provisioned from files). The server's own notifier covers what it can see from inside; "server down" and "disk full" are the gap. `scripts/healthcheck.sh` with an uptime ping covers "is it up" meanwhile. Decision for the owner.
- Grafana reading PostgreSQL directly for business dashboards (PLAN.md 11.3) needs a read-only database user and a provisioned datasource; not done. The dashboards use the server's `/metrics`, which already carries today's players, sessions, games by mode and errors.
- The room list endpoint, the deploy guides per host, and everything on the page's side of telemetry remain, as before.

## Phase 8c-2b - `/metrics`, the janitor and the notifier (done)

### What exists

- `apps/server/src/metrics.ts`: `createMetrics(sources, info)` builds one registry per server (the standard process and Node metrics under their usual names, plus `tetrizz_*`). The counters the server already keeps (`stats()`, `apiStats()`, the janitor's status, the notifier's counters) are read at scrape time, so no hot path changed; the only value recorded as it happens is `tetrizz_ping_seconds`, the heartbeat round trip (the server stamps each ping and measures the pong). `mayReadMetrics` is the one place that decides who may read; `registerMetricsRoute` answers refusals with the same 404 as an unknown route. The full list of metric names is in `docs/SERVER.md`.
- `apps/server/src/janitor.ts`: `createJanitor` with `runLive` (today every `JANITOR_LIVE_SECONDS`; the first pass after midnight also closes the previous day), `runSettle` (every `JANITOR_SETTLE_MINUTES`: roll up the last `JANITOR_LOOKBACK_DAYS` days, purge, compact, count rows, check the budget; the first settle after a start rolls up 14 days), `rollup(day)` (queued with the jobs), `effectiveRetention()`, `status()`. One job at a time; a job already waiting is not queued twice; a failure is counted, logged and reported and the next run tries again. `start()` waits 10 s after listening.
- `apps/server/src/notifier.ts`: delivery only. Telegram `sendMessage` and a Discord webhook (`allowed_mentions` empty), 8 s timeout, one retry on a network error, 429 or 5xx, messages in order, a cooldown per kind (30 min by default; a minute for start and digest; one per job for janitor failures), held-back messages counted in the next one, text cut to what each service takes, credentials in addresses removed, and only the channel and the status or error name logged (the bot token is part of Telegram's address).
- `apps/server/src/alerts.ts`: the rules: a start message, the daily digest (rolls up yesterday through the janitor first), database errors, janitor failures, 80 % and 100 % of the budget, event-loop delay (`monitorEventLoopDelay`, 99th percentile every 10 s, twice in a row), an error burst (`NOTIFY_ERROR_SPIKE` unexpected errors in the window; counted by Fastify's `onError` hook and by database errors).
- `config.ts`: `metrics`, `janitor` and `notify` groups and the new variables (`METRICS`, `METRICS_TOKEN`, `JANITOR*`, `SERVER_NAME`, `TELEGRAM_*`, `DISCORD_WEBHOOK_URL`, `NOTIFY_*`). A wrong value stops the start and the message names it without repeating a secret.
- `app.ts`: builds the notifier, janitor, metrics and alerts; `ServerApp` now exposes `janitor`, `alerts`, `notifier`, `metrics`; `ServerDeps` gains `fetch` and `sleep` for tests. Timers start in `listen()`, not in `createServerApp`. A stop now stops the alert timers, lets a running janitor job finish before the database is closed, and waits for messages in flight. The old limiter sweep timer was renamed `sweeper` (it was called `janitor`).
- `docs/SERVER.md`, `apps/server/.env.example` and `CHANGELOG.md` describe all of it.

### Decisions made here (easy to change)

- **`@prometheus-io/client` 0.16.1, not `prom-client`.** The previous note named prom-client 15.1.3 as the latest. Installing it printed a deprecation notice: the project was renamed and moved under the Prometheus organisation (0.16.0 on 24 Aug 2026, 0.16.1 on 27 Aug; the API is the same; Node ^22, ^24 or >=26). Looked up live on 16 Nov 2026. In 0.16.1 a gauge without labels exists at 0 from the start and `reset()` brings it back, so the metrics helper removes such a series first and sets it only when there is a value (no budget, no database or no run yet reads as absent, not 0). A test covers it.
- **`/metrics` is off by default** and, when on, answers a bearer token or a request without proxy headers. Not a separate port: a second listener would mean a second set of settings for little gain, and the compose files keep the address private anyway. A server on the internet with `METRICS=on` and `TRUST_PROXY` unset behind a proxy that does not send `X-Forwarded-For` would answer everyone; use a token there (the guide will say so).
- **Game numbers in `/metrics` come from the rollups**, refreshed by the janitor, never from a query per scrape. Modes beyond the twelve most played today are summed as `other`, because the page may send any short lowercase mode name and a metric label must not grow without limit.
- **Retention cuts halve every retention per step** (events 30, 15, 7, 3, 1; games and sessions 180, 90, 45 ...), at most six times, never below a day; lifted one step at a time under 70 %. On PostgreSQL the file does not shrink without `VACUUM FULL`, so a cut can stay in force there (documented; watch `tetrizz_retention_cut_level`).
- **Raw rows are only purged from days that were rolled up**, as before. A day outside the 14-day catch-up and 3-day lookback that was never rolled up keeps its raw rows (it costs disk, loses no data).
- **Digest timing without storing state:** a start after the digest hour does not repeat that day's digest, and a server that was down at the digest hour skips that day. Storing the last digest day in the database would fix that and needs a migration; not done.
- **The alert rules live in `alerts.ts`, delivery in `notifier.ts`**, so Alertmanager-style rules can later move to Grafana without touching the sender.

### Checked

- `tsc` for every workspace, ESLint (0 errors; the 76 warnings were there before), Prettier, `vitest` 469 passed and 2 skipped (the PostgreSQL contract tests when no `TEST_POSTGRES_URL` is set; as before).
- The built `dist/index.js` run as a real process with `DB_DRIVER=sqlite METRICS=on`: `/healthz` 200, `/metrics` shows `tetrizz_info`, `db_up 1`, the janitor's runs and the table row counts, a request with `X-Forwarded-For` gets 404, a bad `METRICS`/`TELEGRAM_*` value stops the start with a message that names each problem, and SIGTERM ends the process in about 50 ms, also after the janitor timers have started.
- Not run here: the browser harness (`npm run verify`, `check_server_real.py`): the page and the room model were not touched. Not run: Telegram and Discord against the real services (the sandbox cannot reach them; delivery is tested with a recording `fetch`), PostgreSQL (no server here; the janitor only uses repository methods the contract tests cover on both), and a real Prometheus scrape.

### Not done / open

- Reconnects (seats resumed) are not a metric: the reference model does not count them.
- The page still sends nothing; the player-id question is closed (see "Player identity" below).
- Each metric name and the digest text are untested against a real Grafana; the dashboards come in 8c-3.

## Phase 8c-2a - the database inside the server and `/api/v1` (done)

### What exists

- `packages/protocol/src/telemetry.ts` (no imports): the batch format (`TelemetryBatch`: `v`, `playerId`, `sentAt`, optional `device` and `session`, lists of `events`, `games`, `history`), `TelemetryAck`, the limits (256 KB body, 200 events, 20 games, 50 history lines, 2 KB per payload) and `parseTelemetryBatch`. A request that is not shaped right is an error; a single item that does not fit is left out and counted (`rejected`), so one bad event cannot make a page retry for ever. Ids are `[A-Za-z0-9_-]{8,64}`, kinds `[a-z][a-z0-9_]{0,39}`, times 2000 to 2100. The page will import the same parser.
- `apps/server/src/config.ts`: `database` (`off`, `sqlite` with a path, `postgres` with `DATABASE_URL`, optional `DB_SCHEMA`, `DB_POOL_MAX`), `retention` (events 30, games 180, sessions 180 days), `dbMaxMb`, `telemetry` limits. Read now; the retention and budget are acted on in 8c-2b.
- `apps/server/src/telemetry.ts`: `ingestBatch`, `correctTime`, `clockSkew`, `deviceFromUserAgent` (bowser 2.15.0, published 26 Oct 2026), `mergeDevice`. No HTTP in it.
- `apps/server/src/api.ts`: `registerApi(fastify, deps)` returns `{ stats, sweep }`. Everything is under the prefix `/api/v1` in one encapsulated plugin: origin check and CORS in an `onRequest` hook, `OPTIONS` preflight, a `text/plain` body parser (JSON text; what `sendBeacon` sends without a preflight), its own error and not-found handlers (plain `{ ok: false, error }`, no detail), a per-address request bucket (30 a minute, burst 10) and a per-address bucket for ids the server has not seen (60 an hour, burst 20). `ApiStats` has the counters `/metrics` will export.
- `apps/server/src/app.ts`: `createServerApp` opens the repository from the settings (or takes `deps.repository`, which the caller then closes), registers the API only when there is one, sweeps its limiters with the existing janitor timer, closes an own repository after `fastify.close()`, and exposes `repository`, `apiStats()`; `deps.clock` and `deps.onDbError` are new. `/readyz` adds `"database": "ok" | "down"` when there is a database and stays 200 (rooms do not need it); without a database it is unchanged.
- `apps/server/src/index.ts`: a failed start prints only the error's message (a database address holds a password); the start line says the driver and, for SQLite, the path.
- `db/sqlite.ts` now gets `DatabaseSync` with `process.getBuiltinModule("node:sqlite")` inside `openSqlite`, so `node:sqlite` (which prints an experimental warning on Node 22) is loaded only when SQLite is chosen. Verified: the built server with `DB_DRIVER=off` prints no warning.

### Decisions made here (easy to change)

- **`DB_DRIVER` defaults to `off`.** Rooms-only servers keep working exactly as before and create no files; the compose files of 8c-3 will set `sqlite`. PLAN.md names only `sqlite|postgres`.
- **Only the sender's own row of a game is stored.** Rows for other ids are rejected, so nobody can write results under another player's id. Consequence: a match of four humans is four games if every page reports it (each with its own game id), or one game with one row if they share a game id (the first report wins, the others are duplicates). The rollups count game rows. Pick the page's rule when the page side is built; if one shared game with all human rows is wanted, the repository needs a "add my row to this game" write.
- **Time correction.** `moved = at + (receivedAt - sentAt)`, never later than the arrival time; older than the retention is `stale` and dropped (events, games), sessions and history use a 400-day limit. An item that arrives more than 5 minutes after it happened, or that the page marks, is stored as `offline`.
- **An opted-out player is not followed:** their batches are answered `optedOut` before anything is written (no `last_seen` update, no device). The opt-out `PUT` creates the player row if it is missing (the flag lives on it); that row holds the id and two times only. After a `DELETE` the opt-out flag is gone with the row, so a page that erases itself must send the opt-out again if telemetry is off.
- **No zod, no `@fastify/cors`:** the parser is a page of plain code in the protocol package and CORS is five headers (`@fastify/cors` 11.4.3 was published three days before this work).
- **`/metrics` and the ingest share no code yet;** `ApiStats` is the seam.
- Dedupe of a retried item works by id alone; the corrected time of a retry differs from the first by the network delay, which no row depends on.

### First CI run (the 8c-4a zip pushed to a test repo; read in the 8c-4b chat)

- `check` and `deploy-files` passed. `deploy-files` includes the front door with real Caddy, the built server and the built page: the page opened its socket at `/ws`, a room was made, no page errors.
- `deploy-stack` (lite, postgres, monitoring) failed within a second: `tests/harness/check_stack.sh: Permission denied`. The executable bit is lost when a zip is unpacked or committed from Windows. Fixed by calling it through `bash` (workflow, the script's own calls to `scripts/*.sh`, the cron lines in `docs/DOCKER.md`). **On the owner's machine also run** `git update-index --chmod=+x scripts/*.sh tests/harness/check_stack.sh` after `git add`, so a checkout on the VPS keeps them executable.
- `regression` failed at `check_relay_room.py`: "guest lists the host" after a fixed 2.5 s wait, then a click on a button that was not there yet. The same check passes here, so it was timing on a slower runner. Fixed: that check now polls for what it expects (`wait_until` in `lib.py`, up to 20 s) and prints what the guest saw on failure, and every fixed wait in the relay checks is multiplied by `HARNESS_SLOWDOWN` (2 in the `regression` job). Steps after it (leave, join errors, backend pick, UI smoke, single-file checks) did not run; the leave check passes here at a slowdown of 2.
- Pages workflow: `build` passed, `deploy` failed with 404 "Ensure GitHub Pages has been enabled": not a code fault. In the repo: Settings, Pages, Source: GitHub Actions. Not needed for the test repo.

### Player identity (the open security point of 8c-2a, closed in the 8c-4b chat)

The point: a player id was both the identifier and the only key, and ids are public (every roster lists them). A `hello` with another player's id replaced that player's connection, `join` took a held seat back without a password, so any member of a room could take another member's seat, the host's included; and anyone who knew an id could `DELETE` that player's data or switch their telemetry off.

Decided by the owner ("production level, no breach"): fixed before the page ships telemetry. The design differs from the first idea (a key hash remembered per id), because that needs a table, can be pre-empted (someone who learns an id from a public relay room could bind it to their own key first and lock the real player out) and needs a migration. Instead the id is derived from the key, so an id can only be presented by whoever holds its key and the server remembers nothing:

- `packages/protocol/src/identity.ts`: `isPlayerKey`, `playerIdFromKey` (first 32 hex of SHA-256 of `tetrizz-player-id-v1:` + key), `keyMatchesId`, and a plain synchronous SHA-256 (the page needs the id at boot; checked against Node's `crypto` for every length around the block borders).
- `hello` gains `key`; the room model refuses a hello whose key does not derive to its id with `refused`/`identity` and ends the connection (new `ServerRefusal` value). A hello with no key parses and is refused the same way, so old pages are told why.
- `/api/v1`: `parseTelemetryBatch` returns the batch's `key` beside the batch (never inside it); `POST /telemetry` checks it (403 `identity`, 400 when missing), `PUT`/`DELETE` check `Authorization: Bearer <key>`; CORS now allows the `Authorization` header; `ApiStats.identityRefused` and `tetrizz_api_refused_total{reason="identity"}`. The key is never stored or logged (test).
- Page: `net/identity.ts` makes the key (`crypto.getRandomValues`, 32 bytes) at boot and keeps it in the tab's and the browser's storage as `tetris_pkey`; `myPlayerId` is derived from it for every backend (relay, Supabase, LAN and server), so the id format is now 32 hex characters; the old random `tetris_pid` is removed. The key reaches only `server-socket.ts` (a `key()` dependency read at each connection) and is never in a room message. If the server answers `identity` the socket reports `"identity"`, the room backend answers `failed` (not "unreachable", so it does not slip silently to another backend) and the page logs a warning. If there is no cryptographic randomness the page still plays on the relay and LAN with a throwaway id and the own server refuses it.
- `boot/34-online-sync.ts` no longer adopts the id of the last room (it was always this tab's own id; now it cannot differ from the key's).
- **For the page's telemetry client (next):** send `key` in every batch, `Authorization: Bearer <key>` on `PUT`/`DELETE`; take the key from `playerKey()` in `net/identity.ts`. **Keep `tetris_pkey` out of the settings export and out of any bug report** (the export does not exist yet; `STORAGE_KEYS` lists the key for the typed storage layer only).
- Two tabs of one browser share one key and so one id, as they shared the old id; a page that needs its own player (the browser checks do) sets `sessionStorage.tetris_pkey` before it starts (`tests/harness/lib.py`: `player_key`, `player_id`).
- Not covered: a key taken out of the browser; rooms on the relay, Supabase and the LAN, where nothing checks ids; plain `ws://` and `http://`, where the key is readable on the wire.

Checked: 514 unit and server tests pass (2 skipped; 20 new: SHA-256, derivation, page identity, model refusals, takeover attempt, real-server refusal, API 403/400, key never stored, client `identity` result, metric). Browser checks that ran here and pass: `check_server_room.py` (the fake server now verifies each hello's key; new A2b), `check_relay_handshake.py`, `check_relay_join_errors.py`, `check_relay_leave.py`, `check_relay_room.py`, `check_backend_pick.py`. **Not run:** `check_server_real.py` and `check_front_door.py`: in this sandbox `check_server_real.py` fails at A1 on the untouched 8c-4a zip too (the page's socket never reaches the proxy), and Caddy is not installed; run both on a machine that has them.

### Checks

- 36 new tests, 430 pass (394 before), 2 skipped (PostgreSQL contract). `tests/unit/server-telemetry.test.ts` (18): the parser (shape, limits, bad items counted, payload size, device fields, sessions, games, ids), clock correction (page behind, page ahead, never future, too old, retry), device description (the S8+ user agent reads as mobile Android 8.0, Chrome 126, Blink), the database settings and that a wrong address is never echoed. `tests/server/api.test.ts` (18, real server on a real port, raw HTTP, in-memory SQLite, fixed clock): everything stored and readable back, the same batch twice, a phone two hours behind, offline and stale events, only the sender's game row, `text/plain` bodies, 400/413/415/404, opt-out and opt-in, deletion (and the same answer twice), origin and CORS and preflight, the single-file origin, both limiters, a database failure (503, error reported, server up), `/readyz` with the database down, no database, and a server that opens and closes its own database.
- Twelve deliberate breaks, each caught by the tests meant for it: clock skew ignored, opt-out ignored, other players' rows kept, stale events kept, offline lag ignored, origin check off, request limit off, delete doing nothing, text/plain parser gone, new-player limit off, database error not reported, CORS header missing.
- Typecheck, Prettier and lint (0 errors, 76 warnings as before) pass. `npm run build -w @tetrizz/server` gives one 86 KB `dist/index.js`; `bowser`, `pg` and Fastify stay external, `node:sqlite` is read at run time. The built server ran on Node 22.23.4 with `DB_DRIVER=off` (`/api/v1` is 404, no warning, `/readyz` unchanged) and with SQLite in a file (a batch stored, `/readyz` says `database: ok`, a clean SIGTERM, no client address in the log).

### Not checked

- PostgreSQL with the ingest path: the API tests use SQLite only (the repository's own contract tests cover both); the ingest does about eight small writes per batch, none of them in one transaction (each repository call is its own), which is fine for idempotent items but was not measured under load.
- No Caddy in front (`TRUST_PROXY`, the Host header and `X-Forwarded-For` for the limiters), no real browser (CORS preflight from another origin was checked with raw requests only), no real phone.
- Volume: nothing measured beyond a few rows. `touchPlayer` is called twice and `recordDevice` once per batch, even when nothing changed.
- Node 26: the sandbox has Node 22; the lockfile was extended by `bowser` only.

## Phase 8c-1 - the database layer (done)

The first part of Phase 8c: the code that stores things, built and tested on its own. It lives in `apps/server/src/db/` and nothing in the server imports it yet (as with 7d-1, the shipped behaviour is unchanged). `apps/server/package.json` gains `pg` 8.23.1 and `@types/pg` 8.23.1.

### What exists

- `types.ts`: the `Repository` interface and every input and output type. Times are epoch milliseconds, a day is a UTC `YYYY-MM-DD`, flags are 0/1 in both databases so both take the same parameters.
- `repository.ts`: every query, written once in SQL that both databases accept (`?` placeholders, `ON CONFLICT`, `CAST`). `executor.ts` is the small driver interface (read, write, transaction, migration lock); `sqlite.ts` and `postgres.ts` implement it. The PostgreSQL driver rewrites `?` to `$1, $2, ...` and returns 64-bit integers as numbers.
- `migrate.ts` and `migrations/{sqlite,postgres}/0001_init.sql`: numbered migrations bundled into the server at build time (`import.meta.glob` with `?raw`), recorded in `schema_migrations` with a sha256 checksum. The runner refuses to start when the database holds a migration this build does not know (made by a newer server) or when an applied migration was edited. Each migration runs in one transaction. PostgreSQL migrates under an advisory lock, so two servers starting together migrate once.
- `index.ts`: `openRepository({ driver: "sqlite", path } | { driver: "postgres", url, schema?, poolMax?, onError? })` connects, migrates and returns the repository. `pg` is loaded with a dynamic import only for the PostgreSQL driver.
- Tables: `players`, `player_devices` (one row per coarse device description, keyed by a hash of it), `sessions`, `games`, `game_players` (humans only; bots are a count on the game), `events` (raw), `player_history` (append-only), `daily_stats` (long form: day, metric, dim, value; for example `games` / `mode:sprint`), `player_daily`, `rollup_days` (which days have been rolled up), `schema_migrations`.
- Repository behaviour: `touchPlayer` moves `first_seen` back and `last_seen` forward only; `recordDevice`, `startSession`, `recordGame`, `insertEvents` and `addHistory` are idempotent by an id the page makes up (a game and its players are stored in one transaction; a refused part undoes the whole game; `insertEvents` returns how many were new); `endSession` keeps the latest end; `rollupDay(day)` recomputes one UTC day (`games`, `play_ms`, `sessions`, `players_active`, `players_new`, `errors`, games by mode and by device class, and per player: games, play time, lines, best score) and can run again at any time; `purge` deletes events, games and sessions older than a cutoff in batches, but only from days that `rollup_days` says were rolled up; `deletePlayer` removes everything about one player (a game that no other human played is deleted too; anonymous rollups stay); `counts`, `sizeBytes`, `compact` (SQLite: incremental vacuum and a WAL checkpoint; PostgreSQL: nothing) and `ping` are for the metrics and the janitor.
- SQLite setup: a new file gets `auto_vacuum = INCREMENTAL` before the first table, then WAL, `synchronous = NORMAL`, `busy_timeout = 5000`, foreign keys on. One connection; statements and transactions are queued one after another, and every transaction starts with `BEGIN IMMEDIATE`. Tables are `STRICT`.

### Versions (looked up live on 16 Nov 2026)

- `pg` 8.23.1 and `@types/pg` 8.23.1 (npm, published 30 Sep and 4 Oct). `prom-client` 15.1.3 for 8c-2.
- SQLite driver: Node's `node:sqlite` (SQLite 3.54.1 inside Node 26.13.1). The alternative, `better-sqlite3` 13.2.0, was published on 14 Nov 2026 (two days before) and needs a prebuilt native binary per Node version; the repository does not depend on the choice, because the driver is behind `Executor`. Node's documentation I read (the 25.8 and 27 pages) marks `node:sqlite` "Stability: 1.2 - Release candidate"; I did not read the Node 26 page itself. On Node 22 it prints an `ExperimentalWarning` at start.
- PostgreSQL: the current major is 18 (18.7 released 12 Nov 2026, a security release that closes 52 vulnerabilities); 19 had its second release candidate on the same day with general availability planned for 19 Nov. CI uses the image `postgres:18`.

### Decisions made here (easy to change)

- **No table partitions for `events` (PLAN.md section 11 asks for them in PostgreSQL).** A unique key on a partitioned table must contain the partition column, and a page that retries an upload must not create a second copy of an event; the client's retry cannot be relied on to carry the same timestamp once the server clamps clock skew. So `events` is one table with `id` as primary key and an index on `occurred_at`, and retention is a batched delete. If deleting becomes too slow at some volume, partitioning can be added with a new migration.
- **No `rooms` / `room_players` tables.** Rooms stay in memory (PLAN.md calls them ephemeral). Nothing needs them in the database yet.
- **No foreign key from `events.session_id` or `games.session_id` to `sessions`.** Offline uploads can arrive before the event that starts the session.
- **`purge` only deletes from rolled-up days.** `rollup_days` is written by `rollupDay`. The janitor (8c-2) must roll up each day, and roll it up again when late offline events arrive, before retention reaches it; a day that was never rolled up is never purged, so a broken janitor costs disk and not data.
- **The device fingerprint includes the browser version**, so a browser update adds a device row (and shows when a player's browser changed). It leaves out the app version, which sessions already carry.
- **Query time never comes from a clock inside the repository**; callers pass times, and `openRepository` takes an optional `now` (used for `rolled_at` and `applied_at`).

### Found while building

- SQLite deadlock: the first version of the SQLite migration lock queued itself behind the very statements it was protecting; every test timed out. The lock is a plain call there (one connection; each migration is its own `BEGIN IMMEDIATE` transaction).
- PostgreSQL race: two servers starting at the same time on a fresh schema both ran `CREATE SCHEMA IF NOT EXISTS` and one failed with a duplicate key error in `pg_namespace`. Schema creation now takes the same advisory lock. A test starts two servers together.
- A hand-written test teardown closed a repository twice; the test file now closes only what it opened.

### Checks

- `tests/server/db-contract.test.ts` (19 tests per database, run on SQLite in memory, SQLite in a file and, when `TEST_POSTGRES_URL` is set, PostgreSQL, each test in its own schema, plus two PostgreSQL-only tests): schema and version, reopening, `touchPlayer`, opt-out, devices, sessions, games (including that a refused part undoes the whole game), events (dedupe, payload round trip, offline flag, new-only count), history, rollups of a fixture with known answers (three games, three players, two days), rolling up again, late data, a bad day, purge only from rolled-up days, purge keeping newer rows, purge in batches of 2, delete by player, counts and size, 60 concurrent writes, two servers starting together, a schema name that tries to break out of its quotes.
- `tests/unit/db-migrate.test.ts` (16 tests): migration parsing and ordering, statement splitting, apply and re-apply, upgrade, edited migration refused, newer database refused, a failing migration undone, the two dialects having the same versions, tables and columns, the SQLite pragmas, transactions queued and rolled back, placeholder numbering, day helpers.
- Eight deliberate breaks, each caught by exactly the tests meant for it: purge ignoring `rollup_days`, events without the duplicate check, `recordGame` without its transaction, `last_seen` allowed to move back, a rollup that keeps the old day's rows, `deletePlayer` removing games other players played, SQLite statements not queued, migration checksums not checked.
- Full suite: 415 tests pass with PostgreSQL (340 before + 75 new); without `TEST_POSTGRES_URL` 394 pass and 2 are skipped. Typecheck, Prettier and lint (0 errors, 76 warnings as before) pass.
- The server was built with a temporary entry that opens both databases: the SQL files are inside the bundle, `pg` and `node:sqlite` stay external, and it ran on Node 26.13.1 and on Node 22.23.4 against SQLite and PostgreSQL. The temporary files were removed; the shipped `dist/index.js` is unchanged because nothing imports the database yet.
- CI: the `check` job has a `postgres:18` service and `TEST_POSTGRES_URL`, so the contract tests run on PostgreSQL there.

### Not checked

- PostgreSQL ran as 16.15 (Ubuntu's package) in the sandbox, not 18. CI has not run (no GitHub here) and there is no Docker in the sandbox, so I did not check that the `postgres:18` image tag exists; the first push is the real test of both.
- No load or volume test: nothing measured beyond a few thousand rows. SQLite is synchronous, so a long write blocks the event loop for its duration (batches are small, but it is not measured under real traffic). `counts()` uses `COUNT(*)`, which is slow on a very large `events` table in PostgreSQL; `/metrics` should cache it or the janitor should keep it.
- Not built yet: SQLite backup (`VACUUM INTO` is the plan), the size budget (`DB_MAX_MB`), the janitor, settings in `config.ts`, anything that calls the repository.
- Dashboards: no query was written for Grafana, and the indexes are only the ones the repository's own queries need.
- Postgres connection loss while running is only passed to `onError`; reconnection behaviour of the pool was not tested.

### Notes for 8c-2

- `openRepository` options map directly to settings: `DB_DRIVER=sqlite|postgres`, `SQLITE_PATH`, `DATABASE_URL`, optionally a schema name and pool size.
- `rollupDay` for yesterday after midnight UTC, plus today every few minutes for the live numbers, plus the last few days again for late offline uploads; then `purge`; then `compact` (SQLite).
- Ingest should clamp `occurredAt` using the upload's `sentAt` and keep the id the page made, so a retry stores nothing new; `receivedAt` is the server's clock.
- `telemetryOptOut` is stored, but the repository does not act on it; the API decides what to drop.

## Phase 8b - the real own server (done)

`apps/server` is a Node program that runs the room rules of `packages/protocol` on real WebSockets. `docs/SERVER.md` is the operator's page; this section is what was decided and checked.

### What exists

- `src/app.ts`: Fastify 5 plus `@fastify/websocket`. `GET /healthz`, `GET /readyz` (503 while stopping) and the socket at `SERVER_SOCKET_PATH`. Each connection is handed to `createReferenceServer().connect(send, onClosed)`; incoming text goes to `link.receive`, a closed socket to `link.close`. The model is given the real `later` (unref'd timers), `graceMs`, `maxRooms` and scrypt `passwords`. No room rule is written in the server.
- `src/origin.ts`: the origin allowlist, checked before the upgrade (plain HTTP 403): listed origins, the page's own host (Origin host = Host header), `null` (the single-file build from disk) and a missing header only when switched on.
- `src/limits.ts`: token buckets, a connection gate (total, per address, per minute) and a flood guard. IPv6 addresses are limited by their /64. Addresses are map keys only; nothing writes them, and request logging is off (`LogController`).
- `src/passwords.ts`: `scrypt$N$r$p$salt$hash`, N 16384, r 8, p 1 (27 ms measured here), `timingSafeEqual`, parameters read from the stored value and range-checked.
- `src/config.ts`: environment variables, validated; every wrong value is listed and stops the start. `TRUST_PROXY` takes a count or addresses, never `true`.
- `src/index.ts`: starts, logs one line of settings, stops on SIGTERM/SIGINT (close code 1001 to every page, exit 0).
- Build: `vite build` (SSR) to one file, `apps/server/dist/index.js`; `@tetrizz/protocol` is bundled, Fastify and the WebSocket plugin stay external. Dependencies: `fastify` 5.12.8, `@fastify/websocket` 11.3.7 (brings `ws` 8.23.0), `@types/ws` 8.18.2 (dev). Looked up live on 15 Nov 2026; Node 26.13.1 is the current LTS build (26.13.0 LTS since 28 Oct).

### Decisions made here (easy to change)

- No `zod`: the protocol package already has the message parsers, and the settings are a few numbers.
- The password budget lives in the app, not the model: a create, join or settings message carrying a password costs one token of the address's budget (burst 20, 60 a minute). Out of tokens, create and join get `refused busy`. The model is unchanged. Reason: scrypt is synchronous.
- Close codes: 1000 for what the model ends, 1001 stopping, 1003 binary, 1008 flooding, 1009 frame too big (ws), 1013 capacity.
- The server does not serve the page; `docs/DEPLOYMENT.md` now says the page and `config.json` come from a static host.
- `ws` 8.23.0 was published on 12 Nov, together with new patch releases of the 7, 6 and 5 lines, three days before this work. I found advisories fixed in 8.20.1 and 8.21.0 (memory and denial of service) but nothing about 8.23.0, so I did not read what it fixes. The lockfile resolves to it.

### Found while building

- The flood counter counted every message still in the receive buffer after the server had decided to close (196 for one connection). Fixed with a `closing` flag; the test checks it is 1.
- `apps/web/vite.config.ts`: the service-worker precache step and the single-file rename read a fixed `dist`, so `vite build --outDir` failed. Both follow the resolved output directory now. Default builds are byte-identical (multi-file file list and hashes, and `TetriZZ.html`).

### Checks

- Typecheck, Prettier and lint (0 errors, 76 warnings as before) pass. 340 unit tests (291 before): 25 new pure tests (settings, origin, scrypt, limiters) and 24 in `tests/server/server-app.test.ts`, which runs the server on a real port with `ws` clients: rooms and relay, passwords never sent out, host change and removal of the password, host leaves, kick, seat hold with real timers (away, same seat back, host back as host, expiry hands the room on), origin (refused 403, allowed, null, missing), per-address and total caps, connects per minute, bad version, bad JSON, 64 KB frame, binary frame, flood, ordinary play not dropped, password budget, heartbeat, hello timeout, slow reader, shutdown. Seven deliberate breaks of `app.ts` (origin check, password budget, heartbeat cut, slow-reader cut, hello cut, gate release, shutdown code) were each caught by exactly the test meant for it.
- New `tests/harness/check_server_real.py <dist> [server index.js]` (36 checks, about 2.5 min, real time): the page is built with `TETRIZZ_SERVER_URL=http://127.0.0.1:18790` (the usage is in the file), the built server runs with a 3 s hold and the static site as its only allowed origin, and a TCP proxy sits between them. The proxy reads the player id from each page's `hello` frame, so it can cut or refuse one player's connections. Groups: A create, join, READY, START MATCH and three seconds of match; B password room; C host leaves; D kick; E a page from another origin gets 403 and still makes a room on the relay; F a guest cut in the lobby gets the same seat back; G password change and removal; H a cut host returns as host, and after the real hold timer the guest is host and the host returns as a guest; I the server unreachable past the hold, the failure panel, RETRY; J clean SIGTERM, no request lines or addresses in the log, statistics (one refused origin, no heartbeat or flood cut, no dropped messages). All pass. Two things in the check were my own mistakes and are fixed: the first proxy cut everyone (both seats expired and the room closed, which is correct), and a stale server from a crashed run answered on the port (the script now refuses to start if the port answers and always stops its server).

### Not checked

- No reverse proxy (Caddy) in front, so `TRUST_PROXY` and the Host header with a proxy are untested; no TLS; no real phone or second machine.
- Not run in the browser against the real server: a role swap on a server, the host leaving or the socket dropping during a match, the lobby's fallback when the server answers `exists` or `busy`, the single-file build from `file://` with `ALLOW_FILE_ORIGIN`.
- The slow-reader test relies on the operating system's socket buffers filling; it passed every run here (Linux loopback).
- The regression harness (solo, versus, screenshots) was not re-run: no page code changed and the default builds are byte-identical.
- Load: nothing measured beyond a few clients. The limits' defaults are reasoned from the page's own send rates (a state message every 100 ms at most, a ping and heartbeat every 3 s), not from a load test.
- Two tabs of one browser with the same player id: the model replaces the older connection (close 1000), and a page that was replaced reconnects and replaces the other; not seen in a browser.

### Notes for Phase 8c

- Rooms, players and counters are memory-only. The counters in `stats()` (accepted, refused by reason, messages in and dropped, closes by reason) are what `/metrics` can export.
- `ServerDeps.now` and `passwords` are the injection points for tests; `later` and `rooms` are internal.
- The list in `docs/SERVER.md` ("Not here yet") is what remains of PLAN.md sections 11 to 13.

## Phase 8a - password change and seat hold for the own server (done)

The two decisions left open after 7d-2 were taken by the owner: both are wanted. They are server rules, so they went into the protocol and the reference model first, then the page.

### Rules (the reference model in `packages/protocol/src/server-room.ts` is the written form)

- **Password change.** The host's `settings` message may carry `password`. Absent means unchanged, an empty string removes the password, anything else (up to 16 characters) replaces it. Only the host's message counts. The password never travels inside `settings` (the part players are told): they see only the rules, and the page's own `pwdH` display flag. A player who already has a seat in the room (also a held one) is never asked for the password again; everyone else is checked against the new one. `createReferenceServer({ passwords })` is the hook for how the password is stored: plain text in the model, a salted scrypt hash in the real server (not built yet).
- **Seat hold.** When a connection ends (socket closed, or replaced by a new connection with the same player id) while it has a seat, the seat is kept for `graceMs` (default `SERVER_SEAT_GRACE_MS`, 30 s; 0 removes it at once as before). The seat keeps its role, ready flag, join time and, for the host, the host role. The roster marks it `state.away = true` (the server owns that flag: a page cannot set or clear it). `ev` messages for a held seat are dropped, not stored. The player takes the seat back by sending `join` for the same room with the same player id (no password asked); the reply says `isHost` as it stands. The hold ends (the seat is removed, the roster pushed, the host role passes on if it was the host's) when the grace period runs out, when the player leaves on purpose, when the host kicks the seat, or when the same player id creates or joins another room. A held seat is never chosen as the next host; if the host's seat ends and nobody present can take over, the room is closed.
- `welcome` carries `grace` (seconds) so that the page knows how long to keep trying. `SERVER_SEAT_GRACE_MS` is also exported.

### Page changes

- `RoomBackend.setPassword?` (optional, only the own server has it); the server backend sends `settings` with the `password`. `changeOnlinePwd` uses it in server mode; CHANGE PASSWORD is shown to the host of a server room again. `roomPwdH()` (next to `pwdHashOf`) keeps the `pwdH` flag in the host's rule pushes after a reconnect, when the plain password is no longer known to the page.
- `ServerSocket.graceMs()` returns what the last `welcome` said (default 30 s).
- `keepRejoiningServerRoom(room)` (`net/online-lobby.ts`): while the page is reconnecting to a server room it tries `join` again at 1, 2, then every 3 seconds, for the server's grace period plus 5 s, and then shows RECONNECT FAILED with RETRY. It does not try Supabase or the relay (a server room exists only on the server, and a code collision elsewhere would put the player in a stranger's room). The 12 s watchdog is not used for it. A refusal that is final (not found, password needed, version) is shown as before. It is used by the socket's close handler (`boot/35-replay.ts`), by `attemptRejoin` for a saved last room of mode `server` (page reload within the grace period gets the seat back, the player id is kept in tab and local storage), and by RETRY (`retryReconnect`, which before had nothing to retry with after an in-session drop).
- Lobby: a seat with `away` gets the orange pulsing "Reconnecting…" dot that the existing presence code already used (`conn: "lost"`), and an away player counts as not ready when the host presses START MATCH.

### Checks

- Typecheck, Prettier, lint (0 errors, 76 warnings as before) and both builds pass. 291 unit tests (273 before): `server-protocol.test.ts` grows by 18 (password change: set, change, remove, kept when the rules change, host only, never shown to players, held seats not asked, storage hooks; seat hold: away flag, take back with role/ready/join time, expiry, host role held and handed on at expiry, returning host is host again, away seats never take the room over, room closed when nobody present remains, half-open connection replaced, password change while away, `away` not settable by a page, kick of a held seat, leaving for another room, spectators held; message parsing). A deliberate break of the hold, of the password change and of the held-seat password skip each made tests fail.
- `tests/harness/check_server_room.py` is now 49 checks (about 110 s): the Python `FakeServer` follows the new rules (hold, `away`, password change, `grace` in `welcome`, `expire_held()` to end a hold on demand, `down` to leave `hello` unanswered). New groups: **G** (CHANGE PASSWORD visible to the host only, the new password goes beside the rules and not inside them, the guest sees the dots and never the password, new player asked, wrong refused, new accepted, removal shows NONE and lets anyone in), **H** (a dropped host shows as reconnecting and stays host, returns to the same seat as host; after expiry the guest is host and the late player comes back as a new non-host seat), **I** (server unreachable: still RECONNECTING after 14 s, the seat is back once it answers; past grace plus margin the failure panel shows and RETRY gets the seat back). A deliberate break (button hidden again, watchdog not cleared) made G1 and I1 fail.

### Not checked

- No real server and no real WebSocket: as in 7d-2 the fake in Python stands in, and it is a copy of the model's rules that can drift. Hold timers in the fake are ended by the check, not by a clock; the model's timers run in unit tests with a fake clock.
- Not run in a browser: a drop in the middle of a match (the page's existing heartbeat code pauses the dropped player's board after 15 s and marks the player gone after 90 s; the seat hold of 30 s is shorter than 90 s, so a player who returns after the hold ends is a new seat, and what the rest of the match does then is the old behaviour); a returning spectator's view; a host who rejoins while a match is running; two tabs with the same player id.
- The page learns the grace period from `welcome`; before the first connection it uses the default.
- Heartbeats, rate limits, the origin allowlist and the `file://` origin: still Phase 8b (as listed in 7d-1).

### Left for Phase 8b

- The real server (`apps/server`) should run `createReferenceServer` itself (sockets, scrypt through `passwords`, real timers through `later`) rather than a second copy of the rules, so that the model and the server cannot drift; then heartbeats (ping, drop silent sockets), limits, the origin allowlist, logging, `/healthz`, and the rest of PLAN.md section 11.
- Tell the server's operator about `graceMs` (an environment variable).

## Phase 7d-2 - the page uses the own server (done)

The page can now create and join rooms on the own server. Nothing changes for a build with no server address: the server is tried only when `TETRIZZ_SERVER_URL` or a `config.json` names one.

### What changed

- `net/transport.ts`: `serverSocket()` builds the page's one `ServerSocket` on first use (browser `WebSocket`, `serverSocketUrl(netConfig.current.server.url, location.origin)` read at connect time, `APP_VERSION`); the server Transport is the fourth adapter; `NetMode` gains `"server"`; `transportKindFor`, `activeTransport` and `transportOfKind` know it (`AdapterKind` is the new type for the four kinds). `net/room-backend.ts` builds the fourth backend the same way.
- `net/backend-choice.ts`: `ROOM_KIND.server = "server"` and `RoomKind` gains `"server"`. The Options pick and the order under AUTO follow: with a server configured, AUTO tries it first, then Supabase, then the relay; a pick of one backend puts it first.
- `online-lobby.ts`: `enterCreatedServerRoom` and `enterJoinedServerRoom` (the latter sends `rejoin-req` when the page is reconnecting); `createOnlineRoom` and `joinRoomOn` take the `server` kind (the typed password goes to the server like the relay); `applyServerRoster` (new) takes the server's roster as the truth for seats, host and ready flags, and applies a change of host the page has not heard about; `toggleReady` already saved through the backend, `resetOnlineReady` and `swapRole` save the page's seat state (`saveMyState`) for the server; `updateOnlinePlayerList` just redraws; `applyHostXferLocal` leaves `MQ` and `relayPushRoster` alone for the server; the CHANGE PWD button is hidden in server rooms (see decisions).
- `relay.ts` `onNetRoster`: in server mode the roster is applied on the host's page too (the relay's host ignores incoming rosters).
- `net-handlers.ts`: the server kind has its own table, the relay's plus `lobby-ok` and `game-active` ending a reconnect (the server has no message of its own for coming back, so a reconnecting page is let in by the host's `lobby-ok` or anyone's `game-active`, as over Supabase).
- `online-session.ts`: the in-game connection watch shows RECONNECTING... when the server socket is not open. `boot/34-online-sync.ts`: the host's rule changes go out as `settings` in server mode. `boot/35-replay.ts`: when the socket ends while the player is in a server room (and is not leaving), the reconnect panel is shown and the page joins again through the normal join path, as a new seat (the model removes a dropped player's seat at once).
- Fix in the 7d-1 code: `createServerTransport().close()` stopped listening to the socket for good. The socket is one object reused for every room, so after leaving a room the page would never have heard the next one. The listener now lives as long as the page.
- No change was needed in `online-sync.ts` (its check is for Supabase only) or in the sweep in `boot/30-online-session.ts` (relay only; a dead server socket is handled by the close handler above). The saved last room stores `mode: "server"`, and the existing auto-rejoin path joins it again through `joinOnlineRoom`.

### Checks

- Typecheck, Prettier and both builds pass; lint 0 errors, 76 warnings (as before). 273 unit tests (272 before; the backend-pick tests changed because the server is no longer skipped: AUTO with a server is `server, supabase, relay`, the picker offers `auto, server, supabase, mqtt`, and a pick of `server` with none configured is ignored).
- New `tests/harness/check_server_room.py <dist>` (26 checks, about 40 s, real time): the build is served with a `config.json` naming a server on its own origin, and `FakeServer` (Python, following `server.ts` and the model) answers the page's socket through `route_web_socket`. A: create, join, READY (state frame and the host's list), START MATCH, both pages send match state; B: password room (create carries the password, join without it gets the prompt, a wrong one is refused, the right one gets in); C: the host leaves and the guest becomes host; D: the host kicks the guest; E: no server answering means the room is made on the relay; F: the connection is dropped in the lobby, the reconnect panel shows and the page joins again. Each page has its own browser context (pages of one context share `localStorage`, and a page that starts with a saved room tries to rejoin it).
- Regression harness on the new build, multi-file: fixtures, solo traces (endless, ultra, sprint, wide) and the 4-player match trace identical, 76 screenshots (worst 0.0004%); single file: 4-player match trace identical and `check_ui_smoke.py` passes. `check_backend_pick.py`, `check_relay_room.py`, `check_relay_join_errors.py`, `check_relay_handshake.py`, `check_relay_leave.py` and `check_network_config.py` pass on the multi-file build.

### Not checked

- No real server and no real WebSocket in a browser: the fake answers through Playwright. `FakeServer` is a copy of the model's rules in Python and can drift from it.
- Not run in a browser: a role swap (PLAYER/SPECTATOR) on a server, the host leaving or a socket dropping during a match, the lobby's fallback when the server answers `exists` or `busy` on create, and the single-file build from `file://` (its origin is `null`, so a server address that is only a path, like `/`, cannot work there; a full URL can).
- The sandbox has Node 22 while `.nvmrc` says 26; dependencies came from the lockfile, no version was picked.
- Playwright for Python 1.63.0: a page that closes a mocked socket without a code makes `WebSocketRoute` raise `KeyError: 'code'`, and `ws.close()` inside the route handler never returns. The check patches the first and avoids the second (the unreachable-server case uses no mock: the page's socket meets the static file server, which cannot upgrade it).

### Decisions for Phase 8 (taken in Phase 8a: both wanted, see above)

- Changing the room password after it is created: the protocol has no message for it (the server keeps the password given in `create`), so the CHANGE PWD button is hidden in server rooms. To allow it, add an optional `password` to the client's `settings` message, handle it in the model and the server, and show the button again.
- Reconnecting a dropped page: unchanged from 7d-1 (the seat goes at once, the page joins again as a new seat). A grace period that holds the seat and the host role for a few seconds is a server rule and needs a line in the model.
- Heartbeats, rate limits, the origin allowlist and the `file://` origin: as listed in 7d-1.

## Phase 7d-1 - own-server wire protocol, reference room model, client adapter (done)

The own server does not exist yet (Phase 8), so this step fixes what it will say and builds the page's side against a model of it. Nothing in the app imports the new client modules, so the shipped game is unchanged; the only edit to existing app code is that `createOnlineRoom` passes the typed password on the create request (the relay and Supabase ignore it).

### The protocol (`packages/protocol/src/server.ts`, the source of truth)

- One WebSocket at `<server address>/ws` (`SERVER_SOCKET_PATH`), one JSON object per text frame with a `t` field. Frames over 64 KB (`SERVER_MAX_FRAME_BYTES`) are invalid. The page speaks first.
- Page to server: `hello` (protocol version, app version, player id, the key it derives from, name), `create` and `join` (each with a request id `rid`; `create` carries the room's rules and the typed password, `join` the typed password), `ev` (a game event for everyone else), `settings` (the host's rules, kept for players who arrive later), `state` (this seat's `role`, `ready`, `joined`), `host` (hand the room to a player), `kick`, `leave`.
- Server to page: `welcome` (or `refused` with reason `version`, then the connection is closed), `created`, `joined` (room, host, whether the caller is host, seed, the room's rules), `refused` (`not-found`, `password`, `wrong-password`, `version`, `exists`, `full`, `busy`, `invalid`), `ev` (with the sender's id), `roster` (host and seats, host first, then by arrival), `host` (new host), `kicked`, `closed`.
- `parseClientMessage` and `parseServerMessage` return a typed message or null; they check only the fields the receiver relies on, never inside an event's payload. Limits are constants (name 16, room code 12, password 16).
- The version helpers (`PROTOCOL_VERSION`, `checkPeerVersion` and the rest) moved from `index.ts` to `version.ts` so that the new files can import them without a cycle; the package exports are unchanged. `TransportKind` gained `"server"` (it uses the relay's event list). `CreateRoomRequest` gained an optional `password`.

### The reference model (`packages/protocol/src/server-room.ts`)

`createReferenceServer({ now, newSeed, maxRooms })` returns `connect(send, onClosed)`, `roomCount()` and `seatsOf(code)`. It is the written-down behaviour the real server must show and the test double for the client: the first frame must be a valid `hello` of a compatible version; a second connection with the same player id replaces the first; room codes are upper-cased; `create` refuses an existing code (`exists`), a page already in a room (`busy`) and a full server (`busy`); `join` checks the password on the server (`password` when none was typed, `wrong-password` when it did not match; a returning seat skips the check); the first four seats are players and later arrivals spectators; `ev` goes to everyone but the sender, and from a page in no room it goes nowhere; `settings` only from the host, kept (with the room's seed) for later joiners and forwarded as the `settings` event; `state` merges into the seat and cannot give a spectator a seat at a full table; `host` and `kick` only from the host and only to a seated player other than themselves; when the host leaves or drops, the first seated non-spectator takes over (`host` then `roster`), and when only spectators remain the room is closed (`closed`) and deleted, as it is when it empties. Every change pushes a `roster`. The model compares passwords as plain text; the real server stores a salted hash (scrypt, per PLAN.md section 11).

### The client side (`apps/web/src/net/`)

- `server-socket.ts`: `createServerSocket({ url, createSocket, later, appVersion, warn })` with `connect(identity)` (settles `ok`, `version` or `unreachable`; 5 s to be welcomed), `request(create|join)` (answers matched by `rid`, 8 s timeout, a `lost` result instead of a rejection), `send`, `onMessage`, `onClose` (only for a connection that was established), `isOpen`, `close`. `serverSocketUrl(configured, origin)` turns an http(s), ws(s) or same-origin path address into the socket address.
- `transports/server-transport.ts`: kind `server`. `send` writes `ev`, except the host's `settings`, which go as `settings`. Incoming `ev` becomes the same event name; the server's own messages become the events the relay's host would have sent: `roster` (`{ players, host }`), `host` -> `host-xfer` (`{ newHost, from: "" }`), `kicked` -> `kick` (`{ target: <my id> }`), `closed` -> `closed`.
- `backends/server-room.ts`: kind `server`. `create` and `join` connect, send the request and map the answer: `joined` -> `ok`; `not-found`, `password`, `wrong-password` (-> `password` with `wrongPassword`), `version` as themselves; any other refusal -> `failed`; no connection -> `unreachable` for join and `failed` for create; a server of another protocol -> `version` on join. `leave` sends `left` when announcing, then `leave`, then closes the transport 150 ms later (`SERVER_LEAVE_DELAY_MS`); `drop` closes it; `setHost`, `saveMyState` and `kick` send their messages.

### Checks

- 41 new unit tests (272 in total): `tests/unit/server-protocol.test.ts` (24: message parsing, and every rule of the reference model above) and `tests/unit/server-client.test.ts` (17: the socket address, the socket against the model, version refusal, no-answer timeouts, close handling, the transport's event mapping, the backend end to end with two pages: create, join, every refusal, leave, drop, host change, kick, saved state, no server, newer protocol).
- Typecheck, Prettier and both builds pass; lint 0 errors, 76 warnings (as before).
- Regression harness: multi-file build: fixtures, solo traces (endless, ultra, sprint, wide), 4-player match trace and 76 screenshots (worst 0.0004%) pass; single file: 4-player match trace passes. `check_backend_pick.py`, `check_relay_room.py`, `check_relay_join_errors.py`, `check_relay_handshake.py`, `check_relay_leave.py` and `check_network_config.py` pass on the multi-file build (they take the `dist` directory), `check_ui_smoke.py` on the single file.

### Not checked

- No real WebSocket: the socket is tested against the model through a fake with the same callbacks (frames and close arrive in order, on a microtask). A browser check against a Playwright-hosted server comes with 7d-2, and the real server in Phase 8.
- The page cannot reach any of this yet, so lobby behaviour, reconnects and the SERVER pick are untested by design.

### Decisions to make or confirm in 7d-2 and Phase 8

- Reconnecting a dropped page: the model removes a dropped player's seat at once. The page's existing auto-rejoin (`beginReconnectUI`, `joinOnlineRoom`) would join again as a new seat. If a short grace period for a returning player is wanted, it is a server rule (hold the seat and the host role for a few seconds) and needs a line in the model.
- Heartbeats: the browser answers WebSocket ping frames itself, so the page sends no keep-alive; the server should ping and drop silent sockets.
- Rate limits, origin allowlist and the `file://` origin of the single-file build are Phase 8.

### Left for 7d-2 (done in 7d-2)

- Build the socket (browser `WebSocket`, `serverSocketUrl(netConfig.current.server.url, location.origin)`, `appVersion` from `core/version`), transport and backend lazily, as the others are; `transportKindFor` and `transportOfKind` learn `"server"`, and `dispatchNetMessage` gives the server kind the relay table (it already falls through to it).
- `netMode` gets a value for the server (`"server"`) and these places need to know it: `enterCreatedServerRoom` and `enterJoinedServerRoom` in `online-lobby.ts` (like the relay's, plus the roster); `onNetRoster` and `onNetSettings` ignore the host's own page (relay) but the server also sends the host its roster; `toggleReady` and `swapRole` (they use `saveMyState` and, for the relay, `swap-req` and `relayPushRoster`); `updateOnlinePlayerList`; `applyHostXferLocal` (touches `MQ`); `onNetKick`/`forcedLeave`; the in-game connection watch in `boot/34-online-sync.ts` and the sweep in `boot/30-online-session.ts` (both read `MQ` or the Supabase channel); the saved last room (`tetris_lastroom`, `mode`) and its resume path; `online-sync.ts` line 185.
- `socket.onClose` while in a room: show the reconnect panel the other backends use.
- Then `ROOM_KIND.server = "server"`, `RoomKind` gains `"server"`, `tryJoin` passes the typed password for the server like the relay, and the reconnect panel text for a fallback is checked.
- A browser check (`check_server_room.py`): two pages and a fake server hosted with `page.route_web_socket` (or the reference model run in the page), create, join, ready, start, host leaves, kick, wrong password, server unreachable falls back to the next backend. Chromium and Playwright 1.63.0 are in the sandbox under `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH`).

## Phase 7c-3 - Supabase channel module, backend order in the lobby, backend pick in Options (done)

### What changed

- `net/backends/supabase-channel.ts` (new): the three `postgres_changes` handlers and the "ask for a rejoin once subscribed" loop that sat in `setupOnlineChannel`. `createRoomChannelHandlers(deps)` takes the session object, the match state and plain functions (clock, timers, send, leave, refresh and so on) as arguments, like the transports and room backends; `listenToRoomRows(channel, roomId, handlers)` registers the seats (every change), the room update and the room delete, in that order, before the broadcast listeners and `subscribe`. The handler bodies were moved as they were; the only changes are names and the constants (8 s after joining, 800 ms, 10 s, 20 s, 700 ms/1.5 s/8 tries, 2.5 s) that were written inline.
- `online-lobby.ts`: `setupOnlineChannel` went from about 190 lines to about 40 (remove the old channel, build the handlers, attach the broadcast listeners, subscribe). `createOnlineRoom` and `joinOnlineRoom` loop over `roomBackendKinds(netConfig.current, configState.onlineBackend)` instead of trying Supabase and then the relay by hand. Each attempt still makes its own room code and seed. A refusal that says the room exists (`password`, `version`) ends the loop; any other refusal goes on to the next backend, and the last one is shown (`showJoinRefusal`, the old `joinViaRelay` switch, now shared). The Supabase password prompt and the "trying the fallback relay" reconnect panel behave as before.
- `net/backend-choice.ts` (new, pure): `ROOM_KIND` maps `server`, `supabase`, `mqtt` to `null`, `supabase`, `relay`; `roomBackendKinds`, `runnableBackends`, `backendChoices` (empty unless two or more backends can run), `nextBackendChoice`, `effectiveBackendChoice`, `parseBackendChoice`.
- Options: a new group "Online" with a SERVER row (AUTO, then each usable backend, then AUTO again) that appears only when `backendChoices` is not empty, so a build without Supabase shows nothing new. The pick is `configState.onlineBackend`, stored as `tetris_online_backend` (storage allow-list), part of the options snapshot (SAVE/CANCEL like the other options), re-checked when `config.json` has been read. The legacy-options snapshot in the harness hook leaves it out, as it does for `motion` and `adaptive`.

### Differences from the old code (small)

- With the pick on MQTT (or a relay listed first), a room the relay cannot find is also asked of Supabase. Before, the relay was always last.
- If Supabase is the only backend and its client did not load, joining says "Could not reach any server" instead of "Room not found".
- With no usable backend (MQTT brokers turned off and no Supabase) CREATE and JOIN say "Online play is not available here."
- The relay's own library-missing note for a join that ends there is unchanged ("Room not found").

### Checks

- 37 new unit tests (231 in total): `backend-choice.test.ts` (order, pick first with fallbacks, relay left out when no broker, own server skipped, picker hidden/shown, cycling, parsing) and `supabase-channel.test.ts` (kick rules, other players leaving and host takeover, own ready echo for 2.5 s, rejoin and game-active messages, host change and the 800 ms round restart, the host's rules copied without seed/players/password fields, match start only when fresh, room delete, the rejoin request loop, listener order and filters).
- `tests/harness/check_backend_pick.py` (new, in CI): a real page with a small in-memory Supabase client and the fake broker. Options pick hidden/shown, cycle, SAVE stores it, reload shows it; AUTO creates the room row on Supabase and publishes nothing on the relay; the channel listens to seats, room update and room delete; a new seat, a ready flag, a change of host and a deleted room show on the page; the MQTT pick creates the room on the relay with no Supabase row; a failing Supabase insert falls back to the relay; joining an open room, a protected room (wrong then right password) and an unknown room (asked on Supabase, then the relay, ends as not found). It fails when the room-delete handler is broken.
- `check_relay_room.py`, `check_relay_handshake.py`, `check_relay_leave.py`, `check_relay_join_errors.py`, `check_network_config.py` pass; `check_ui_smoke.py` passes on the single file.
- Regression harness, multi-file and single-file builds: fixtures, solo traces, 4-player match trace and 76 screenshots (worst 0.0004%) pass. Typecheck, lint (0 errors, 76 warnings as before) and Prettier pass.

### Not checked

- A real Supabase project (the fake client stands in; the queries are the ones `supabase-room.ts` already made). Hand checklist, two devices with Supabase configured: create and join on AUTO, a protected room, host change by closing the host's tab, a kick, a room expiring; then set the pick to MQTT in Options and confirm the room is made on the relay.
- LAN create and join (unchanged, no WebRTC peers here) and the relay against a real broker.

## Phase 7c-2b - RoomBackend interface for creating and joining (done)

### What changed

- `packages/protocol/src/room.ts`: `RoomBackend` gained `create(request)` and `join(request)`. Both return a promise of a result and never throw. `CreateRoomResult` is `ok` (room, host) or a reason (`unavailable`, `failed`, `manual`). `JoinRoomResult` is `ok` with `JoinedRoom` (room, host, whether this player is host, seed, the room's rules as the host published them) or a reason: `not-found`, `password` (with `pwdH` where the backend can tell, and `wrongPassword` when a typed password was refused), `version`, `unreachable`, `unavailable`, `failed`, `manual`. The in-memory room implements both (password, unknown room) and has `peer()` for a peer that is in no room yet.
- `net/backends/supabase-room.ts`: `create` writes the room row and the host's seat; `join` reads the room row (`not-found`, or `password` when the room has a hash and the caller has not checked it), seats the player (keeps the role and `joined` of a returning player, otherwise player up to `ROOM_PLAYER_LIMIT` = 4, then spectator), and returns the room's rules. The Supabase client interface gained `insert`, `upsert` and a typed `select`; the backend takes a `warn` dependency.
- `net/backends/relay-room.ts`: `create` starts hosting (`relayStartHost`) and answers; `join` is `relayJoin` in `relay.ts`, which now returns a promise. It is settled by the host's `ack` (ok, with the host's rules), a refusal (`password`, `version`, `failed`), the 9 second wait running out (`not-found`), every broker failing (`unreachable`), the MQTT library missing (`unavailable`) or an exception while starting (`failed`). `MQ.joinWaiter` holds the waiting call; a newer join replaces it.
- `net/backends/lan-room.ts`: `create` and `join` answer `manual`. A LAN room is made by hand in the LAN panel (QR codes), so `lanCreateRoom`/`lanJoinRoom` are unchanged and the lobby does not call the backend for LAN.
- `net/online-lobby.ts`: `createOnlineRoom` and `joinOnlineRoom` call `backendOfKind("supabase" | "relay")` and apply the result (session state, `setupOnlineChannel` for Supabase, `showOnlineLobbyUI`); `joinViaRelay` shows each refusal (the notes, the password prompt that asks again and says "Wrong password!", the version alert, the reconnect panel). New helpers `newRoomDraft`, `roomRequestBase`, `askRoomPassword`. `net/room-backend.ts` gained `backendOfKind`.
- `net/relay.ts` no longer imports any screen or note helper for creating or joining (`olNote`, `olBusy`, `askConfirm`, `showGameAlert`, `showReconnectPanel` and the rest are gone from it). `relayCreateRoom` became `relayStartHost(roomId)`; `mqHostStart(roomId)` takes the room id instead of reading it from session state after its first `await`, so the order in which the lobby records the room does not matter. `copyRoomRules` (new, `versus/lobby.ts`) replaces the three copies of the loop that copies a room's rules (Supabase join, relay `ack`, host resume).

### Differences from the old code (small, on purpose)

- Supabase join records the seed, host, rules and mode only after the seat is written. Before, they were applied first, so a failed seat write left them half-applied before the fallback to the relay.
- When the MQTT library cannot be loaded, JOIN ROOM no longer stays on "JOINING ROOM…" (the old code showed a note and left the button busy).
- A second `ack` for the same join is ignored. Before it applied the host's rules again and started a second ping timer.
- An exception while the relay join starts now ends in the "Could not join room" alert instead of an unhandled rejection with no message.
- The Supabase `players upsert failed` and `join error` console warnings now come through the logger (`log.warn`, scope `net/backends/supabase-room.join`).

### Checks

- 13 new unit tests (194 in total): the memory room through its backend (rules and seed returned, unknown room, password then checked); relay create/join wiring; LAN answers `manual`; Supabase against the in-memory client (rows written, refused and thrown writes, no client, player and spectator seats, a returning player keeps role and `joined`, host recognised, password asked for and then checked, unknown room, failed seat write, failed read).
- `tests/harness/check_relay_join_errors.py` (new, in CI): two real pages and the fake broker. Unknown room (note after the wait, button usable), protected room (prompt, wrong password asks again and says so, right password seats the guest), no broker reachable, library missing. On the 7c-2a build the same check passes everything except "library missing: button usable again", which is the fix above.
- `check_relay_room.py`, `check_relay_handshake.py`, `check_relay_leave.py`, `check_network_config.py` pass on this build; `check_ui_smoke.py` passes on the single file (it takes the `.html`, not the directory).
- Regression harness: multi-file build: fixtures, 4-player match trace, solo traces and 76 screenshots (worst 0.0002%) pass; single file: fixtures, match trace and 76 screenshots (worst 0.0004%) pass. Typecheck, lint (0 errors, 76 warnings as before) and Prettier pass.

### Not checked

- Supabase create and join were not run against a Supabase project (none here): they are covered by the unit tests with an in-memory client, typecheck and the code move. Hand checklist, two devices: create, join (second device lands in the lobby with the host's rules and seed), a protected room (prompt, wrong password, right password), a fifth player becomes a spectator, a room code that does not exist falls back to the relay and says "Room not found", reload a tab in a match (auto reconnect goes through `joinOnlineRoom`).
- LAN create and join (unchanged code, no WebRTC peers here).
- Relay against a real broker (only the fake broker ran).

### Left for 7c-3

- `setupOnlineChannel` and the Supabase `postgres_changes` handlers, the backend picker, and room creation/joining for the own-server adapter (7d). `JoinedRoom` and the request types are what the own server will fill.

## Phase 7c-2a - RoomBackend interface for leaving, kicking, host change and ready (done)

7c-2 was split: this part moves everything a room does after it exists; creating and joining (7c-2b) are the larger and more UI-bound half and follow.

### What changed

- `packages/protocol/src/room.ts` (imports only `transport.ts`): `RoomBackend` (`kind`, `transport`, `leave`, `drop`, `setHost`, `saveMyState`, `kick`), the request types, `RoomPlayer`, `nextHostCandidate` (first seated player who is not a spectator and not the leaver) and `createMemoryRoom(hub)`, a room on the in-memory hub that follows the relay's rules (host admits and announces the roster; `left`, `ready`, `kick`, `host-xfer` and `closed` events carry the rest). `leave` may return nothing instead of a promise so that the relay and LAN paths still finish in the same tick, as before.
- `apps/web/src/net/backends/`: `relay-room.ts`, `lan-room.ts`, `supabase-room.ts`. Each takes what it needs as arguments (like the transports) and holds the code that used to sit in `leaveOnlineRoom`, `forcedLeave`, `transferHostTo`, `toggleReady` and the kick button handler: relay (goodbye, `host-transfer` on the broker or `closed`, teardown 150 ms later; kick = roster, dead list, push, drop connection), LAN (`bye` on the open uplink, teardown), Supabase (`left` broadcast, delete own seat, hand the room to the earliest live player or delete an empty room, release the channel; host and state rows). `net/room-backend.ts` builds them on first use; `activeBackend()` picks by `netMode` exactly as `activeTransport()` does.
- `leaveOnlineRoom`, `forcedLeave`, `transferHostTo`, `toggleReady` and the kick handler now call `activeBackend()`. The teardown functions (`relayTeardown`, `mqTeardown`, `lanTeardownAll`) are no longer called from the lobby; they run through `transport.close()`. `onlineFresh` uses the exported `rowIsFresh`.
- `supabase-transport.ts`: `close()` now means "stop sending now, remove the channel 400 ms later", which is what both leave paths did inline (its dependencies changed from `close` to `detach` and `remove`).

### Differences from the old code (small, on purpose)

- Supabase `leave` reads "am I host" when leaving starts; the old code read it again after its awaited database calls. It only differs if a host change arrives within those calls.
- A kick over a LAN no longer sends a delete for a seat that does not exist to the Supabase `players` table (the old code fell into its Supabase branch whenever `netMode` was not `p2p`, so it did that when a Supabase client was loaded). The kicked guest still leaves when it hears `kick`.
- Debug log scopes of the moved code changed to the new file names.

### Checks

- 35 new unit tests (181 in total; `tests/unit/room.test.ts`, `room-backends.test.ts`, one changed in `transport-adapters.test.ts`): `nextHostCandidate`; the memory room (seating order, ready flag, guest leaves, host leaves and hands over, only spectators left closes the room, kick, a guest's kick ignored); the three backends against fakes (relay order of calls and the 150 ms delay, LAN bye only on an open channel, Supabase against a small in-memory client: earliest live player becomes host, stale seats ignored, spectator fallback, empty room deleted, database failure logged and transport still closed, no room or client does nothing); the Supabase transport's delayed close.
- `tests/harness/check_relay_leave.py` (new, in CI): two real pages and the fake broker. Guest leaves (`left` published, host list drops it, host stays host), host leaves with a guest (`left` and `host-transfer` to the guest published, the guest becomes host), host leaves alone (`closed`, no hand-over), host kicks (`kick` published, host list drops the guest, the guest sees the alert and is out). It gives the same results on the 7c-1 build and on this one.
- Regression harness, multi-file build: fixtures, solo traces, 4-player match trace and 76 screenshots (worst 0.0004%) pass. `check_network_config.py`, `check_relay_handshake.py`, `check_relay_room.py`, `check_relay_leave.py` and `check_ui_smoke.py` pass. Typecheck, lint (0 errors) and Prettier pass.

### Not checked

- The LAN and Supabase leave, kick, host-change and ready paths were not run (no WebRTC peers, no Supabase project here); they are covered by the unit tests with fakes, typecheck and the code move. Hand checklist: Supabase two devices (guest leaves, host leaves with a guest and the guest becomes host, host leaves alone and the room row goes, kick, ready shows on the other device, close the tab of a guest); LAN host and guest (guest leaves, kick).

### Left for 7c-2b

- Create and join are still per backend and mixed with lobby UI (`createOnlineRoom`/`joinOnlineRoom` and `setupOnlineChannel` for Supabase, `relayCreateRoom`/`relayJoin`/`relayResumeRoom` and the `mq*` functions, `lanCreateRoom`/`lanJoinRoom`). They need a result type (room id, host id, role, or a refusal reason) so that the lobby shows the notes and the backend does not touch the page, and a memory-room `create`/`join` that matches it.

## Phase 7c-1 - Transport interface for messages (done)

Phase 7c was planned as one step; the message half is finished and checked, the room half (creating, joining, leaving) is 7c-2.

### What changed

- `packages/protocol/src/transport.ts` (imports nothing): `Transport` (`kind`, `isOpen`, `send`, `onMessage`, `close`), `TransportAdapter` (adds `receive`, which a backend's connection code calls when something arrives), `TransportKind` (`lan`, `relay`, `supabase`, `memory`), `createMessageBus`, `createMemoryHub` (a room inside one JavaScript context: sends reach every other open peer in order, never the sender, payloads copied through JSON like a wire, a send made during a delivery is queued behind it), and the lists `SUPABASE_EVENTS` (19) and `RELAY_EVENTS` (22) with `eventsFor(kind)`. `NET_EVENTS` gained `closed` (the host sends it when it closes a room; it was handled but missing from the list), so it has 23 names.
- `apps/web/src/net/transports/`: `lan-transport.ts`, `relay-transport.ts`, `supabase-transport.ts`. Each is a small factory that takes what it needs as arguments (the open channels, the MQTT send functions, the realtime channel), so it is unit-tested without the app. They carry exactly the send logic of the old `netSend` branches (LAN: one JSON line to every open channel and the uplink; relay: direct connections, then the broker topic; Supabase: broadcast on the channel, dropping `hb`/`ping`/`pong` while the channel is not joined). The Supabase adapter's `attach(channel)` adds the broadcast listeners (call before `subscribe`).
- `net/transport.ts` builds the three adapters on first use and owns `netSend` (moved out of `lan.ts`; the eight importing files changed their import), `activeTransport()` (picks by `netMode`: `lan`, `p2p` = relay, anything else = Supabase, as before), `supabaseTransport()` and `receiveEnvelope(mode, d)` (LAN and relay connection code hand incoming messages to it).
- `net/dispatch.ts` (pure): `dispatchTo(table, event, payload)` runs the handler only for the table's own entries; a name such as `constructor` or a non-string is ignored.
- `net/net-handlers.ts`: the two handler tables. They replace `relayDispatch` (`relay.ts`, used for relay and LAN) and the 19 `.on("broadcast")` listeners in `setupOnlineChannel`. Handlers that were written twice (`unleft`, `rejoin-req`, `match-over`, `game-active`) are now one function each.
- Differences between the backends are kept and now visible in `net-handlers.ts`: over Supabase `attack` and `state` also mark a lobby player's room as having a live match; `lobby-ok` exists only there; `game-active` ends an automatic reconnect only there (a parameter); `roster`, `settings`, `host-resume` and `closed` exist only on the relay and LAN.
- `online-session.ts`: four state fields got types (`sb`, `onlineChannel`, `onlineLocalOrder`, `onlineLiveOrder`). `onNetLobbyOk`, `rejoinSucceeded`, `onNetRoster`, `onNetSettings` are exported.

### Checks

- 29 new unit tests (`tests/unit/transport.test.ts`, `transport-adapters.test.ts`): bus and memory hub (order with re-entrant sends, payload copies, closed peers, unserializable payloads dropped), the event lists, each adapter against fake channels (open channels only, failing channel does not stop the others, keep-alive dropping, listeners registered in order and delivering the payload), and the dispatcher (unknown names, `__proto__`, arrays). 146 unit tests pass; typecheck and Prettier pass; lint 0 errors, 76 warnings (as before).
- `tests/harness/check_relay_room.py` (new, in CI): two real pages and the fake broker: create, join, both lists show both players, the guest's READY shows on the host, START puts both pages into an online match, both publish `state`, event names `constructor`/`__proto__`/`toString` sent into the pages do nothing and no page error is raised. It passes on this build and on the Phase 7b build, and fails when the `ready` handler or the `start` handler is taken out of the table (checked), so it does see dispatch breakage.
- Regression harness, multi-file and single-file builds: fixtures, solo traces, 4-player match trace and 76 screenshots (worst 0.0004%) pass. `check_relay_handshake.py`, `check_network_config.py` and `check_ui_smoke.py` pass.

### Not checked

- The LAN and Supabase paths were not run (no WebRTC peers, no Supabase project here): they are covered by the adapter unit tests, typecheck and the code move only. Hand checklist: LAN host and guest join, start, play, leave; Supabase two devices create, join, ready, start, kick, leave; Supabase automatic reconnect by reloading a tab in a match (the `game-active` path changed shape).
- The relay's MQTT code ran only against the fake broker.

### Left for 7c-2

- Room lifecycle is still per backend (`createOnlineRoom`/`joinOnlineRoom`/`setupOnlineChannel` rows and `postgres_changes`, `relayCreateRoom`/`mq*`, `lanCreateRoom`/`lanJoinRoom`). 7c-2 puts create, join, leave, roster, kick, ready and host transfer behind one interface so the memory hub can run a full room in a test, and `leaveOnlineRoom` and the teardown paths call `transport.close()` instead of the three teardown functions (nothing calls `close()` yet). (7c-2a did leave, kick, ready and host change and `close()` is called now; create and join are 7c-2b.)
- Open choice from 7a: bundle supabase-js and mqtt from npm as lazy chunks, or keep the pinned CDN loads (current).

## Phase 7b - protocol package and version on connect (done)

### What changed

- `packages/protocol/src/index.ts` (imports nothing): `PROTOCOL_VERSION` (1), `PROTOCOL_MIN_VERSION` (1), `peerVersion` and `checkPeerVersion` (a missing or malformed version counts as 1, the version of every build before this field), the 22 event names (`NET_EVENTS`), the payloads whose shape is fixed, and a type for each message on the relay topics (`join`, `ack`, `deny`, `ev`, `ping`, `presence`, `host-left`, `host-transfer`, `host-resume`, `bye`) and for the LAN `hello`. `attack` and `state` payloads are still untyped (they are large and `net/` is still `@ts-nocheck`; 7c types them).
- `net/relay.ts`: `join`, both `ack` messages and `net/lan.ts` `hello` carry `v: 1`. The host denies a join that announces a newer version (`reason: "version"`), a guest that gets an `ack` from a newer host gives up, and both show "runs a different version of TetriZZ, reload the page". The deny handling became one function (`mqJoinRefused`) used by both. The LAN host closes the channel of a guest that announces a newer version (there is no deny message on LAN).
- `apps/web` depends on `@tetrizz/protocol`.
- Rule written in the package: the version rises only for a change older builds cannot read; builds with different versions then do not share a room.

### Checks

- 4 new unit tests (`tests/unit/protocol.test.ts`): 117 unit tests pass; typecheck, lint (0 errors) and Prettier pass.
- `tests/harness/check_relay_handshake.py` (new, in CI): two real pages in one browser, a small stand-in for `window.mqtt` that passes publishes between pages. Passes: a guest without a version is seated; a guest with version 1 is seated; a guest announcing version 99 is not seated and sees the alert; a guest refuses a host that answers with version 99; a host without versions seats a current guest. On the build from before 7b the first two pass and the other three fail, so the check does see the change.
- `tests/harness/check_ui_smoke.py` (new, in CI): real keyboard events (move, rotate, hold, hard drop, soft drop, pause), real touch taps on the phone buttons, practice START and BOARD LIBRARY, replay playback from the fixture profile, no page or console errors. It gives the same results on `legacy/TetriZZ.html` and on the new single file (same piece positions and counts).
- Regression harness on the build with 7b: see the Phase 7b report in the chat (fixtures, solo, 4-player match, 76 screenshots, network config).

### Not checked

- The fake broker proves the relay messages and the new check, not a real broker or Supabase. The Supabase backend has no handshake yet; 7c puts one behind the Transport interface.
- LAN version refusal (needs two WebRTC peers).
- Old tabs: a tab running v1.2.0 and one running this build in the same room is covered only through the stand-ins above.

## Phase 7a - network settings out of the source (done)

Started because the repository is going public: the Supabase address and key were written into `online-session.ts`, the Content Security Policy in `index.html`, the service worker and `legacy/`.

### Decisions (from the owner)

- Online backend order: Supabase first; when it is not configured, the public MQTT relay. When the game runs on the owner's VPS, the own server comes first, and the earlier methods (Supabase, relay) stay selectable there too. `backendOrder()` in `core/network-config.ts` implements this (auto: server, Supabase, relay; a pick goes first, the rest stay as fallbacks). The picker in the options screen is not built yet; it comes with 7c.
- Settings come from build environment variables, plus an optional `config.json` next to the page that is read at startup (as PLAN.md said), so one build can run against any server.

### What changed

- `core/network-config.ts` (pure, shared by the build and the app): types, validation, `networkConfigFromEnv`, `mergeNetworkConfig`, `backendOrder`, `connectSources` (Content Security Policy) and `neverCacheHosts` (service worker). An invalid part is dropped whole, never half-kept.
- Build variables `TETRIZZ_SUPABASE_URL`, `TETRIZZ_SUPABASE_KEY`, `TETRIZZ_SERVER_URL`, `TETRIZZ_MQTT_BROKERS` (read by Vite `loadEnv` from the repository root, `.env.local` or the host's variables). Supabase is used only with both of its variables. They are embedded as `__NETWORK_CONFIG__`; `index.html` has the token `__CONNECT_SRC__` that the build replaces, and `sw.js` has `NEVER_CACHE = []` that the build fills. The wildcard `wss://*.supabase.co` is gone: only the configured project's host is allowed.
- `net/net-config.ts`: holds the settings in use; `networkConfigReady()` reads `./config.json` once (http and https pages only, 2.5 s limit, `no-store`) and merges it over the build's settings. `config.json` is excluded from the service worker's cache.
- `initSupabase` waits for that, returns when Supabase is not configured, and only then downloads supabase-js; an unconfigured site no longer loads it. The relay reads its broker list from the settings.
- CDN libraries pinned to exact versions, looked up live on 12 Nov 2026: supabase-js 2.119.0 (file `dist/umd/supabase.js`; the package has no `.min.js`, the old URL relied on jsDelivr minifying on the fly) and mqtt 5.16.1 (`dist/mqtt.min.js`). Both files were confirmed inside the published packages. No integrity hashes yet: jsDelivr could alter the bytes it serves, which cannot be checked from the sandbox.
- `legacy/TetriZZ.html` and `legacy/sw.js`: address and key replaced by `REDACTED` and removed from the policy; the page then takes the same "Supabase not configured" path the harness already sees. Nothing else in `legacy/` changed.
- `.env.example`, `.gitignore` (`.env.*`, local `config.json`), `docs/DEPLOYMENT.md` (settings, what is and is not private, Vercel, Cloudflare Pages, moving a live site, a site served by the own server), README section, CHANGELOG entry.

### Checks

- 26 new unit tests (`tests/unit/network-config.test.ts`); all 113 unit tests pass; typecheck, lint (0 errors, no new warnings) and Prettier pass.
- With no variables set, neither build contains `supabase.co` or a key; with a dummy project set the policy, the service worker list and the bundle carry it; with only the address set Supabase stays off.
- `tests/harness/check_network_config.py` (new, also in CI) in a real browser: nothing configured downloads no library; a valid `config.json` asks for the pinned supabase-js; an invalid one does not; a server-only entry downloads nothing; a changed `config.json` is picked up under the service worker. A single-file build with Supabase baked in asks for the pinned library from `file://` and its policy allows the project.
- Harness: fixtures, solo traces, 4-player match trace and 76 screenshots (worst 0.0003% single file, 0.0004% multi-file) pass.

### Not checked (needs a real host or network)

- Deploying on Vercel and on Cloudflare Pages with the variables, and a Supabase room between two devices, from the real CDN. Check on one host: set the two Supabase variables, deploy, create a room from a phone and join it from a laptop; then remove the variables, redeploy and confirm rooms still work through the relay.
- That the Supabase tables have Row Level Security policies; the repository does not contain them.
- Whether a Node 26 build image exists on either host; the guide asks for 22.13 or newer.

### Left for later in Phase 7

- 7b protocol package (typed messages, `PROTOCOL_VERSION` on connect); 7c Transport interface and the backend picker; 7d own-server adapter. Open choice for 7c: bundle supabase-js and mqtt from npm as lazy chunks (tight policy, works offline once cached, larger single file) or keep the pinned CDN loads.

## Phase 6e - bots and clock while the tab is hidden (done)

Reported after a match with bots at 10 PPS: switching to another browser for a while and coming back, the PPS in the score panel was lower, and the longer the tab had been hidden the lower it was. The bots really were slower while hidden; the panel only looked worse afterwards because PPS is pieces divided by the whole match time (`pieces / timeMs`), so a slow stretch lowers it and it recovers only slowly once the bots are back at full pace.

### What was wrong (all three existed in v1.2.0 or came from Phase 6, none from Phase 6d)

- **One plan per tick.** A hidden page is driven by `startHiddenLoop` (`ui/screens.ts`): a worker timer posts every 100 ms and the page ticks on every third message, so about every 300 ms. Bots plan in workers, and a worker's answer can only be handled between two ticks, so a bot got at most about one plan, and therefore one piece, per tick: about 4 PPS whatever the setting (measured 3.8 to 4.0 for a setting of 10; one bot and three bots alike).
- **Game clock at 0.82x.** A tick covers about 300 ms but one frame was capped at 250 ms (`MAX_FRAME_MS`), so hidden game time ran at 250/300 of real time (measured 0.82). In v1.2.0 the cap was 50 ms, so it ran far slower still. A solo game lost 3 s in 20 s hidden. Ultra countdown, gravity, garbage timers and every bot deadline ran slow with it.
- **Coarse steps.** A 300 ms tick was simulated as 6 steps of 50 ms; a bot does one stage per step (pull, plan, move, drop), so long steps also limit how fast it can play.

### Fix

- `ui/screens.ts`: while `document.hidden`, a tick may cover up to `MAX_HIDDEN_FRAME_MS` = 1000 ms (a late timer is caught up) and is simulated in steps of `HIDDEN_STEP_MS` = 1000/60 ms, the size of a 60 Hz frame. Visible frames are untouched (50 ms steps, 250 ms cap).
- `bot/planning.ts`: `botPlanningOffloaded()` is false while hidden, so new plans (current and speculative) are made on the page thread by the same generators. Plans in flight when the tab is hidden finish on their worker and are picked up on the next tick; after the tab is shown again new plans go to workers as before.
- `bot/bot-control.ts`: while hidden, a bot may plan on every step instead of the first step of a frame, and a plan runs to the end in one go (`mayThinkThisStep`, `thinkBudgetFor`) because nothing is being drawn. Planning time is not added to the frame metrics while hidden (`recordPageThinkTime`), so the debug overlay does not show a spike when the tab comes back.
- Which move a bot plays is unchanged (same planners, same inputs).

### Measured (`tests/harness/check_hidden_tab.py`, real time, sandbox, the page is told it is hidden)

| Build (3 bots asked for 10 PPS, 20 s per phase) | visible                                   | hidden                        | visible again | solo clock after 20 s hidden |
| ----------------------------------------------- | ----------------------------------------- | ----------------------------- | ------------- | ---------------------------- |
| Phase 6d                                        | 9.25 PPS                                  | 3.82 to 3.88 PPS, clock 0.82x | 9.22 to 9.47  | 17 s                         |
| Phase 6e                                        | 8.7 to 9.1 PPS (sandbox noise, see below) | 9.78 to 9.83 PPS, clock 1.00x | 9.38 to 9.68  | 20 s                         |

One bot at 10 PPS: hidden 4.00 PPS at 0.82x before, 9.86 PPS at 0.99x after. The panel after the same hidden stretch showed 6.95 (one bot, 6d) against 9.60 (6e). The visible figures of both builds overlap from run to run in this one-core, software-rendered sandbox (6d 8.98 to 9.37, 6e 8.71 to 9.13 in repeated 12 s runs); the code that runs while visible did not change, and the virtual-clock check `check_bot_pps.py` is the reference for it.

### Not covered

- A real hidden tab. The check overrides `document.hidden` and sends `visibilitychange`, which is what starts the page's own background loop; it does not test what a given browser does to a hidden tab's timers (Chrome may slow or freeze a tab that has been hidden for minutes). The 1000 ms cap and the catch-up are there for a late timer, but a frozen tab cannot play. Test by hand: bots at 10 PPS, leave the tab hidden for a minute, come back, and watch PPS keep climbing instead of falling.
- Online and LAN play while hidden: the background loop still sends state once a second as before; the faster game clock was not tested against remote players.

## Phase 6d - bot pace and lobby fixes (done)

Triggered by the first real-device test (Galaxy S8+ with one bot, laptop with three level-10 bots at 10 PPS, no lag, bots reached about 9.3 PPS, debug overlay on the laptop: 60 fps, median 16.7 ms, p95 18.6 ms, frame work 2.0 ms, page think 0.0 ms, 1,161 plans all by workers with a 10 ms round trip, 3 workers, tier 0).

### Bots reached about 93 % of the PPS they were set to

- **Cause.** A bot drops its piece on the first frame at or after the piece's deadline, and `resetBotTiming` measured the next deadline from that (late) drop. Every drop is up to one frame late, so a 100 ms budget became 7 frames x 16 ms = 112 ms on the harness clock (measured 8.81 PPS, predicted 8.93) and 6 or 7 frames of 16.7 ms on a 60 Hz screen (about 9.3 PPS in the phone and laptop test). At 30 fps the same rule gives 7.5 PPS for a setting of 10. It is not the bot engine and not the workers.
- **Fix.** `packages/bot/src/pacing.ts`: `paceCarry(now, deadline)` is how late a drop was (never negative, at most `MAX_PACE_CARRY_MS` = 60 ms) and `paceDeadline(now, budget, carry)` subtracts it from the next piece's deadline. `botLockPiece` stores the carry on the bot (`paceCarry`), `resetBotTiming` uses it once and also stores the piece's `budgetMs`. Deadlines now sit on a fixed schedule, so the long-run rate equals the setting at any frame rate. The cap stops one long stall (a late plan after garbage, a spin that lingers) from being repaid as a burst of fast drops.
- **Not changed.** Which move a bot plays (the planners, evaluators, skill and hold logic are untouched). The time a bot spends on its rotations and moves (`per` now reads `budgetMs`, which equals the old `deadline - pieceStart`). Spin pieces still wait `SPIN_SHOW_MS`, and a piece that lands before its deadline still locks on the lock delay.
- **Measured** (`tests/harness/check_bot_pps.py`, endless submode, 16 ms frames, game seconds 4 to 20): asked 3 / 5 / 8 / 10 PPS, before 3.00 / 4.81 / 7.69 / 8.81, after 3.00 / 5.00 / 8.00 / 9.94; three bots at 10 PPS 9.94 each; one bot at 10 PPS in battle mode 8.56 before and 10.00 after. The remaining 0.06 at 10 PPS comes from spins and the carry cap.
- **Tests.** `tests/unit/bot-pacing.test.ts` (23 cases): the rule keeps 3 / 5 / 8 / 10 / 11 PPS within 1 % on 16 ms frames, jittered 60 Hz, 30 fps and uneven 7 to 50 ms frames; without the carry 10 PPS stays under 9.1.
- **Golden.** Bot timing changed on purpose, so the 4-player match trace was re-recorded from this build: `tests/golden/vs/vs-4p-bots.json` is new, the old one is kept as `vs-4p-bots.v1.2.0.json` (every earlier phase matched it exactly). Sanity check of the new trace: no page errors, all stations alive after 35 s, bots at 4.94 PPS for a setting of 5 (old 4.74), 78 to 98 lines per bot (old 75 to 89). Solo traces, fixtures and all 76 screenshots are unchanged.

### Lobby: typed bot values were not saved, and LEVEL / BOT PPS did not repeat when held

Both existed in v1.2.0. The bot steppers have `data-bot-step`, which is neither a versus rule (`data-v`), a practice rule (`data-t`) nor an option (`data-s`), so shared code skipped them.

- **Typing a value** (`openValueEditor`, `ui/controls.ts`): it had no bot branch, so the typed number was shown but applied to nothing, the editor started from 0, and its refresh redrew the options screen instead of the lobby. It now reads and writes the bot's `diff` or `pps`, refreshes the lobby and treats `pps` as a decimal (it parsed 6.5 as 6).
- **Holding + or -** (`activateStepButton`, `practice/snapshot.ts`, and the click handler in `ui/screens.ts`): bot buttons never reached the hold-repeat path, and a full redraw of the bot block after each step would have removed the held button after one repeat. `adjustBotStep` and `setBotStepValue` (`versus/lobby.ts`) change the stored value and rewrite only the number on screen, so the button stays and repeats like the other steppers. The bot branch in the click handler is gone; bot buttons use the shared press path (mouse acts on press, touch after 120 ms, click after a press is ignored). Keyboard activation of these buttons now works too (it did nothing before).
- **Check.** `tests/harness/check_bot_lobby.py` (real time): typed values are stored and survive leaving the lobby and a reload, an out-of-range number is refused, one click moves one step, holding + and - repeats, LEVEL stops at 10. It fails 10 of 11 on the v1.2.0 page and passes 11 of 11 on this build.

### Decisions on the two open Phase 6 items

- **Default worker pool policy: stays automatic** (`hardwareConcurrency - 1`, 1 to 3). On the laptop every plan ran in a worker (1,161 plans, 10 ms trip), the page spent 0.0 ms per frame on thinking and the game held 60 fps; the phone ran one bot without lag where v1.2.0 lagged. The phone's overlay numbers were not captured, so the effect of workers alone on the S8+ is not separated from the other Phase 6 changes (faster planner, working layer cache, stepped frames). To separate it, run the same match with `tetris_botworker` set to 0.
- **Skipping redundant redraws: not done.** Frame work is 2.0 ms on the laptop. Reopen only if an S8+ overlay shows frame work or p95 frame time near the 16.7 ms limit.

### Verified in 6d

- Unit tests 87 passed (64 + 23); lint 0 errors (76 warnings, as before); typecheck clean; both builds produced.
- Fixtures PASS, solo traces identical, screenshots 76 shots 0 failing worst 0.0004% on both builds; 4-player trace PASS against the new golden on both builds; `check_bot_pps.py`, `check_bot_worker.py`, `check_perf_overlay.py`, `check_motion_setting.py` and `check_bot_lobby.py` PASS.

## Phase 6 - performance (done)

### What changed

- **`packages/bot`** now holds the bot code that used to sit in `apps/web/src/bot/`: `bitboard.ts`, `ten-wide.ts` (10-wide evaluator), `four-wide.ts` (4-wide evaluator), `planner.ts` (the two planners and `rotSteps`), `mode-mod.ts` (`MODE_MOD`, re-exported by `ui/brand.ts`), `service.ts` (request and answer types, `handlePlanRequest`) and `context.ts`. It imports only `@tetrizz/core`.
- **`botContext`** (`context.ts`) replaces every read of `configState.COLS/ROWS`, `versusLobbyState.vs.submode` and `gameRandom()` inside the evaluators. The page copies the current values into it at the start of each `botStep`; a worker sets them from each request. Boards, queue, hold, skill and chain state travel as plain data in a `PlanConfig`.
- **The two think generators were merged** into `prepareThinkRequest()` in `bot-control.ts`; `botThinkWideGen` is gone. The dead `stream` and `streamPtr` fields were dropped from the planning data (no planner reads them).
- **Worker pool** (`apps/web/src/bot/planning.ts`, `worker-entry.ts`). Pool size: `navigator.hardwareConcurrency - 1`, at least 1 and at most 3. A request is a handle with either a `result` (worker) or a `gen` (stepped on the page with the old time budget). Falls back to the page thread when `Worker` is missing or throws, a worker errors, or a request waits over 3 s (then workers stay off for the session). The worker is bundled as an inlined classic script (`worker.format: "iife"`, `?worker&inline`), so it also starts from `file://` in the single-file build.
- **`tetris_botworker`** (new storage key): `0` plans on the page thread, `1`-`4` sets the pool size, anything else is automatic. The harness sets `0` by default (`tests/harness/lib.py`) because a worker answers in real time and the virtual clock cannot control it.
- **Faster board helpers**: `drop` starts just above the stack instead of above the board, `isValid` and `drop` use flat cell tables, `columnHeight` uses `Math.clz32`. Same answers, planning about 2.6x faster.
- **Stepped frames** (`tzTickBody` in `ui/screens.ts`): a frame longer than 50 ms is simulated as equal steps of at most 50 ms, up to 250 ms of game time per drawn frame (before: one step, capped at 50 ms, so the game ran slow below 20 fps). Frames of 50 ms or less are simulated exactly as before. In stepped frames `vsFrame(dt, present)` refreshes the gauges and scoreboard on the last step only, and bots on the page thread think on the first step only (`botControlState.thinkSlice`).
- Lint: the four unconverted files in `packages/bot` share the relaxed rule block with the web modules.

### Findings (behaviour kept exactly)

- The 4-wide evaluator's height mask is fixed at 23 rows (it was computed once at load from the 10-wide board), so a stack taller than 23 rows on the 26-row wide board is mis-measured. v1.2.0 does the same; the constant `(1 << 23) - 1` in `four-wide.ts` keeps it.

### How it was verified

- `tests/unit/bot-parity.test.ts` replays 320 generated boards (200 ten-wide across four sub-modes, 120 four-wide, stacks up to 26 rows) recorded from the original page by `tests/harness/record_bot_plans.py`; every plan matches. Changing the wide mask makes it fail.
- `tests/unit/bot-bitboard.test.ts` compares the fast `drop`, `isValid` and `columnHeight` with the original implementations on random boards in four board sizes and both evaluator variants.
- In-thread bots: the 4-player match trace is identical to the golden after the move, after merging the think generators and after the speedup; solo traces, fixtures and all 76 screenshots pass on the final build.
- `tests/harness/check_bot_worker.py` plays a real-time match in five conditions (workers answer, no `Worker`, workers never answer, workers fail to start, pool switched off); every bot keeps placing pieces and the page raises no errors in all five.
- Unit tests: 55 passed at the end of phase 6a (64 since 6b). `npm run bench` prints milliseconds per plan: 4.6 (10-wide, all levels), 7.8 (10-wide, level 10), 1.3 (4-wide) on the sandbox CPU.

### What changed in the second half (phase 6b)

- **The board layer cache works now.** `drawFieldTo` (`input/touch.ts`) keeps the settled blocks of each board on an offscreen canvas and only redraws it when the board, size, shape, style, theme or device pixel ratio changes. In v1.2.0 and every phase until now the cache was never stored (`Lmap.set(c)` had no value), so every frame of every board created a new canvas and redrew all blocks: 1,120 canvases in 10 s of a 4-player match, 10 now (counted by patching `document.createElement`). The cache key also includes `getCellEpoch()` (new in `render/render.ts`, bumped by `invalidateCellCache()`), so any change that clears the cell sprites also redraws the layers. `net/online-sync.ts` read the cache's hash through a side door; it now always computes `boardHash()`, which is what it effectively did before.
- **Metrics** (`core/metrics.ts`): a 120-frame ring buffer of frame gaps, frame work and page-thread bot think time, plus counts and the smoothed round trip of worker plans. `frame()` records every frame; hooks in `bot-control.ts` and `planning.ts` feed the bot numbers.
- **Debug overlay** (`ui/perf-overlay.ts`, `styles/26-debug-overlay.css`): hidden by default. Tapping or clicking the version label five times within two seconds shows or hides it (stored in `tetris_debug`, restored on load). It shows fps, median/p95/max frame time, frame work, bot think time per frame, plan counts, pool size and waiting plans, the quality tier, state and pixel ratio.
- **Adaptive quality** (`createAdaptiveController` in `core/metrics.ts`, `adaptiveStep` in `ui/screens.ts`): once a second while a game is `playing`, the median frame time of the last 120 frames decides the tier. Three slow checks in a row (median over 26 ms, and at least 60 frames recorded) raise it, twelve fast ones (under 20 ms) lower it; the frame window is cleared after each change. Tier 1 halves clear particles and stops new background floaters; tier 2 removes clear particles and the board bounce. Tier 0 changes nothing (the particle scale is multiplied by exactly 1). `tetris_adaptive=0` turns it off. There is no Options row for it.
- **Tests:** 9 new unit tests (`tests/unit/metrics.test.ts`, 64 in all) and `tests/harness/check_perf_overlay.py` (overlay toggle and persistence; a throttled match raises the tier, an unthrottled solo game and `tetris_adaptive=0` do not).
- Harness after the changes: fixtures, solo traces, 4-player match trace and 76 screenshots (worst 0.0004%) pass on the multi-file and single-file builds, and `check_bot_worker.py` passes.

### Measured (sandbox: 1 core, software rendering; 4 players, bots asked for 8 PPS, 15 s)

| Build                     | CPU throttle | Median frame | Bot PPS           | Game time per real second |
| ------------------------- | ------------ | ------------ | ----------------- | ------------------------- |
| v1.2.0 baseline           | x1 / x4      | 33 / 100 ms  | 5.2-5.6 / 2.0-2.3 | not measured              |
| Phase 5, planning on page | x1 / x4      | 33 / 83 ms   | 5.9-6.0 / 2.3-2.5 | 0.87 / 0.43               |
| Phase 6, planning on page | x1 / x4      | 17 / 100 ms  | 6.9-7.1 / 2.3-2.7 | 0.94 / 0.96               |
| Phase 6, workers          | x1 / x4      | 17 / 100 ms  | 6.8-6.9 / 4.7-4.9 | 0.95 / 0.96               |

Phase 6b: the sandbox became noisy. Interleaved runs of the Phase 6 build and the 6b build on the same machine, same minute, gave x1 median frames of 33 / 33 / 33 / 17 ms and bot PPS of 5.3-6.5 (6) against 6.3-6.6 (6b), and at x4 2.1-2.9 against 2.3-2.8 PPS, which is within the noise; a first 6b-only run (3.6-3.9 PPS at x4) was a lucky one and should not be quoted. The canvas count above is the reliable evidence. The real gain has to be measured on the phone with the overlay.

The sandbox has one core, so workers cannot run in parallel with the page here; the x4 gain comes from the throttle slowing only the page thread. Whether workers beat the page thread on a real phone (Galaxy S8+) is not measured. `tetris_botworker=0` turns them off if they do not.

### What changed in the third part (phase 6c)

- **REDUCE MOTION** (Options, new group "Motion" at the end of the list so the screenshots did not move): auto follows the system setting, on and off override it. Stored in `tetris_motion` (`auto`/`on`/`off`; anything else reads as auto). `REDUCED_MOTION` (a constant read once at load) became `isReducedMotion()` in `core/config.ts`, which reads `configState.motion` and the live media query; it is used in the same five places (clear particles and bounce in `engine/engine.ts` and `versus/stations.ts`, floating pieces in `ui/settings.ts`, the logo animation in `ui/brand.ts`). Turning it on also removes the floating pieces already on screen.
- **ADAPTIVE QUALITY** (same group): on/off, stored in `tetris_adaptive` (was read-only before). The flag is now `perfState.adaptive` (it was a private variable in `ui/screens.ts`); `adaptiveStep` resets the tier to 0 when it is off, so reverting a change on cancel cannot leave a stale tier.
- Both rows follow the existing Options rules: they apply live, SAVE writes them, BACK discards them (`snapOpts`/`restoreOpts` carry them at the end of the snapshot). The test hook `profileSummary()` strips them from the options snapshot (`legacyOptsSnapshot` in `testing/harness-hook.ts`) so the v1.2.0 fixture comparison stays valid; there is no RESET ALL on the Options screen, so nothing to add there.
- `STORAGE_KEYS` gained `tetris_adaptive` and `tetris_motion`.
- New checks: `tests/harness/check_motion_setting.py` (the buttons cycle, SAVE stores, a reload restores, floaters follow the setting and the system preference in all four combinations) and `tests/harness/check_solo_lowfps.py` (game time against wall time in an ultra game at CPU x1/x4/x8, or any list; run it on `legacy/TetriZZ.html` to see the old behaviour).

### Verified in 6c

- Unit tests 64 passed; lint 0 errors (76 warnings, as before); typecheck clean; both builds produced.
- Fixtures PASS (multi-file); screenshots 76 shots, 0 failing, worst 0.0004% (multi-file); solo and 4-player match traces PASS (single file); `check_perf_overlay.py`, `check_bot_worker.py` (all five conditions) and `check_motion_setting.py` PASS.
- `check_solo_lowfps.py`, new build / v1.2.0 (sandbox, 1 core): CPU x1, x4: 1.00 game s per wall s at 60 fps; x8 (46 fps) 1.00; x20: **1.00 at 15.4 fps** against 0.50 at 10.4 fps; x40: **0.97 at 7.2 fps** against 0.13 at 4.1 fps. The new build also draws more frames at the same throttle (layer cache). The countdown shows whole seconds, so ratios are good to about 0.07.

### Still open after Phase 6

- Both phone-dependent items are decided in Phase 6d. Optional, not started: disabling `backdrop-filter` on weak devices (plan item 5), a menu row for the worker setting if an A/B on the phone is wanted, and telemetry by device class (waits for the server in Phase 8).

### Notes for Phase 7 and later

- `bot-control.ts`, `planning.ts` and `worker-entry.ts` are the only bot files left in `apps/web/src/bot/`; `bot-control.ts` still reads game state and keeps `// @ts-nocheck`.
- The match trace does not cover the worker path (it is real time). `check_bot_worker.py` and `perf_baseline.py` are the checks for it; `check_perf_overlay.py` covers the overlay and adaptive quality (real time, run it by hand).

## Phase 5 - shared rules in `packages/core` (done)

### What changed

- **`packages/core` now holds the rules.** Pure functions with the board size passed in (`Dims`), no DOM, no imports: piece and kick tables, `collideOn`, `findFullRows`, `pcAfterClear`, `spliceRows`, `tryRotateOn` (returns where the piece would go and which kick passed, changes nothing), `detectSpinOn`, `calcLockScore`, `calcAttack` and `COMBO_ATK`, the level and gravity tables (`speedFor`, timed-mode tables, fixed sprint and battle gravity), and the random helpers (`Rng`, `systemRng`, `mulberry32`, `shuffleInPlace`, `newBag`, `fillBagStream`, `randomHole`, `randomInt`) plus `Clock` and `ManualClock`. `engine/pieces.ts` moved here and is deleted.
- **Three copies of rotation became one.** The solo game (`render/render.ts`), the versus stations (`versus/stations.ts`) and the bot (`bot/bot-control.ts`) each had their own copy of the kick loop; all three now call `tryRotateOn` and only apply the result (sounds, spin effects and `lastRotate` stay in the callers). Spin detection was already shared by solo and stations through `detectSpinOn`; it now lives in core. `calcAttack` and `calcLockScore` left `versus/garbage.ts`, `COMBO_ATK` left `versus/lobby.ts`, and the 7-bag loop of `ensureStream` is `fillBagStream`.
- **`engine/engine.ts` is the adapter between the live board size and the pure rules.** It keeps the old signatures (`collideOn(bd, cells, x, y)`, `findFullRows(bd)`, `spliceRows`, `pcAfterClear`, `detectSpinOn(bd, p)`, `emptyRow()`) and passes `dims`, a live view of `configState.COLS` and `ROWS` (in `core/config.ts`), to core. Callers did not change.
- **Injectable randomness and time (plan item I6).** `core/random.ts` has two sources: `gameRandom` for anything that decides play (bags, garbage holes and targets, bot choices, practice shuffles, online seeds) and `fxRandom` for looks and ids (particles, floating background, noise buffers, room codes). `core/clock.ts` has `clock.now()` and `clock.wall()`. Both default to `Math.random`, `performance.now()` and `Date.now()` read at call time, so the harness's seeded `Math.random` and virtual clock work unchanged. `setGameRng`, `setFxRng` and `setClock` replace them (tests, and later the worker and server). Every `Math.random()` (about 50) and every `performance.now()`/`Date.now()` call in `apps/web/src` goes through them, except the logger's timestamp. `mulberry32` moved from `net/online-lobby.ts` to core.
- **Bot evaluators share one helper set.** `bot/bitboard.ts` holds what the 10-wide and 4-wide evaluators had twice: board encoding, piece cells, validity, column height, drop, drop-from, spin classification, T-slot score and the move simulation. `createBotOps({ occRows, dropTop, guarded, heightMask })` builds the variant-specific ones (the two copies differed in the row limit of the occupancy test, how far above the board a drop starts, a step guard on drops, and a row mask for heights). `bot-10wide.ts` and `bot-4wide.ts` keep thin aliases (`cc2Board`, `wBoard`, `wSim`, ...) so `bot-control.ts` is unchanged.
- **Not merged, on purpose.** `cc2FindMoves`/`wFindMoves`, `cc2Place`/`wPlace` and the two `Eval` functions differ in behaviour (de-duplication keys, bounds, weights), not only in names; merging them would need flags and a fresh proof for every difference. The solo game was not rebuilt on the station model: both now call the same rule functions, which removes the duplication without merging the two state models.
- **Dependency.** `apps/web` lists `@tetrizz/core` as a workspace dependency (the lockfile gains only that link). No other package or version changed.

### Findings (behaviour kept exactly)

- **Half turns never kick.** The half-turn kick table `K180` is a plain list but is looked up by a string key like `"0>2"`, so the lookup always misses and a half turn only tries the unkicked position. This was true in v1.2.0 and is kept (documented in `rotation.ts`, covered by a test). Real 180 kicks would be a gameplay change for a later phase.
- **`calcAttack` with a combo of -1 and a cleared line returns `NaN`** in v1.2.0 and in core. It cannot happen in play (a clear always makes the combo at least 0), so it is left alone; the parity cases only use reachable inputs.

### How it was verified

- Final candidate, multi-file build served over HTTP: fixtures PASS, 4-player bot match trace identical, solo traces identical (endless, ultra, sprint, wide), screenshots 76 shots, 0 failing, worst 0.0004%. Single-file build: the same four parts, the same results. The bot match trace passed after the RNG, clock, rotation and scoring changes and again after the bot-helper merge; it failed once in between (see below).
- **Parity with v1.2.0.** `tests/harness/record_parity.py` runs the original page's own functions on 2,749 generated inputs (boards from 4 to 12 columns and 9 to 40 rows, with garbage, wells, holes and near-perfect-clear stacks) and stores inputs and answers in `tests/golden/parity/core-parity.json` (0.7 MB). `tests/unit/core-parity.test.ts` replays them on `packages/core`: 200 collision and row cases with 2,400 probes, 700 spin cases, 700 rotation cases (more than 100 of them move the piece), 600 lock scores, 500 attacks, the level and gravity tables and nine seeded generator streams. All agree.
- **Bot helper merge.** The first merged version made the bot match trace differ. The cause was a variable renamed to shadow the function it called inside the shared T-slot code (`const spin = spin(...)`), which throws when it runs; the harness caught it. Before fixing it, the original helpers (taken from the Phase 4 zip) were compared with the shared ones in a throwaway test on 400 random boards per variant, covering board encoding, column heights with masks, drop, drop-from, spin, occupancy and the T-slot score for every piece, rotation and column; all agree after the fix. That test is not kept (it needs the old sources); the bot match trace is the lasting check, and it passes.
- A scan of every module with its `@ts-nocheck` header removed shows no undefined names (the only hits are the browser libraries loaded separately: `qrcode`, `jsQR`, `BarcodeDetector`, `mqtt` and the `tetris-fumen` URL). It caught two missing imports (`KJ` in two files) before the build was run.
- `format:check`, `lint` (0 errors, 76 warnings, all pre-existing kinds), `typecheck`, `test` (45) and both builds pass.
- Not covered by any recording, as before: LAN and relay play, the online lobby, replay playback, input paths other than direct calls. Phase 5 touched online seeds (`mulberry32`, `gameRandom`) and the garbage target choice in `boot/34-online-sync.ts`, so test an online match and a LAN match by hand before trusting this build there.

### Notes for Phase 6 and later

- (Resolved in Phase 6.) `packages/bot` was empty. Moving the evaluators there needed the board size passed in instead of read from `configState` (`bot/bitboard.ts` and the bot files read it in about 60 places); do that together with the Web Worker in Phase 6. `bot/bot-control.ts` also reads game state, so only the evaluators and `bitboard.ts` can move first.
- `calcLockLabel` (text and colours for the lock banner) stays in `versus/garbage.ts` because it is presentation. The piece colours stay in the shared piece table since many drawing sites read them.
- The harness still sets `tetris_bg=0` for traces. With the separate sources it could instead seed `gameRandom` directly (`setGameRng`) and leave the background on; not changed here to keep the goldens comparable.
- New files in this repo have no `// @ts-nocheck` except `bot/bitboard.ts` (it reads `configState`, which is still unchecked) and the web adapters follow their neighbours. Converting those is part of the later TypeScript clean-up.
- `docs/PLAN.md` is unchanged.

## Phase 4 - JavaScript into modules (done)

### What changed in `apps/web`

- **Modules.** The 24,865-line inline script was cut by a parser-based codemod (acorn-compatible parser plus scope analysis, run from a scratch folder and not committed) into 36 feature modules in `engine/`, `render/`, `game/`, `input/`, `ui/`, `practice/`, `versus/`, `bot/`, `net/`, `replay/` and `core/config.ts`, plus 23 startup files in `boot/`. `index.html` now loads `src/main.ts`, which only imports. Module boundaries follow the script's own sections and some names are provisional: for example the game state variables live in `game/state.ts` and the moves/rotation helpers in `render/render.ts`. Moving functions between modules is safe at any time; the structure is not final until Phase 11.
- **Why the build order cannot go wrong.** Feature modules contain only function declarations and constants whose initialisers read nothing from other modules. Four statements that did read another module's value while loading (`menuView` with `ctrlDev` and `openOverlayEl`, `KEYNAME`, `PADBTN`, `W_MASK_VAL`) were moved to the startup files. Everything that ran while the old script loaded (about 185 statements: event wiring, DOM lookups, the first `selectMode`) is in `boot/NN-*.ts` in its original relative order, and `main.ts` imports all feature modules before the startup files in numeric order. A simulation of ES module evaluation over the generated import graph found no feature module that reads another one's value while loading. **Keep this rule when adding code:** no top-level code in a feature module that calls other modules; put it in a `boot/` file.
- **State objects.** All 263 top-level `let`/`var` names, plus the constants that are assigned while loading (DOM element references and the four statements above), became properties of 29 state objects, one per module that owns state (`configState`, `versusLobbyState`, `onlineSyncState`, ... and `game` for the board, queue, score and `state`). 4,965 references were rewritten with scope analysis, so shadowed locals are untouched. The old script allowed any function to reassign these variables; imported bindings cannot be reassigned, which is why they are properties.
- **typeof guards.** 56 `typeof fn === "function"` guards and 18 on constants are removed (always true once imported). 160 guards on state variables became `x !== undefined` (identical truth value). Feature detection of browser APIs and libraries (`qrcode`, `jsQR`, `Path2D`, `ResizeObserver`, streams) is untouched. Some `x !== undefined && x` chains remain; simplify them when the owning file is converted to checked TypeScript.
- **Event bus.** `core/events.ts` replaces the `tz*` hook/intercept functions with typed registries: `onEvent`/`emitEvent` (notifications, `EventMap`), `onBefore`/`emitBefore` (run before the action, `BeforeEventMap`) and `intercept`/`isIntercepted` (a handler returns true to veto, `InterceptMap`). Handler order and veto semantics are unchanged; a throwing handler is logged at debug level and skipped, as before it was ignored. `tzLog` and `DEBUG_TZ` are gone. Other `tz*` names (`tzRepaint`, `tzToast`, `tzLevelForLines`, `tzGravMsForLevel`, `tzTickBody`) are ordinary functions that kept the prefix; rename them with their modules.
- **`p2p*` to `relay*`.** `p2pCreateRoom`, `p2pJoin`, `p2pResumeRoom`, `p2pSend`, `p2pDispatch`, `p2pTeardown`, `p2pPushRoster`, `p2pSettings`, `p2pPlayerName`, `p2pDestroyConnFor` are now `relay*`, and the `P2P` object is `RELAY`. The string `"p2p"` stays: it is the stored room mode in `tetris_lastroom` and may be compared with values from older saves.
- **Storage layer.** `core/storage.ts` wraps `localStorage` and `sessionStorage` as `storage.get/set/remove` and `tabStorage.get/set`; it passes exceptions through exactly as the raw API did. It lists the 38 known keys (`StorageKey`), keeps the schema version in `tetris_schema` and runs ordered migrations (`MIGRATIONS`, `runStorageMigrations`). Migration 1 is the old training-to-practice rename that used to run on every load; it now runs once per profile. To change stored data later, append a numbered migration and never edit a shipped one. Two new keys exist: `tetris_schema` (written) and `tetris_loglevel` (read only).
- **Logger.** `core/logger.ts` (`log.debug/info/warn/error`, `swallow(scope)`, a 200-entry ring buffer, level from `tetris_loglevel`, default `warn`). All 131 empty `catch` blocks now call `log.debug("<module>.<function>", error)`, 4 empty promise catches use `swallow`, and 5 stray `console.log` calls in the LAN and relay code became `log.debug`. Nothing is printed by default.
- **Security pass.** Every `innerHTML` assignment that interpolates data (41 of 56) was reviewed. The existing `esc` helper (escapes `& < > " '`) moved to `core/escape.ts` as `escapeHtml` and is used wherever it was used before. Three paths reached `innerHTML` without escaping and now use it: the player label in the versus scoreboard (`st.label`, built from network player names), player ids placed in `data-hostxfer`, `data-kick` and `data-pingid` attributes in the online lobby, and the replay list (title, date and id of replays that can come from imported files). Not changed: values that are numbers, constants or built only from game state. Open point for Phase 6/8: `querySelector('[data-pingid="' + id + '"]')` still builds a selector from a network id (a malformed id throws instead of matching).
- **TypeScript.** `core/events.ts`, `logger.ts`, `storage.ts`, `escape.ts` and `version.ts` are strict TypeScript with unit tests (`tests/unit/`, 22 tests in 5 files). The other modules start with `// @ts-nocheck` and are converted one by one; the matching ESLint block in `eslint.config.js` lists the rules relaxed for them (75 warnings, 0 errors). Checking them once without the pragma showed four unused locals, which are deleted. `npm run typecheck` passes.
- **Version label.** `core/version.ts` reads `__APP_VERSION__`, defined by Vite from the root `package.json` (currently 1.2.0), and `main.ts` writes `v1.2.0` into a footer line of the main menu.
- **Service worker (build step).** With the script in its own file the first offline visit would have had a page but no code, so `vite.config.ts` now writes the hashed `assets/*` into `dist/sw.js`'s `APP_SHELL` and gives each build its own cache name (`<version>-<hash>`). This also fixes the CSS gap noted in Phase 3 for the multi-file build. The Phase 9 replacement of the worker still stands.
- **Harness.** `window.__h` is now created by the page itself: `testing/harness-hook.ts` replaces it only when the harness has already installed one, so normal pages expose nothing. The contract gained `showScreen(name)`, `openInstallPop()`, `togglePause()` and `gameOver()` (the screenshot script used to call those as globals). `verify.py` accepts a directory and serves it on a loopback port (ES modules do not load from `file://`), `lib.py` allows `http://127.0.0.1:`, and CI passes `builds/dist`. `noise_masks.json` masks the version label (menu-main and the install popup, which shows the menu behind it) in all four variants.
- Nothing was added to `package.json`; versions are as recorded in Phase 1.

### How it was verified

- Final candidate, multi-file build served over HTTP: fixtures PASS, 4-player bot match trace identical, solo traces identical (endless, ultra, sprint, wide), screenshots 76 shots, 0 failing, worst 0.0004% (with the label masks). Single-file build: screenshots 76 shots, 0 failing, worst 0.0004%; fixtures PASS, bot match trace identical, solo traces identical.
- Before the version label existed, the single-file build passed all 76 screenshots, and the Phase 3 build served over HTTP passed 76 as well, so serving over HTTP does not change the pictures.
- A solo session ended and saved as a replay in the new build is byte-identical to the Phase 3 build's (random ids normalised). A versus replay cannot be compared this way because two runs of the Phase 3 build already differ from each other; both builds record the same event kinds (`a`, `fx`, `s`) in similar numbers.
- `format:check`, `lint` (0 errors), `typecheck`, `test` (22) and both builds pass.

### Notes for Phase 5 and later

- Not covered by any recording: LAN and relay play, the online lobby, replay playback screens, input paths other than direct calls, and the new storage migration on a real old profile (the unit tests cover it). The module move changes how those parts are wired, so test them by hand before trusting a green harness.
- Known dead code kept on purpose: an `else if` in `net/lan.ts` (line 446) that can never run; fix it in the phase that touches LAN.
- The legacy modules are large (`net/online-lobby.ts` 2,393 lines, `replay/replay.ts` 1,398, `ui/screens.ts` 1,378); they are the first candidates when files are converted to checked TypeScript or split further.
- `docs/PLAN.md` is unchanged.

## Phase 3 - CSS split (done)

### What changed in `apps/web`

- The `<style>` block is gone from `index.html`; the page now has one `<link rel="stylesheet" href="./src/styles/main.css" />` at the same position (after the vendored libraries, before `</head>`). `main.css` holds 25 `@import` lines. The page went from 33,271 to 26,227 lines.
- The CSS is cut into 25 **contiguous** chunks of the Phase 2 stylesheet, so the cascade order is unchanged (no rule moved, no rule reordered). The numeric file prefix is the cascade order. Some chunks are not pure (for example later overrides of overlay rules sit inside `11-main-menu`, and `20-responsive-versus` carries `body.vsplay` rules for several screens) because rules were not moved; reordering and regrouping by feature is left to Phase 11, where the screenshots gate it.

| File                       | Lines | Mostly                                                                         |
| -------------------------- | ----: | ------------------------------------------------------------------------------ |
| `01-properties.css`        |   125 | `@property` registrations for the theme colours                                |
| `02-themes.css`            |   113 | `:root` colour themes (dark and light variables)                               |
| `03-base.css`              |    55 | reset, `html`, `body`                                                          |
| `04-background.css`        |    28 | floating background pieces                                                     |
| `05-header.css`            |   135 | header, logo tiles, header buttons, sound and pause buttons                    |
| `06-playfield.css`         |   203 | main grid, side panels, canvas, hold and next, ping, versus play layout basics |
| `07-feedback.css`          |   202 | action text, combo and B2B chips, score                                        |
| `08-multiboard.css`        |    73 | duo, mini and trio stat blocks, stage                                          |
| `09-board-banners.css`     |   258 | board wrapper, banners, countdown, game-over text, restart hold                |
| `10-overlays.css`          |   254 | overlay, start, pause, game-over and online-pause screens                      |
| `11-main-menu.css`         |   466 | main menu (`mm`) and later overlay variants                                    |
| `12-menu-screens.css`      |   140 | menu screens and menu buttons                                                  |
| `13-game-stats.css`        |    72 | final score and game stats                                                     |
| `14-versus-results.css`    |   139 | versus final results and the sticky screen bar                                 |
| `15-mode-screens.css`      |   228 | back and save buttons, mode grid and mode cards                                |
| `16-settings-controls.css` |   394 | settings groups, steppers, sliders, key bindings                               |
| `17-touch-controls.css`    |   258 | touch layout editor and touch buttons                                          |
| `18-practice.css`          |   214 | practice mode layout and tools                                                 |
| `19-multiplayer-hud.css`   |   527 | versus HUD, gauges, multiplayer banners                                        |
| `20-responsive-versus.css` |  1255 | versus layout overrides and the large media-query block                        |
| `21-online-rooms.css`      |   124 | online lobby, room, copy, kick and swap                                        |
| `22-responsive-online.css` |   315 | online and wide-board layout media queries                                     |
| `23-replay.css`            |   358 | replay screen and controls                                                     |
| `24-install-popup.css`     |   135 | install popup, drop zone                                                       |
| `25-board-library.css`     |   836 | board capture, fumen, board library, new board                                 |

- Nine unused classes removed, each checked as a whole word in the markup and the script (the markup lives inside the script's template strings), plus a search for names built by concatenation (`"x-" + y`, template holes) that found nothing matching: `m-sub` (one selector dropped from a list), `mm-desc`, `mm-dl`, `mc-vsbot`, `vs-pips`, `ghosty`, `trpick`, `trpick-btn`, and `mp2` (five `.mode-grid.mp2` rules and the `@media` that held only those). 15 rules, 1 selector and 1 empty `@media` in total; 924 top-level nodes remain (934 before). The stylesheet has 1,382 rule and at-rule entries (1,398 before).
- **Kept on purpose:** `.mode-grid:not(.mp2)` (three rules in `15-mode-screens`). No element ever has `mp2`, so the negation is always true and these rules apply to every mode grid. Deleting them would change the game; dropping the `:not()` would lower the selector's specificity and could change the cascade. Replace it in Phase 11 together with the other specificity work.
- Not classes, so not removed, listed for Phase 11: custom properties that are set but never read (`--cyan`, `--accLo`, `--purple`, `--glowA`, `--glowB`, `--vig`; the last three also have an `@property` registration). All 20 `@keyframes` and all 61 ids used in the CSS are in use.
- `apps/web/vite.config.ts` has a new small plugin, `stripStylesheetCrossorigin`, for the multi-file build only: Vite adds `crossorigin` to the stylesheet link, and Chromium then refuses to load the CSS when the page is opened from disk (`file://`), leaving it unstyled (tested). The single-file build inlines the CSS and is unaffected.
- `README.md` (layout note on the cascade order) and `CHANGELOG.md` are updated. `package.json`, `package-lock.json` and every dependency are unchanged.

### Build output

- Multi-file `dist/`: `index.html` 1,110 KB (gzip 259 KB) plus `assets/index-<hash>.css` 161 KB (gzip 25 KB, unminified on purpose: `cssMinify` is still off). Single file `dist-single/TetriZZ.html` 1,271 KB (gzip 284 KB), 43 KB smaller than the Phase 2 page because the style block lost its 6-space indentation.

### How it was verified

- Source: the Phase 2 CSS and the concatenation of the 25 files (in `main.css` order), both parsed with postcss and flattened to ordered rule entries (selector, declarations, `!important`, at-rule context), differ in exactly the 15 rules, 1 selector and 1 empty `@media` above and nothing else. The same flattened entries from the built CSS of the multi-file build and from the `<style>` block of the single-file build are identical to the source files, entry by entry in the same order (1,382 each). In the browser both builds expose 924 top-level rules.
- Full harness on `apps/web/dist-single/TetriZZ.html` and on `apps/web/dist/index.html` (loaded from disk): fixtures PASS, solo traces identical (endless, ultra, sprint, wide), 4-player bot match identical, screenshots 76 shots, 0 failing, worst 0.0004%. `format:check`, `lint`, `typecheck`, `test` and both builds pass.
- The one-off scripts (postcss from `node_modules`, in a scratch folder, not committed) are not in the repo; the list above is the record.
- The screenshots do not cover the online lobby, the board library, capture and board-view screens, replay playback or the install-popup buttons, so the removed rules for `mode-grid.mp2`, `trpick*` and `ipop-btn.ghosty` rest on the usage search, not on a picture.

### Notes for Phase 4 and later (both resolved in Phase 4)

- The multi-file build now has a separate hashed CSS file that `sw.js` does not precache (it precaches `index.html`, the manifest and the icons; other same-origin files are cached on their second load). Opening the multi-file build offline after only one visit therefore loses the styles until Phase 9 replaces the service worker with a precache of all hashed files. The single-file build is not affected and no deployment is live.
- In Phase 4 the script becomes an ES module, which browsers refuse to load from `file://`: the harness then has to serve `dist/` over HTTP (its request filter currently lets only `file:`, `data:` and `blob:` URLs through, so it needs one more allowed origin) and CI has to start a static server. The single-file build keeps working from disk.

## Phase 2 - format, dead code, comments (done)

### What changed in `apps/web`

- `index.html` and `public/sw.js` are formatted with the repo's Prettier config and no longer listed in `.prettierignore`; `.gitattributes` no longer marks them `-text`, so they are LF like the rest of the repo. The page went from 8,633 to 33,271 lines (main script 24,867 lines, CSS 7,046 lines) and from 934 KB to 1,314 KB (gzip 261 KB -> 285 KB). The size is whitespace; Phase 4 builds the JavaScript through Vite, which minifies it.
- The two vendored libraries (qrcode-generator 1.4.4, jsQR 1.4.0) stay byte-identical (apart from LF line endings), still minified, with their jsDelivr banner and source-map comment. Each `<script>` has a `<!-- prettier-ignore -->` line above it. These are the only comments left in the page; they disappear in Phase 4 when the libraries come from npm.
- Dead code removed (38 edits, checked name by name; every name occurred only at its declaration anywhere in the page, and the script has no `window[...]`, `eval` or `new Function` lookups):
  - unused functions: `invalidatePanelUnit`, `pieceBottom`, `writePracticeGrid`, `capDetectBoard`, `currentPracticeGrid`, `snapCell`, `bzBrush`, `mqSendRelay`, `loadScript`, `rpLockBurst`, plus `capClassify` and `capGridRows`, which only `capDetectBoard` used;
  - the first copy of `bvOpen`, `bvClose`, `bvDraw`, `bvCellAt`, `bvPointerDown`, `bvPointerMove` (the later top-level declaration of the same name always wins);
  - unused `_myReadyToggleAt`; variables that were only ever assigned constants (or `performance.now()`), removed with every assignment: `bvStroke` (3 assignments), `vsRoundEndAt` (8), `isLanHost` (4); the local `_rejoinSettings` (result of the side-effect-free `p2pSettings()`, never read).
- Comments removed: 142 in the script (123 block, 19 line), 78 in the CSS, 9 in `sw.js`; the page had no HTML comments. A multi-line block comment is replaced by a newline, a single-line one by a space, so automatic semicolon insertion and token boundaries cannot change. New comments come in Phase 11.
- Not touched on purpose: five unused local variables (`difficult`, `offsetY`, `frame`, `h`, `_lk`; TypeScript's `noUnusedLocals` flags them in Phase 4), CSS classes that no markup uses (Phase 3), the `p2p*` names (Phase 4), the `sw.js` precache bug (Phase 9).
- `apps/web/index.html` is no longer byte-comparable to `legacy/TetriZZ.html`; the harness is the comparison from here on.

### How it was verified

- Syntax trees (acorn) of the script and `sw.js` before and after Prettier are identical, after ignoring only what Prettier changes without changing meaning: quotes on object keys (`{"a":1}` -> `{a:1}`), stray `;` statements, and redundant parentheses in `a && (b && c)`. The same trees show exactly the intended removals between the Phase 1 script and the dead-code result.
- CSS: 5,089 rules/declarations/at-rules before and after are the same in the same order (only number spelling, optional spaces around `*` and `/` inside `calc()`, and single vs double quotes in font names differ). Markup: 900 DOM nodes with all attributes identical.
- Full harness on `apps/web/dist/index.html` (identical to `dist-single/TetriZZ.html`): fixtures PASS, solo traces identical (endless, ultra, sprint, wide), 4-player bot match identical, screenshots 76 shots, 0 failing, worst 0.0004%. `format:check`, `lint`, `typecheck`, `test` and both builds pass; dependencies and `package-lock.json` did not change.
- The one-off scripts (acorn, postcss and parse5 from a scratch folder, not added to the repo) are not committed; the list above is the record. Prettier's first pass left one member chain in the online code unformatted, so the committed page is the second-pass result and `format:check` passes on it.

## Phase 1 - scaffold and build pipeline (done)

### What exists

- npm-workspaces monorepo: `apps/web` (Vite app), `apps/server` (placeholder), `packages/core`, `packages/bot`, `packages/protocol` (placeholders; protocol exports `PROTOCOL_VERSION = 1`). The root `package.json` is the only version source (still 1.2.0; the version label and 1.3.0 come with Phase 4 and the M1 release).
- `apps/web/index.html` is the v1.2.0 page **unchanged** (CSS and JS still inline). Its script is a classic global script, so it cannot become a module before Phase 4. `apps/web/public/` holds `sw.js`, `manifest.json` and the icons, unchanged.
- Builds: `npm run build` -> `apps/web/dist/` (page, sw.js, manifest, icons). `npm run build:single` -> `apps/web/dist-single/TetriZZ.html` (vite-plugin-singlefile, no sw/manifest/icons). `npm run build:all` runs both.
- Build output vs `legacy/TetriZZ.html`: identical except that Vite rewrites the inline CSS block with LF instead of CRLF (1,391 carriage returns fewer; nothing else). The multi-file page and the single file are byte-identical to each other. `cssMinify` is off so the CSS is not otherwise touched.
- Tooling: ESLint (flat config) with dependency-direction rules (core and protocol import no workspace package and no `node:*`; bot imports only core; the two apps never import each other; a negative test confirmed the rules fire), Prettier, strict TypeScript per workspace, Vitest (`tests/unit`, `packages/*/src`), `.editorconfig`, `.gitattributes` (legacy files and the page are marked `-text` so line endings stay as they are), `.nvmrc` = 26, LICENSE placeholder (UNLICENSED), CHANGELOG, README.
- Prettier does not touch `manifest.json`, `docs/PLAN.md`, `legacy/`, `tests/harness`, goldens or fixtures (the page and `sw.js` were formatted in Phase 2).
- CI (`.github/workflows/ci.yml`): `check` job (format, lint, typecheck, unit tests, both builds, artifact upload) and `regression` job (fixtures, solo and vs against both builds; screenshots run as informational only because they depend on the Chromium build and fonts). Not run yet: there is no GitHub in the sandbox. The YAML parses; first push is the real test.
- `tests/harness/requirements.txt` pins the Python side to the versions that recorded the goldens (Playwright 1.63.0, numpy 2.5.4, pillow 13.0.0).

### Verification

- Reference `legacy/TetriZZ.html` unpacked from the Phase 0 zip: fixtures, solo, vs, screens all PASS (screenshots: 76 shots, worst 0.0004%). This is the first run of all four parts from the unpacked zip.
- Multi-file `apps/web/dist/index.html`: fixtures, solo, vs, screens all PASS (76 shots, 0 failing, worst 0.0004%).
- Single file `apps/web/dist-single/TetriZZ.html`: fixtures, solo, vs PASS (screens not run separately; the file is byte-identical to the multi-file page, which passed).
- Clean-room check: copy without node_modules or dist, `npm ci`, both builds, lint, typecheck and tests all succeed, and the build matches byte for byte.
- Run harness parts one at a time in the sandbox (about 4 min for solo, 1.5 min vs, 2.5 min screens); launch long runs detached (`setsid nohup ... &`) or the process dies when the command returns.

### Versions (live-checked 8 Nov 2026)

Node 26.13.0 (Active LTS since 28 Oct 2026; the sandbox's own Node is 22.23.4, so Node 26 was installed with `npm i node@26` into a tools folder and put first on PATH), Vite 8.3.6, vite-plugin-singlefile 2.3.4, Vitest 5.1.0, ESLint 10.14.0, @eslint/js 10.0.1, typescript-eslint 8.72.1, Prettier 3.9.10, TypeScript 6.0.3 (latest is 7.0.2, but typescript-eslint requires `>=4.8.4 <6.1.0`), globals 17.14.0, eslint-config-prettier 10.1.8, @types/node 26.6.6. GitHub Actions: checkout v7.0.1, setup-node v7.1.0, setup-python v7.1.0, upload-artifact v7.0.2, download-artifact v8.0.2 (used by major tag). Not added yet, look up again when needed: vite-plugin-pwa (Phase 9), @playwright/test (first npm e2e test), and everything under Server, Database and Client libs in the plan.

### Notes for later phases

- `git` is not initialised in the zip; run `git init` on your side (`.gitattributes` and `.gitignore` are ready).
- `base: "./"` keeps all URLs relative so one build works from any sub-path.
- GitHub Actions workflows are pinned by major tag, not commit hash; pin hashes before the repo goes public if desired.

## Repo contents

- `apps/web/src/` — the page's script: `main.ts` imports every module (see Phase 4 and the README); `boot/` holds startup code in load order.
- `apps/web/src/styles/` — the page's CSS: `main.css` imports 25 numbered files in cascade order (see Phase 3).
- `legacy/` — the untouched v1.2.0 files (`TetriZZ.html`, `sw.js`, `manifest.json`, icons). Reference for every comparison.
- `packages/core/src/` — the shared rules (see Phase 5); `packages/bot/src/` — the bot evaluators, planners and worker request types (see Phase 6).
- `tests/harness/` — Python + Playwright harness (see "Running"); `tests/bench/` — planner timing (`npm run bench`).
- `tests/golden/` — recordings made from `legacy/TetriZZ.html`:
  - `solo/` four scripted sessions (endless, ultra, sprint, wide; up to 160 pieces, lines cleared, sprint finishes at 40 lines)
  - `vs/` 4-player match (1 idle user + 3 level-10 bots at 5 PPS, ~35 s of game time); `vs-4p-bots.json` is from the Phase 6d build, `vs-4p-bots.v1.2.0.json` from v1.2.0
  - `screens/` 76 screenshots = 19 shots x {desktop 1280x720, phone 390x844} x {dark, light}
  - `perf-baseline-legacy.json` real-time baseline (machine dependent)
  - `parity/core-parity.json` inputs and the answers the v1.2.0 page gave (2,749 cases: collision, spin, rotation and kicks, lock scores, attacks, level tables, seeded generator); replayed by `tests/unit/core-parity.test.ts`
- `tests/fixtures/legacy/` — `profile-full.json` (all 19 localStorage keys, custom options, a finished sprint score, two saved replays), `profile-full.expected.json`, `replays/*.tzzreplay` (gzip JSON, the export format), `replay-sizes.json`.

## Running

Needs python3, `playwright` (+ chromium), `numpy`, `pillow`. In the sandbox: Python Playwright 1.63.0, Chromium 153.

```
python3 tests/harness/verify.py <build.html | dist-dir> [--part solo|vs|screens|fixtures]   # exit 0 = all selected parts pass (also: npm run verify -- <build.html>)
python3 tests/harness/perf_baseline.py <build.html> out.json [thread|worker|both] [1,4]   # wall clock, CPU throttled
python3 tests/harness/check_server_room.py <dist-dir>                              # rooms on the own server against a Playwright-hosted fake (real time)
python3 tests/harness/check_bot_worker.py <build.html>                           # bots keep playing without, with silent or with broken workers
python3 tests/harness/check_perf_overlay.py <build.html>                         # debug overlay and adaptive quality (real time)
python3 tests/harness/check_motion_setting.py <build.html>                       # REDUCE MOTION and ADAPTIVE QUALITY rows (real time)
python3 tests/harness/check_bot_pps.py <build.html>                               # pieces per second bots reach against the PPS asked for (virtual clock)
python3 tests/harness/check_bot_lobby.py <build.html>                             # bot LEVEL / BOT PPS steppers in the lobby: typing, saving, clicking, holding (real time)
python3 tests/harness/check_hidden_tab.py <build.html> [--seconds 10] [--pps 10] [--bots 1]  # bot pace and game clock while the page is hidden, and after (real time)
python3 tests/harness/check_solo_lowfps.py <build.html> [1,4,8]                  # game time per wall second at CPU throttles (also run it on legacy/TetriZZ.html)
python3 tests/harness/record_bot_plans.py                                       # re-record tests/golden/parity/bot-plans.json from legacy (only on purpose)
python3 tests/harness/record_parity.py                                          # re-record tests/golden/parity from legacy/TetriZZ.html (only on purpose)
```

The multi-file build must be given as a directory (`apps/web/dist`): it is served over HTTP because ES modules do not load from `file://`. Full verify takes about 6 minutes on one CPU; the sandbox limits a command to 300 s, so run parts separately there.
Re-record goldens only from `legacy/TetriZZ.html` and only on purpose (exception: the 4-player match golden `vs-4p-bots.json` was re-recorded from the Phase 6d build when bot pacing changed; `vs-4p-bots.v1.2.0.json` is the old one) (`record_solo.py`, `record_vs.py`, `screens.py`, `make_fixtures.py`, then `check_fixtures.py --write`).

## Harness contract (the modular build must provide `window.__h`)

`startSolo(mode)`, `act(name, arg)` with move/rotate/hold/soft/drop, `snap()` (state, mode, score, lines, level, combo, maxCombo, b2b, pieces, hold, cur, px, rot, board hash), `board()`, `shapes()` (piece cell offsets per rotation), `startVs(cfg)`, `vsSnap()`, `async profileSummary()` (options snapshot, mode, scores/replays screen text, replay frame counts), and for the screenshots `showScreen(name)`, `openInstallPop()`, `togglePause()`, `gameOver()`. The modular build installs these from `src/testing/harness-hook.ts`, and only if the harness has already created `window.__h`. The v1.2.0 adapter is `tests/harness/legacy_adapter.js`; the build also needs the same element ids the harness clicks (`saveReplayBtn`, `installPop`, `ovStart` menu screens).

## Determinism recipe (all of it is needed)

- Playwright virtual clock (`page.clock`), started from a **datetime** (a plain number is read as seconds in the Python API), paused, advanced only by `run()`.
- Seeded `Math.random` (mulberry32) installed before the page loads.
- External requests (Google Fonts) answered instantly and empty.
- `tetris_ipop` = far-future ms timestamp (it is a "suppressed until" time; `'1'` does not hide the install popup).
- `tetris_bg=0` for traces: the floating background pieces draw from `Math.random` on real-time CSS-animation timing, which changes the piece sequence between runs. (Phase 5 added `setGameRng`/`setFxRng`, so a later harness can seed the gameplay source directly instead.)
- Screenshots: CSS animations/transitions disabled and `Element.animate` finished immediately from page start (the combo/B2B badges use the Web Animations API, which ignores the virtual clock); particle effects off.
- Use DOM `.click()` for buttons: Playwright's `click()` waits for animation frames and hangs while the virtual clock is paused.
- Screenshot comparison: a pixel differs when any channel differs by more than 4; a shot fails above 0.01% differing pixels. Measured noise between two identical runs: 0.0004%. One masked area: a badge on the phone practice screen (`noise_masks.json`).

## Baselines measured on the v1.2.0 build (sandbox, 1 CPU, software rendering)

- 4-player match, bots asked for 8 PPS, 15 s wall clock: CPU x1 -> median frame 33 ms, bots reach 5.2-5.6 PPS; CPU x4 -> median frame 100 ms (p95 183 ms), bots reach about 2.0-2.3 PPS. This reproduces the lag on the S8+.
- Replay sizes: solo sprint 32 s -> 7.9 KB gzip / 73 KB JSON; 2-player battle 43 s -> 13.9 KB gzip / 135 KB JSON (about 0.25-0.32 KB/s compressed).

## Known gaps in the safety net (be aware before trusting a green run)

- Traces call game functions directly (move/rotate/hold/drop); the keyboard, touch, gamepad and mouse input paths are not covered. Spins and perfect clears are not guaranteed to occur in the scripted sessions.
- Not captured: online lobby screen, LAN screens, board library/capture/board-view overlays, replay playback screens, practice-mode traces.
- Fixture check compares the options snapshot, replay frame counts and the scores/replays screen text; the scores text only shows the default (endless) tab, so the stored sprint score is not displayed in the check. Session resume (`tetris_session`) is not covered.
- Versus traces use virtual time and plan on the page thread (`tetris_botworker=0`), so bots never run out of their per-frame time budget and the worker path is not traced; bot speed under load and the worker path are covered only by `perf_baseline.py` and `check_bot_worker.py`.
- Screenshot goldens depend on this Chromium build and its fonts (Google Fonts are stubbed, so system fallback fonts are used). Re-record on a new Chromium version before comparing.
- `noise_masks.json` also covers the version label (menu-main and install-popup in all variants); update those rectangles if the label moves, and remember the label text changes with every release.
- Replay recording in versus matches is not deterministic across runs even in the Phase 3 build, so it can only be compared by structure (event kinds), not byte for byte.
- The sandbox's own Node is 22.23.4; use the Node 26 install described in the Phase 1 section.

## Working rules carried over from the plan

Small tool outputs, report at the end of each phase with a rough context estimate and a continue-or-new-chat recommendation, full files rather than patches when that costs no more.
