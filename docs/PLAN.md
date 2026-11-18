# TetriZZ Refactor, Server and Deployment Plan

Prepared for Noel on 8 Nov 2026. Baseline: TetriZZ v1.2.0 (TetriZZ.zip). Status: plan approved, implementation not started.

## 0. How to use this document

Start a new chat, upload TetriZZ.zip again (files from earlier chats do not carry over) and paste this document. Then send:

> Read the attached plan and the uploaded TetriZZ.zip (v1.2.0). Start Phase 0. Follow the Working rules in section 1. Keep tool output short, report at the end of each phase, and update docs/PROGRESS.md in the repo.

Work is split into phases and milestones (section 15). The repo zip plus docs/PROGRESS.md is the handoff between chats, so one chat per phase or two is fine.

## 1. Working rules

1. Phases 0-5 and 7 must be behaviour-identical, functionally and visually, proven by the regression harness (section 7). Intentional changes only where this plan lists them.
2. Before using any dependency, tool or Docker image, look up its latest stable/LTS version live. Never use memory. Node: latest LTS (26). If the newest release is incompatible with the ecosystem (for example TypeScript 7 with typescript-eslint), use the newest compatible one and note why.
3. Fixes to a large file: give the full updated file when that costs no more context than the alternative; otherwise separate find-and-replace blocks usable with VS Code replace.
4. Ask questions only when essential, one at a time.
5. At the end of each phase, give a rough estimate of how much context the chat has used and say whether to continue here or start a new chat.
6. Keep tool output small: summarise, do not dump files or long logs.
7. After each phase deliver the repo zip and update docs/PROGRESS.md (phase status, decisions, how to run the harness, known issues, next step).
8. Comments are written from scratch: purpose of each file, TSDoc on exports, "why" notes for non-obvious logic. Never refer to past fixes, phases or chat conversations.
9. Suggested effort level: High for Phases 0, 4, 5, 6, 7, 8; Medium for 1, 2, 3, 9, 11; Max only when stuck on a hard bug.

## 2. Goals

- Turn the single 8,633-line HTML file into a clean modular project that developers can contribute to on GitHub, plus a generated single-file build for quick phone testing.
- Nothing may break. Dead code, duplication and bad comments are removed; code is formatted and ordered so related parts sit together.
- Fix lag (4 players with level-10 bots at high PPS; lag on an old Galaxy S8+).
- Deploy to GitHub Pages, Vercel, Cloudflare Pages, or a VPS with Docker Compose where the VPS runs its own backend (no Supabase).
- Owner monitoring, logging and analytics with alerts (Telegram, Discord, email) and data that survives crashes, restarts and a move to another VPS.
- Fully offline after the first load, auto-updating when online (PWA).
- Future: accounts (not built now), game versions shown to players, new features.

## 3. Locked decisions

| Topic | Decision |
| --- | --- |
| Structure | npm-workspaces monorepo: apps/web, apps/server, packages/core, bot, protocol |
| Language | TypeScript, gradual: strict for new/shared code, legacy UI files converted as extracted |
| Engine | One shared implementation in packages/core for solo, versus, bots, replay, worker and server; parity-tested |
| Database | Selectable driver: SQLite (default, lightest) or PostgreSQL 18 |
| Compose | Base file runs the game alone; add-on files for PostgreSQL and monitoring |
| Monitoring | Prometheus + Grafana as optional add-on; built-in Telegram/Discord alerts and daily digest without Grafana |
| Identity | Anonymous random player ID, no IP storage; opt-out switch for analytics |
| Offline | Everything precached; bots run in a Web Worker (still offline); queued analytics sync later |
| Updates | Silent auto-update at a safe moment, no confirmation toast |
| Versioning | Never reset to 1.0.0; M1 = 1.3.0 (section 10) |
| License | Repo stays private for now; LICENSE placeholder (UNLICENSED); GPL-3.0 under consideration |
| Dropped | Daily challenge, Marathon, Zen, Cheese Race, public games counter |
| Deferred until accounts | Stats page, profile page, leaderboards |
| Deferred other | Guided Training mode (needs research) |
| Included extras | Improvements I1-I11, handling presets with settings import/export, first-run onboarding, UX consistency, keyboard/gamepad menu navigation, CSS cleanup (last) |

