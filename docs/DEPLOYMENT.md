# Deploying TetriZZ

TetriZZ is a static site: `npm run build` writes it to `apps/web/dist/`. The repository holds no
server address and no key. Everything online play connects to comes from settings you give the
build, so the same public repository can be deployed by anyone to their own accounts.

## Where to host it

| Host                          | What you need                                          | Files in this repository that it uses                     |
| ----------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| GitHub Pages                  | A public repository (or a paid plan for a private one) | `.github/workflows/pages.yml`                             |
| Vercel                        | The repository imported into a Vercel project          | `vercel.json`                                             |
| Cloudflare Pages              | The repository connected to a Pages project            | `deploy/cloudflare/_headers` (optional)                   |
| Your own VPS (Docker Compose) | A machine with Docker, and a domain name for HTTPS     | `Dockerfile`, `compose*.yaml`, `deploy/`; see `DOCKER.md` |

The first three publish only the page; online play then uses the public relay, Supabase or a
server of your own (see "A static host plus your own server" below). The VPS stack serves the page
and the room server from one address and needs no build settings at all.

## What each setting does

All settings are optional. Set them as environment variables of the build (a hosting dashboard, or
a `.env.local` file on your machine).

| Variable               | Meaning                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `TETRIZZ_SUPABASE_URL` | Your Supabase project address, for example `https://abcdefgh.supabase.co`.                                                     |
| `TETRIZZ_SUPABASE_KEY` | That project's **publishable** key (also called the anon key). Never a secret or service-role key.                             |
| `TETRIZZ_SERVER_URL`   | Your own TetriZZ server, for a site hosted somewhere other than the server. Not needed when the server serves the page itself. |
| `TETRIZZ_MQTT_BROKERS` | Comma-separated `wss://` broker addresses replacing the three public ones, or `off` for none.                                  |

Supabase is used only when **both** its variables are set. With none of them set the game still
works: online rooms use the public MQTT relay, and LAN play needs no setup at all.

Which backend online play uses:

1. **Auto** (default): your own server if there is one, then Supabase if configured, then the
   public relay. Each is the fallback for the one before it.
2. A player can pick one backend (own server, Supabase or relay) to try first; the others stay as
   fallbacks. This works on a server build too, so the earlier methods are never taken away.

The pick is in Options, under Online, row SERVER: AUTO, then each backend that is configured and
can be used. It is hidden while there is only one backend (a build without Supabase). The lobby tries
the backends in that order for creating and for joining a room. The own server is `apps/server`
(`docs/SERVER.md`); a build that names no server skips it.

## What is and is not private

The values are written into the built page, so **anyone who opens the deployed site can read
them** in the browser's developer tools. Keeping them out of the repository keeps them out of
search results, forks and the git history; it does not hide them from visitors, and nothing can.
A publishable key is designed for this. What protects your data is the Row Level Security policies
on your Supabase tables, so check that every table the game uses (`rooms` and `players`) has RLS
turned on with policies that allow only what the game needs. Never put a service-role or secret
key in any `TETRIZZ_` variable.

## Local development

Copy `.env.example` to `.env.local` and fill in what you need. `.env.local` is ignored by git.
`npm run dev`, `npm run build` and `npm run build:single` all read it.

## GitHub Pages

1. The repository must be public (GitHub Free) or on a plan that includes Pages for private ones.
2. Settings, Pages, Build and deployment, Source: **GitHub Actions**.
3. Optional: Settings, Secrets and variables, Actions, tab **Variables**: add the settings above
   (`TETRIZZ_SUPABASE_URL`, `TETRIZZ_SUPABASE_KEY`, `TETRIZZ_SERVER_URL`, `TETRIZZ_MQTT_BROKERS`).
   They are variables, not secrets: they are written into the page whatever you call them, and a
   variable that does not exist counts as not set.
4. Push to `main`, or Actions, Deploy to GitHub Pages, Run workflow. The site appears at
   `https://<user>.github.io/<repository>/`. A custom domain is set under Settings, Pages.

The workflow (`.github/workflows/pages.yml`) installs with `npm ci`, builds with the Node version in
`.nvmrc` and publishes `apps/web/dist`. Things to know:

- The page uses relative addresses, so the sub-path of a project site works. This was checked by
  serving the build under `/TetriZZ/` and opening it in Chromium: the service worker's scope was
  that folder and no request failed (the missing `config.json` is a 404 and is expected).
- Pages sends every file with `Cache-Control: max-age=600` and the headers cannot be changed. A
  new version can therefore take up to ten minutes to reach a browser that visited shortly before.
  Nothing else is affected; the security headers of the other hosts are not sent (the page's own
  Content Security Policy still applies).
- The workflow does not run the tests, `CI` does. Require `CI` to pass on `main` (Settings,
  Branches) if a broken commit must never be published, or delete the `push` trigger from the
  workflow and publish by hand with Run workflow.

## Vercel

1. Import the GitHub repository. `vercel.json` in the repository root already holds the install
   command (`npm ci`), the build command (`npm run build`), the output directory (`apps/web/dist`),
   "no framework" and the response headers, so the screens that ask for them need no changes.
2. Settings, Environment Variables: add the settings above. Each one is scoped to Production,
   Preview and Development; a variable scoped only to Production is not set in preview deployments,
   which then fall back to the relay. Tick Preview too if previews should use Supabase.
3. Deploy. Variables only reach a build made after they were saved, so redeploy after any change.

Node: leave the project's Node.js Version alone. Vercel reads `engines.node` from `package.json`
(`>=22.13`) before the project setting and picks the newest major it offers that fits; its
documentation lists 26.x as the default, the same line `.nvmrc` pins. `.nvmrc` itself is not read
by Vercel.

