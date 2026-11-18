# TetriZZ

A Tetris game with solo modes (Endless, Ultra, Sprint, 4-Wide), Practice, bots, local and online
versus, replays and a board library. It runs in the browser and is installable as an offline app.

The repository is private for now and is being restructured into a modular project; the game
plays exactly as v1.2.0 and only adds a version label to the main menu.

## Requirements

- Node.js 26 (LTS); `.nvmrc` pins it, anything from 22.13 upward works.
- For the regression harness: Python 3, `pip install -r tests/harness/requirements.txt`, then
  `python -m playwright install chromium`.

## Commands

| Command                                                               | What it does                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `npm install`                                                         | Installs every workspace.                                     |
| `npm run dev`                                                         | Starts the Vite dev server for the web app.                   |
| `npm run build`                                                       | Multi-file site in `apps/web/dist/`.                          |
| `npm run build:single`                                                | One self-contained file, `apps/web/dist-single/TetriZZ.html`. |
| `npm run build:all`                                                   | Both builds.                                                  |
| `npm test`                                                            | Unit tests (Vitest).                                          |
| `npm run lint`                                                        | ESLint, including the package dependency-direction rules.     |
| `npm run typecheck`                                                   | TypeScript in every workspace.                                |
| `npm run build -w @tetrizz/server`                                    | The server as one file, `apps/server/dist/index.js`.          |
| `npm start -w @tetrizz/server`                                        | Runs the built server (settings in `docs/SERVER.md`).         |
| `npm run format`                                                      | Prettier.                                                     |
| `npm run verify -- <build.html> [--part solo\|vs\|screens\|fixtures]` | Compares a build with the v1.2.0 recordings.                  |

## Deploying

The repository holds no server address or key. Online play takes its settings from build
environment variables; `docs/DEPLOYMENT.md` explains them and how to set up GitHub Pages, Vercel,
Cloudflare Pages and a server of your own (`docs/DOCKER.md` is the VPS guide).

## Layout

```
apps/web/         browser app (Vite); CSS in src/styles/, numbered in cascade order;
                  script in src/ (see below)
apps/server/      the own server (Fastify + WebSocket around the room model in packages/protocol); see docs/SERVER.md
packages/core/    pure game logic; imports nothing
packages/bot/     bot AI; imports only core
packages/protocol/ network message types, PROTOCOL_VERSION, the Transport interface and an in-memory transport
legacy/           the untouched v1.2.0 files, used as the reference
tests/            unit tests, regression harness, recordings, fixtures
docs/             PLAN.md (the refactor plan), PROGRESS.md (status log), DEPLOYMENT.md
```

The root `package.json` is the single source of the app version.

The stylesheets in `apps/web/src/styles/` are imported by `main.css` in file-number order. Later
files override earlier ones where selectors have equal specificity, so keep the order when moving
or adding rules.

## Script modules

`apps/web/src/main.ts` imports every module once and nothing else. Folders: `core/` (config, event
bus, logger, storage, escape helper, version), `engine/`, `render/`, `game/`, `input/`, `ui/`,
`practice/`, `versus/`, `bot/`, `net/`, `replay/`, `boot/` and `testing/`.

- Mutable state lives in per-module state objects (`game`, `configState`, `versusLobbyState`, ...).
  Other modules read and write properties on them; imported bindings cannot be reassigned.
- Modules define functions and constants and run nothing when loaded. Everything that used to run
  while the page loaded is in `boot/NN-*.ts`, and `main.ts` imports those files in numeric order.
  Keep that order when adding startup code.
- `core/events.ts`, `core/logger.ts`, `core/storage.ts`, `core/escape.ts` and `core/version.ts` are
  fully type-checked. The other modules carry a `@ts-nocheck` header and are converted file by file.
- Browser storage goes through `core/storage.ts`; a change to stored data needs a numbered migration
  there. Text from players, imported files or the network that reaches `innerHTML` must go through
  `escapeHtml`.
- Game rules live in `packages/core` as pure functions that take the board size (`Dims`) as an
  argument. `engine/engine.ts` adapts them to the live board size (`dims` in `core/config.ts`), so
  the solo game, the versus stations and the bots all use one implementation. Change a rule in
  core, and `tests/unit/core-parity.test.ts` shows whether it still agrees with v1.2.0.
- Randomness and time go through `core/random.ts` (`gameRandom` for play, `fxRandom` for looks and
  ids) and `core/clock.ts` (`clock.now()`, `clock.wall()`); do not call `Math.random()`,
  `performance.now()` or `Date.now()` directly. Tests replace them with `setGameRng`, `setFxRng`
  and `setClock`.
- One exception to "modules run nothing when loaded": `bot/bot-10wide.ts` and `bot/bot-4wide.ts` call
  `createBotOps(...)` once at load. It only builds functions and reads no state, and the function it
  calls is hoisted, so load order cannot break it.
- `testing/harness-hook.ts` exposes internals for the regression harness only when the harness has
  created `window.__h`.
- ES modules do not load from `file://`: open `dist/` through a web server. The harness serves it
  itself when given the directory. `dist-single/TetriZZ.html` still opens from disk.