## 4. Audit of v1.2.0 (so it need not be redone)

- TetriZZ.html: 8,633 lines, 934 KB, CRLF line endings. Head, then two embedded minified libraries (qrcode-generator 1.4.4, jsQR 1.4.0, about 150 KB), CSS lines 43-1434 (141 KB, 340 `!important`, 62 `@media`), body markup, then one script of 7,089 lines (595 KB). Prettier alone makes it about 26,600 JS lines and 7,100 CSS lines.
- Extra files: sw.js, manifest.json, icon-192.png, icon-512.png.
- JS has 548 lines over 200 chars and 31 over 1,000. About 1,800 top-level names, 283 top-level `let/var`, about 140 `typeof x !== "undefined"` guards (code uses things declared later).
- Approximate script regions (script-relative lines): 1-1650 core engine, drawing, input; 1651-1939 touch and UI wiring; 1940-2033 logo; 2034-2524 versus stations; 2525-2889 10-wide bot (cc2\*); 2890-3169 4-wide bot (w\*); 3170-3499 rounds, match, end screens; 3500-3685 input, gamepad, touch editor; 3686-4853 online (Supabase, scheduler, LAN); 4854-5340 MQTT relay (misnamed p2p\*); 5341-6211 online lobby and sync; 6212-6925 replay; 6926-7089 init and install.
- Dead code: board-viewer functions bvOpen, bvClose, bvDraw, bvCellAt, bvPointerDown, bvPointerMove are declared twice (the second set wins, so about 55 lines never run). Unreferenced names (verify each): \_myReadyToggleAt, \_rejoinSettings, bzBrush, capDetectBoard, currentPracticeGrid, invalidatePanelUnit, loadScript, mqSendRelay, pieceBottom, rpLockBurst, snapCell, writePracticeGrid. CSS classes never mentioned in JS/HTML (verify): ghosty, m-sub, mc-vsbot, mm-desc, mm-dl, mp2, trpick, trpick-btn, vs-pips. PeerJS backend was removed but the P2P object and p2p\* names remain and now mean the MQTT relay.
- Duplication: the engine exists three times (solo movePiece/tryRotate/lockPiece, stations stMove/stRotate/stLock, bots botMove/botHardDrop); HUD helpers are duplicated (banner/stBanner, drawHold/drawStHold, and so on); bot evaluators cc2\* and w\* share the same skeleton. About 35 `netMode ===` branches.
- Risks to fix: 137 empty catch blocks; 57 innerHTML assignments with no shared escape helper (audit whether network-supplied text reaches them); hardcoded Supabase URL and publishable key (also in the CSP); sw.js precaches ./index.html but the file is TetriZZ.html; supabase-js@2, mqtt@5 and tetris-fumen load unpinned from a CDN; room passwords use a 32-bit client-side hash.
- Comments: about 120 in the JS, mostly banners, a few referring to past work. Strip all with a parser and rewrite.
- Modes: endless, ultra, sprint, wide (4-wide), practice, local, lan, online (versus vs bots uses mode id vsbot). About 25 localStorage keys named tetris\_\*. Online uses Supabase tables rooms and players, realtime table changes plus about 20 broadcast events, an MQTT relay, and LAN WebRTC with copy/QR.

## 5. Target architecture