## Cloudflare Pages

1. Workers & Pages, create a Pages project from the GitHub repository.
2. Build command `npm run build && cp deploy/cloudflare/_headers apps/web/dist/_headers`, build
   output directory `apps/web/dist`, root directory empty. The `cp` adds the same security headers
   and caching rules as the other hosts; plain `npm run build` also works and leaves the defaults.
3. Settings, Environment variables: add the settings above, separately for Production and
   Preview. Cloudflare's variables are read by the build, which is what is needed here.
4. Retry the deployment after changing a variable.

Node: Pages' build image defaults to Node 22.16.0 (Cloudflare's documentation) and reads the
version from `.nvmrc` or `.node-version` in the repository, or from a `NODE_VERSION` variable. This
repository's `.nvmrc` says 26, so no setting is needed. Build system v3 does **not** read
`engines` in `package.json` and does not accept names such as `lts/*`; give a number.

## A VPS with the Docker stack

`docs/DOCKER.md` is the guide. In short: one machine, `docker compose up -d`, a domain name in
`.env`, and Caddy serves the page, `/ws`, `/api/v1` and a `config.json` that points the page at its
own address, so nothing has to be built into the page and none of the `TETRIZZ_` variables apply.
Supabase or other relay brokers can be added to that `config.json` (see the comment in
`deploy/Caddyfile`).

## A static host plus your own server

A page on GitHub Pages, Vercel or Cloudflare Pages can use a room server on a VPS:

1. Run the stack from `docs/DOCKER.md` on the VPS with a domain of its own, for example
   `SITE_ADDRESS=play-api.example.org`. It also serves a copy of the page there, which you can ignore.
2. In its `server.env` allow the static site's origin: `ALLOWED_ORIGINS=https://play.example.org`
   (scheme and host, no path, no trailing slash). A socket from any other origin gets a 403.
3. Give the static site's build the server's address, without a path:
   `TETRIZZ_SERVER_URL=https://play-api.example.org`. The page adds `/ws` and uses `wss://`. It has
   to be a build setting because the page's Content Security Policy only lists hosts the build knew.
4. Redeploy the static site. Online rooms now try the server first and fall back to Supabase and
   the relay if it is unreachable.

## Moving a site that is already live

The live page currently has the Supabase address and key written into it. Before the first deploy
of the new code, set the two Supabase variables in the dashboard. If you forget, the new build
deploys fine but has no Supabase, so online rooms quietly use the relay.

If the key was ever committed to a repository that is now public, treat it as published: either
start the public repository from a fresh history (a new `git init` on this tree has no key in it),
or create a new publishable key for the project, put it in the variables and revoke the old one.
Nothing in this tree contains the old key any more, including `legacy/`.

### Updating a live site while the refactor continues

The current build can replace a live v1.2.0 site; later phases only add to it.

- **Deploy the multi-file build** (`apps/web/dist`, what `npm run build` makes and what Vercel and
  Cloudflare Pages publish). It is the same set of files as before (page, `sw.js`, `manifest.json`,
  icons) plus an `assets/` folder. Keep the single-file build (`apps/web/dist-single/TetriZZ.html`)
  for quick tests: it has no service worker, manifest or icons, so replacing a live site with it
  would remove offline play and the install button.
- **Online play keeps working only if the two Supabase variables are set for the build** (see
  above). Without them rooms use the public relay.
- **Players keep their data.** The page stays on the same address, so saved options, scores, boards
  and replays stay in the browser. The recorded profile check covers all stored keys.
- **Installed apps and open tabs update themselves.** The page is fetched from the network first and
  the new service worker takes over at once, so players see the new version on their next open (a
  tab that is already open needs one reload).
- **Old and new versions can share a room.** Join and acknowledgement messages carry a protocol
  version; a message without one counts as version 1, which is what every earlier build speaks. Only
  a future protocol break will refuse to mix versions, and the player then sees a message asking
  them to reload.
- **Not covered by the automated checks:** a real Supabase project or public relay from a real
  host, the LAN screens, camera capture and gamepads. After deploying, create a room on one device
  and join it from another, and play one practice game on a phone.

## Settings in `config.json`

The server in `apps/server` (see `docs/SERVER.md`) serves the socket at `/ws`, the telemetry API and
the health endpoints; the page and a `config.json` beside it come from a static host (Caddy in the
VPS setup).
The page reads that file once when it starts and lays it over the build's settings, so one build
can run against any server and no rebuild is needed to point it elsewhere. Anything not in the file
keeps the build's value:

```json
{
  "server": { "url": "/" },
  "supabase": null,
  "mqttBrokers": ["wss://mqtt.example.org:8084/mqtt"]
}
```

- `server.url` is a full `http(s)` or `ws(s)` address, or a path on the page's own origin. The page
  adds the socket path `/ws` itself, so leave it out: `/` means the page's own address,
  `https://play.example.org` another host.
- `supabase`: `null` turns it off; an object needs `url` and `anonKey`, both valid.
- A part that is present but invalid is dropped whole, so a typo never leaves half an address.
- A server on another origin than the page must also be in `TETRIZZ_SERVER_URL` at build time,
  because the page's Content Security Policy only lists the hosts the build knew about. A server
  reached through the page's own host (a reverse proxy that forwards `/ws`) needs nothing extra. The
  server must also allow the page's origin (`ALLOWED_ORIGINS`), unless it is the same host.

`config.json` is never cached by the service worker. It is not read by the single-file build when
opened from disk (`file://`), which uses the build's settings only.
