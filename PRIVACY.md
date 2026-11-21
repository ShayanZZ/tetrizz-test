# Telemetry: what TetriZZ sends, and what it does not

TetriZZ can send anonymous usage statistics to its own game server. This only happens when the page is set up with a server that takes them (a copy with no server address sends nothing). The game does not show the player anything about it: no notice, no link to this file, nothing in Options. This file is the reference for whoever runs a server; if you host a copy, you are the one who collects this data.

## What is sent

- **Games.** Mode (endless, sprint, ultra, practice, versus and online variants), result, score, lines, pieces, pieces per second and attacks per minute, how long it lasted, how many bots and their level. A multiplayer match is one game with one row per human player; each player's page reports only its own row.
- **Device.** Type (phone, tablet, desktop), system and version, browser and version, screen size (rounded), pixel density, a rounded number of processor cores and memory, language, and whether the game runs in a browser tab, as an installed app or as a single file. On Android the model, when the browser says it.
- **Health of the game.** Frame speed samples, script errors (a short message with long tokens blanked, a file name and line without any path, a hash of the top of the stack), install and update of the app, room created or joined (and through which service), personal bests.
- **A random ID.** Made on your device (never from anything about you) and kept in its storage. The server only ever sees a value derived from a secret key that stays on your device, which is what stops anyone else from acting under your ID.
- **When.** Times of the above, and when a session started and last reported.

## What is not sent

Your name or nickname, e-mail address, IP address, location, what you type, room passwords, replays, saved boards, your settings and key bindings. The server does not store your IP address or log it; it uses the address in memory for rate limits only. The page does not use cookies for this and does not send cookies to the server.

## Controls that exist

- The page has no on-screen switch. A page whose browser storage holds `tetris_telemetry` = `off` notes nothing and sends nothing, not even a first message. The other browser checks in `tests/harness` use this.
- On the server, `PUT /api/v1/players/<id>/telemetry` opts a player out and `DELETE /api/v1/players/<id>` erases everything stored under the ID (games, events, sessions, device, history and the player's own daily numbers). Both need the player's key. The page's telemetry client can make both calls (`setEnabled`, `eraseMyData`); no screen uses them yet.

## How long the server keeps it

Raw events 30 days, games and sessions 180 days (the operator can change both). Daily totals without any player ID are kept for ever; your own daily numbers and personal bests are kept until you erase them.

## For operators

- A player who is opted out adds nothing, from any device that holds the same key.
- Players are not told or asked about this in the game. Whether that is enough depends on where your players are and on the rules there (for example, rules on identifiers kept on a device and on analytics); this file is not legal advice. If you need a notice, it belongs in the page, before `startPageTelemetry()` runs in `apps/web/src/boot/37-telemetry.ts`.
- Accounts do not exist yet. When they do, this file must say what is linked to them.