```
tetrizz/
  apps/web/        Vite browser app: ui, render, input, audio, modes, practice, replay, net-client, storage, styles
  apps/server/     Fastify backend: http, websocket rooms, stats, db, metrics, jobs, notifier, config
  packages/core/   pure game logic (no DOM/Node): board, rotation, spin, scoring, garbage, bag, rng, replay codec
  packages/bot/    bot AI, runs in a Web Worker with in-thread fallback
  packages/protocol/ message types, zod schemas, PROTOCOL_VERSION
  deploy/          docker (compose files, Caddyfile, prometheus, grafana dashboards), vercel.json, cloudflare/_headers
  db/migrations/   sqlite/ and postgres/ plain SQL
  tests/           unit, e2e, visual, fixtures/legacy (saved data and replays from v1.2.0)
  docs/  scripts/  .github/
```

Rules: core imports nothing; bot imports only core; protocol imports nothing; apps import packages. A lint rule enforces this. Each extension point has one registry (modes, bot levels, themes, settings, sounds, screens, network messages, metrics, locales), documented in docs/EXTENDING.md. Docs to write: ARCHITECTURE, EXTENDING, NETWORKING, TESTING, PRIVACY, and the deployment guides (section 13). Repo files: README, CONTRIBUTING (setup, style, PR process), CHANGELOG, LICENSE placeholder, issue/PR templates, CI.

## 6. Tooling and versions (live-checked 7 Nov 2026; re-verify when starting)

| Area | Versions |
| --- | --- |
| Runtime | Node 26 LTS (engines >=22.13) |
| Build/test | Vite 8.3.6, vite-plugin-pwa 2.0.0 (Workbox 7.4.1), vite-plugin-singlefile 2.3.4, Vitest 5.1.0, Playwright 1.65.0 |
| Lint/format | ESLint 10.14.0, typescript-eslint 8.72.1, Prettier 3.9.10 |
| TypeScript | 6.0.3 (latest is 7.0.2 but typescript-eslint needs <6.1.0; move up when supported) |
| Server | Fastify 5.12.8, @fastify/websocket 11.3.7, @fastify/cors 11.4.1, @fastify/rate-limit 11.2.2, pino 10.4.0, prom-client 15.1.3, zod 4.6.7 (room passwords via node:crypto scrypt, Telegram/Discord via fetch, no extra dependency) |
| Database | better-sqlite3 13.0.3 (MIT, Node >=22), pg 8.23.1, node-pg-migrate 9.0.0, PostgreSQL 18 (19 is scheduled for 19 Nov 2026; stay on 18 until reviewed) |
| Client libs | qrcode-generator 2.0.4 (verify with a QR encode/decode round trip against jsqr), jsqr 1.4.0, tetris-fumen 1.1.3, mqtt 5.16.1, @supabase/supabase-js 2.119.0, idb 8.0.4 (offline queue), bowser 2.15.0 (MIT; server-side UA parsing), @fontsource packages 5.3.0 for Chakra Petch, IBM Plex Mono, Rubik Mono One |
| Avoid | ua-parser-js 2.x (AGPL-3.0); 1.x is MIT but old |
| Docker images | Caddy, Prometheus, Grafana, PostgreSQL tags to be looked up live when writing compose files (GitHub API was rate-limited when this plan was made) |

No Docker is installed in the sandbox: compose files cannot be run there. They are written carefully, YAML-validated, and shipped with a smoke-test checklist; the Node server is tested directly, SQLite adapter locally, PostgreSQL adapter against a locally installed PostgreSQL if the sandbox allows.

## 7. Verification (regression harness)

The original TetriZZ.html is the reference. Headless Chromium works in the sandbox (Python Playwright installed; npm Playwright 1.65 can be added). The sandbox has no internet, so the two Google Fonts requests fail in the original too; that is expected.

1. Visual: screenshots of every screen (menus, every mode start, options pages, controls, scores, replays, practice, board library, board viewer, capture, end screens, install popup), desktop and phone viewports, dark and light themes, pixel-diffed. Freeze Math.random, Date.now, performance.now and requestAnimationFrame so animations compare.
2. Behavioural: seeded scripted sessions in every offline mode (including bots, replay record and playback, session resume) record board, score and line traces; old and new must match exactly. Pure engine functions get old-vs-new parity tests on thousands of random inputs.
3. Data compatibility: all localStorage keys and shapes, and replay files exported by v1.2.0, must load in the new build (fixtures/legacy).
4. Each phase must pass before the next starts. Online, LAN WebRTC, camera capture, gamepad and real touch cannot be verified in the sandbox: move that code without logic changes, add mocked-transport tests, and give Noel a short manual checklist.

Harness tips from the analysis:

- Load the file via file:// and add init script `localStorage.setItem('tetris_ipop','1')` to skip the install popup.
- Solo: `selectMode('sprint'); hideAllOverlays(); startCountdown();` then wait for `state==='playing'`. Mode ids: endless, ultra, sprint, wide, practice, vsbot.
- Versus vs bots: set `localStorage.tetris_vsbot` to JSON like `{diff:10,pps:5,rounds:3,submode:'battle',autoPps:false,players:[{type:'user',dev:'key'},{type:'bot',dev:'key',diff:10,autoPps:false,pps:5},...]}`, then `selectMode('vsbot'); hideAllOverlays(); vsStartMatch();` and wait for `state==='playing'&&vsActive`. Read `MP.stations[i]` fields pieces, timeMs, lines, alive, isBot. (startCountdown alone does not start a versus match.)
- Profile with the Chrome DevTools Protocol: `Emulation.setCPUThrottlingRate`, `Profiler.start/stop`, plus a requestAnimationFrame frame-time recorder and a longtask PerformanceObserver.
- In the modular build expose a test-only hook (for example window.\_\_tz) because the original exposes everything as globals.
- Saving a replay from a short scripted game did not work in a quick attempt; investigate in Phase 0 and measure replay sizes.

Baseline performance (original, headless Chromium without GPU, CPU throttling approximates a slow phone, so treat as relative): 3 level-10 bots at 5 PPS: no throttle 28 fps, bots reach 4.2-4.4 PPS, bot thinking 44% of main-thread time; 4x throttle 6 fps, bots about 1.5 PPS, only about 4.5 s of game time per 14 s real; 6x throttle 4 fps, 0.9 PPS; 1 bot at 4x 6.4 fps, 1.3 PPS. Hot spots: cc2Drop, cc2Valid, cc2FindMoves, cc2H about 35% of main-thread time, garbage collection 9-15%.

## 8. Phases

| Phase | Work | Check |
| --- | --- | --- |
| 0 | Safety net: harness, golden traces and screenshots from the original, fixtures from v1.2.0 data and replays, replay-size measurement, performance baseline script | n/a |
| 1 | Monorepo scaffold, tooling, CI; unchanged code builds as multi-file and single-file | Identical |
| 2 | Prettier, delete confirmed dead code (check each name), strip all comments with a parser | Identical |
| 3 | Split CSS into files in the same cascade order; remove unused classes only after checking dynamic use | Identical |
| 4 | JS into modules via codemod, shared mutable state into state objects, remove typeof guards, typed event bus replacing the tz\* hook/intercept bus, rename p2p\* to relay, storage layer with schema version and migrations (I1), logger replacing the 137 silent catches (I2), security pass and escape helper (I3), TypeScript setup, version label on splash (see section 10) | Identical except the version label |
| 5 | packages/core: shared pure engine (collision, kicks, spin, scoring, garbage, line clear, bag), injectable RNG and clock (I6), merge cc2\*/w\* bot code, unify solo into the station model only if the harness proves it identical | Identical plus parity tests |
| 6 | Performance (section 9) | Targets, not exact traces (timing intentionally changes) |
| 7 | Network layer behind a Transport interface (Supabase, MQTT relay, LAN, new server transport), protocol package, config out of source (I4) | Identical |
| 8 | Server, database, retention, metrics, analytics, notifier, Docker, Grafana dashboards | Unit/integration tests, smoke-test checklist |
| 9 | Offline PWA, self-hosted fonts, update flow, deploy configs and CI deploy, service worker precache fix (I5) | Offline test |
| 10 | Handling presets and settings import/export, first-run onboarding, UX consistency (toasts, confirmations, per-section reset), keyboard and gamepad menu navigation, accessibility (I10), i18n string table (I11) | Visual diff review |
| 11 | New comments, docs, guides, README, CONTRIBUTING, license placeholder, CSS tokens and `!important` cleanup (screenshot-gated, no visual change) | Visual identical |
| 12 | Full verification, bundle sizes, delivery of repo zip and single file | Full run |

Optional later: shareable replays by link (data in the URL fragment, only after replays become seed plus inputs and small), short replay links (VPS only), accounts, profile and stats pages, leaderboards, guided Training mode.

## 9. Performance plan (Phase 6)

Causes found: bots think on the main thread in 3-16 ms slices per bot per frame; the loop caps dt at 50 ms so game time slows when frames are slow and bots get fewer thinking slices (they cannot reach their PPS); bot hot paths loop cell by cell and allocate arrays; every board canvas is fully redrawn each frame. Already good: sprite cache, DPR cap (2, or 1.25-1.5 on mobile in versus).

1. Fixed-timestep simulation separated from rendering, with a capped catch-up, so game time and bot PPS stay correct at low fps.
2. Bots in Web Workers, small pool sized by hardwareConcurrency (decide by benchmark), with an in-thread fallback using the same code.
3. Faster bot hot paths (precomputed column heights and piece tables, no per-call allocation), with a CI benchmark.
4. Redraw boards only when changed, using layered canvases; avoid per-frame allocations.
5. Adaptive quality: lower effects when frames are slow; consider disabling backdrop-filter on weak devices; in-app reduced-motion toggle.
6. Frame-time and bot-think metrics for debugging and (opt-out) telemetry by device class.

Single-file note: a classic (IIFE) Blob worker works from file:// in Chromium; a module worker does not. Build the worker as classic, inline it in the single file, and keep the in-thread fallback. The worker is part of the bundle, so it works fully offline.

## 10. PWA, updates and versioning

- Service worker precaches every file (JS, CSS, workers, icons, self-hosted fonts, lazy chunks) from a build-generated list; after the first online visit everything runs offline. Request persistent storage; recommend installing on iPhone because browsers may evict caches for rarely used sites.
- Update flow: check for a new version on launch and when returning to the foreground. Download in the background. When ready and the app is in a safe state (menu, not in a match, editor or online room), switch and reload automatically with a one-line updating notice; if busy, wait until the user returns to the menu. Never reload mid-match. No confirmation toast. Swap caches atomically and delete old ones.
- Version skew: clients send appVersion and PROTOCOL\_VERSION on connect; the server rejects incompatible clients with an upgrade-required code and the client triggers the update flow. Storage migrations key on a separate storage schema version, not the app version.
- Version: single source in the root package.json, injected at build, shown at the bottom of the splash screen (for example v1.3.0), sent with telemetry, in CHANGELOG.md and git tags. Installed PWAs update because sw.js or the precache list changes, not because of the version number, but never reset to 1.0.0 (it would look older than 1.2.0 to people and any code that compares versions). Plan: M1 1.3.0, M2 1.4.0, M3 1.5.0, M4 1.6.0; use 2.0.0 for the first breaking change (for example accounts or a save-format break).
- Single-file build: no service worker, manifest or install; update by replacing the file. Add a CI offline test: load, go offline, reload, play.

## 11. Server and data (Phase 8)

- Fastify with WebSocket. Replaces Supabase on VPS: room registry (list, create, join), presence, heartbeats, broadcast relay, host transfer, kick, server-side room password check (scrypt). It stays a relay; game logic stays in clients (the server can later validate using packages/core). Endpoints: /healthz, /readyz, /metrics (internal only), /api/v1/..., /ws, telemetry ingest. Rate limits (per IP in memory only), message size caps, zod validation, origin allowlist (including the file:// origin for the single-file build behind a dev flag), room and player caps.
- Database: DB\_DRIVER=sqlite|postgres behind one repository interface, SQL migrations per dialect, the same query tests run against both. SQLite: WAL mode, incremental vacuum. PostgreSQL: day/month partitions for raw events, drop old partitions.
- Tables: players (id, first\_seen, last\_seen, nullable account\_id, telemetry opt-out), player\_devices, sessions, games, game\_players, events (raw), daily\_stats, player\_daily, player\_history (append-only changes such as personal bests), rooms and room\_players (ephemeral), schema\_migrations. Everything under /api/v1.
- Retention (env vars): rooms and sessions removed on empty plus a janitor for stale heartbeats; raw events 30 days (RETENTION\_EVENTS\_DAYS); finished games 180 days then rolled up; nightly rollups kept forever; DB size budget (DB\_MAX\_MB) tightens retention when exceeded; alert at 80%; Docker json-file log rotation; Prometheus retention time and size limits; delete-by-player-ID endpoint.
- Persistence: bind mounts under ./data/{sqlite,postgres,prometheus,grafana,caddy}, never data inside containers; restart: unless-stopped. scripts/backup.sh nightly (SQLite online backup, PostgreSQL pg\_dump), 7 daily and 4 weekly copies, optional off-site copy (rclone guide); scripts/restore.sh; guide to move to another VPS: stop, backup, copy ./data and .env, compose up, switch DNS.
- Compose files: compose.yaml (Caddy + server + SQLite, the lightest), compose.postgres.yaml (adds PostgreSQL and sets the driver), compose.monitoring.yaml (Prometheus + Grafana + optional node exporter). Example: `docker compose -f compose.yaml -f compose.postgres.yaml -f compose.monitoring.yaml up -d`. Add .env.example, healthchecks, memory limits, non-root users, secrets via env.
- Rough typical RAM (not measured here; verify with docker stats): server 80-150 MB, Caddy 20-40 MB, SQLite about 0, PostgreSQL 100-250 MB, Prometheus 100-300 MB, Grafana 150-300 MB. So lite is roughly 150-250 MB (fits 512 MB), full with monitoring roughly 0.6-1.2 GB (2 GB comfortable). Monitoring is the heavy part; mitigations: longer scrape interval, short retention, memory limits, or skip it and use the Telegram digest.
- Grafana business dashboards read PostgreSQL directly. With SQLite, the server exports key totals as Prometheus gauges from its rollup tables, plus the Telegram digest and a CLI report; per-player SQL dashboards need PostgreSQL (or an extra Grafana plugin).

## 12. Identity, analytics, privacy, monitoring

- Players: random UUID created on first launch (migrate the existing tetris\_pid), stored in localStorage and mirrored in IndexedDB, persistent storage requested, included in the settings export so it can move between devices and browsers. It identifies an installation, not a person: clearing data or a new browser makes a new player (iOS home-screen apps have separate storage). Accounts later can claim anonymous IDs. IP address changes do not matter. No IP is stored (disable IP logging in Caddy and Fastify; use IP only in memory for rate limits).
- Device data (coarse, parsed on the server with bowser): device class (desktop, mobile, tablet), OS and version, browser and major version, engine, screen size bucket and DPR, CPU cores and device memory buckets, language, display mode (browser, installed PWA, single file), app version, Android model if available. Chromium: navigator.userAgentData getHighEntropyValues for real Android/Windows versions (the UA string is reduced). Safari/Firefox: parse the UA string (iOS version works; macOS shows 10\_15\_7; Windows 11 looks like 10 without UA-CH).
- Offline: local stats always work offline. Analytics events go to an IndexedDB queue (cap about 1 MB or 1,000 events, drop oldest performance samples first) with event UUID, occurredAt, sequence and session ID; flush on start, on the online event, on page hide (sendBeacon) and via Background Sync where available; the server dedupes by event ID, clamps clock skew using sentAt, and marks events recorded offline.
- Events: app\_start, session\_start/end, game\_start, game\_end (mode, duration, lines, score, PPS, APM, result, bot levels, player count), online\_room\_created/joined, match\_result, js\_error (hashed stack), perf\_sample (frame ms p50/p95, bot think ms), settings\_preset\_changed, install, update\_applied (from, to), offline flag.
- What it tells the owner: games played (all time/daily, by mode and device), daily/weekly/monthly active players, new vs returning, next-day and 7-day return, concurrent players and rooms by hour, per-player history, match stats, errors and reconnect reasons, ping p50/p95, CPU, memory, database growth, frame time by device class, abuse signals.
- Privacy: anonymous, opt-out switch in Options (nothing queued when off), PRIVACY.md, deletion by player ID. Not legal advice.
- Monitoring: pino JSON logs; /metrics with default process metrics plus game metrics (players online, rooms, games by mode, durations, messages/s, reconnects, ping, errors, DB size, job durations); Grafana dashboards as code (Overview, Live ops, Performance, Health). Alerts: Grafana contact points Telegram, Discord, email; plus a built-in notifier (TELEGRAM\_BOT\_TOKEN, TELEGRAM\_CHAT\_ID, Discord webhook) for disk/DB budget above 80%, error spikes, database failure, retention job failure, server restart, event-loop lag, and a daily digest, so it works without Grafana.

## 13. Deployment targets and guides

| Target | Notes |
| --- | --- |
| GitHub Pages | static PWA, relative base path, CI deploy workflow |
| Vercel | vercel.json: headers, sw.js and index.html no-cache, CSP |
| Cloudflare Pages | public/\_headers with the same rules |
| VPS + Docker | full stack above; client can also be hosted statically and point to the VPS (CORS, runtime config.json so one build serves any server) |

Guides in docs/deploy: github-pages, vercel, cloudflare-pages, vps-docker (lite, postgres, monitoring), backups-and-migration, retention, monitoring-and-alerts, updating-and-versioning. CSP generated per target; CDNs removed once libraries are bundled.

## 14. Improvements and features

Improvements I1-I11 all included: I1 storage layer (Phase 4), I2 logger (4), I3 security pass (4), I4 network config and self-hosting (7, 8), I5 service worker (9), I6 injectable RNG and clock (5), I7 types with TypeScript (4 onward), I8 bot worker (6), I9 render performance (6), I10 accessibility (10), I11 i18n strings (10).

Features included: handling presets (DAS/ARR/SDF) with import/export of all settings as a file, first-run onboarding (show the install dialog after the first finished game instead of over the main menu on first load), UX consistency (unified toasts, confirmation on every destructive action, per-section reset to defaults), keyboard and gamepad menu navigation, CSS design tokens and `!important` cleanup (last, screenshot-gated, no visual change).

## 15. Milestones and chat split

| Milestone | Phases | Version |
| --- | --- | --- |
| M1 GitHub-ready modular client | 0-5, 11 | 1.3.0 |
| M2 Performance and offline | 6, 9 | 1.4.0 |
| M3 Server, Docker, monitoring | 7, 8 | 1.5.0 |
| M4 Features and polish | 10, 12 | 1.6.0 |

Suggested chats: one for Phases 0-1, one for 2-3, one for 4, one for 5, one for 6, and so on, each starting from the repo zip plus docs/PROGRESS.md. Heavy phases (4, 5, 6, 8) may need their own chat.

## 16. Open items

- Noel's Galaxy S8+ browser and version (chrome://version or the browser's About page) to set the build target and test throttling.
- License choice (repo private until decided; GPL-3.0 under consideration; only the server-side gap and enforcement questions were discussed).
- Look up Docker image tags (Caddy, Prometheus, Grafana, PostgreSQL) live when writing compose files.
- Replay size measurement and the replay-saving harness step (Phase 0).
- Confirm later whether to build replay share links after deterministic replays exist.
