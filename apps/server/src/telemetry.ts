/**
 * Turns one uploaded batch (see `@tetrizz/protocol`'s telemetry module) into rows.
 *
 * The page's clock cannot be trusted, so every time in a batch is moved by the difference between
 * the server's clock when the request arrived and the page's clock when it was made (`sentAt`):
 * a phone whose clock is an hour off still lands its events in the right hour, and a batch that
 * waited offline for a day keeps the order of its events. A retry of the same batch moves by
 * nearly the same amount, and the ids make a second copy harmless anyway.
 *
 * Nothing here knows about HTTP; `api.ts` calls it.
 */
import Bowser from "bowser";
import {
  TELEMETRY_VERSION,
  type TelemetryAck,
  type TelemetryBatch,
  type TelemetryDevice,
} from "@tetrizz/protocol";
import { DAY_MS } from "./db/days";
import type { DeviceInfo, Repository } from "./db/types";

/** An event this much older than the server's clock at arrival counts as recorded offline. */
export const OFFLINE_LAG_MS = 5 * 60_000;

/** How far the page's clock is behind the server's (negative when it runs ahead). */
export function clockSkew(sentAt: number, receivedAt: number): number {
  return receivedAt - sentAt;
}

/**
 * Where a time the page reported belongs on the server's clock: moved by `skew`, never in the
 * future. `null` means it is older than `maxAgeMs` and is not worth keeping.
 */
export function correctTime(
  at: number,
  skew: number,
  receivedAt: number,
  maxAgeMs: number,
): number | null {
  const moved = at + skew;
  if (moved > receivedAt) return receivedAt;
  return receivedAt - moved > maxAgeMs ? null : moved;
}

const firstPart = (version: string | undefined, parts: number): string | undefined =>
  version === undefined ? undefined : version.split(".").slice(0, parts).join(".") || undefined;

/** What the `User-Agent` header says about the device, as coarsely as the plan allows. */
export function deviceFromUserAgent(userAgent: string | undefined): DeviceInfo | null {
  if (!userAgent || userAgent.length > 512) return null;
  let parsed: ReturnType<typeof Bowser.parse>;
  try {
    parsed = Bowser.parse(userAgent);
  } catch {
    return null;
  }
  const type = parsed.platform.type;
  const out: DeviceInfo = {
    deviceClass: type === "desktop" || type === "mobile" || type === "tablet" ? type : "unknown",
  };
  if (parsed.os.name) out.os = parsed.os.name.slice(0, 40);
  const osVersion = firstPart(parsed.os.version, 2);
  if (osVersion) out.osVersion = osVersion.slice(0, 40);
  if (parsed.browser.name) out.browser = parsed.browser.name.slice(0, 40);
  const browserVersion = firstPart(parsed.browser.version, 1);
  if (browserVersion) out.browserVersion = browserVersion.slice(0, 40);
  if (parsed.engine.name) out.engine = parsed.engine.name.slice(0, 40);
  return out;
}

/** The page's own description wins over the header where it gives a value (the header is reduced). */
export function mergeDevice(
  fromHeader: DeviceInfo | null,
  fromPage: TelemetryDevice | undefined,
): DeviceInfo | null {
  if (!fromHeader && !fromPage) return null;
  const merged: DeviceInfo = { ...(fromHeader ?? { deviceClass: "unknown" }) };
  if (fromPage) Object.assign(merged, fromPage);
  return merged;
}

export interface IngestOptions {
  /** The server's clock when the request arrived (milliseconds since the epoch). */
  receivedAt: number;
  userAgent?: string | undefined;
  /** Events older than this are dropped as stale. */
  eventsMaxAgeMs: number;
  gamesMaxAgeMs: number;
  /** Called for a player id the server has never seen; `false` refuses the batch. */
  admitNewPlayer?: () => boolean;
}

export type IngestOutcome = { kind: "stored"; ack: TelemetryAck } | { kind: "new-player-limit" };

const MAX_SESSION_AGE_FALLBACK = 400 * DAY_MS;

export async function ingestBatch(
  repo: Repository,
  batch: TelemetryBatch,
  rejected: number,
  options: IngestOptions,
): Promise<IngestOutcome> {
  const { receivedAt } = options;
  const ack: TelemetryAck = {
    v: TELEMETRY_VERSION,
    ok: true,
    stored: { events: 0, games: 0, history: 0 },
    duplicates: { events: 0, games: 0, history: 0 },
    rejected,
    stale: 0,
  };

  const known = await repo.getPlayer(batch.playerId);
  if (known?.telemetryOptOut) {
    ack.optedOut = true;
    return { kind: "stored", ack };
  }
  if (!known && options.admitNewPlayer && !options.admitNewPlayer()) {
    return { kind: "new-player-limit" };
  }

  const skew = clockSkew(batch.sentAt, receivedAt);
  const moved = (at: number, maxAge: number): number | null =>
    correctTime(at, skew, receivedAt, maxAge);

  const events = [];
  for (const e of batch.events) {
    const occurredAt = moved(e.at, options.eventsMaxAgeMs);
    if (occurredAt === null) {
      ack.stale++;
      continue;
    }
    events.push({
      id: e.id,
      playerId: batch.playerId,
      sessionId: e.sessionId ?? batch.session?.id ?? null,
      kind: e.kind,
      occurredAt,
      receivedAt,
      offline: e.offline === true || receivedAt - occurredAt > OFFLINE_LAG_MS,
      ...(e.payload !== undefined ? { payload: e.payload } : {}),
    });
  }

  // The earliest moment the player is known to have existed, for `firstSeen`.
  const seenTimes = events.map((e) => e.occurredAt);
  await repo.touchPlayer(batch.playerId, receivedAt);
  if (seenTimes.length) await repo.touchPlayer(batch.playerId, Math.min(...seenTimes));

  const device = mergeDevice(deviceFromUserAgent(options.userAgent), batch.device);
  if (device) await repo.recordDevice(batch.playerId, device, receivedAt);

  if (batch.session) {
    const s = batch.session;
    const startedAt = moved(s.startedAt, MAX_SESSION_AGE_FALLBACK);
    if (startedAt !== null) {
      await repo.startSession({
        id: s.id,
        playerId: batch.playerId,
        startedAt,
        appVersion: s.appVersion ?? null,
        displayMode: s.displayMode ?? device?.displayMode ?? null,
        deviceClass: s.deviceClass ?? device?.deviceClass ?? null,
        offline: s.offline === true || receivedAt - startedAt > OFFLINE_LAG_MS,
      });
      if (s.endedAt !== undefined) {
        const endedAt = moved(s.endedAt, MAX_SESSION_AGE_FALLBACK);
        if (endedAt !== null) await repo.endSession(s.id, Math.max(endedAt, startedAt));
      }
    }
  }

  for (const g of batch.games) {
    const startedAt = moved(g.startedAt, options.gamesMaxAgeMs);
    // Only the sender's own row is stored, so nobody can write results under another player's id.
    const own = g.players.filter((p) => p.playerId === batch.playerId);
    if (startedAt === null) {
      ack.stale++;
      continue;
    }
    if (own.length === 0) {
      ack.rejected++;
      continue;
    }
    ack.rejected += g.players.length - own.length;
    const isNew = await repo.recordGame({
      id: g.id,
      sessionId: g.sessionId ?? batch.session?.id ?? null,
      mode: g.mode,
      startedAt,
      durationMs: g.durationMs,
      bots: g.bots ?? 0,
      botLevel: g.botLevel ?? null,
      appVersion: g.appVersion ?? batch.session?.appVersion ?? null,
      deviceClass: g.deviceClass ?? device?.deviceClass ?? null,
      offline: g.offline === true || receivedAt - startedAt > OFFLINE_LAG_MS,
      players: own.map((p) => ({
        playerId: p.playerId,
        seat: p.seat ?? null,
        result: p.result,
        lines: p.lines,
        score: p.score,
        pieces: p.pieces,
        pps: p.pps ?? null,
        apm: p.apm ?? null,
      })),
    });
    if (isNew) ack.stored.games++;
    else ack.duplicates.games++;
  }

  if (events.length) {
    const added = await repo.insertEvents(events);
    ack.stored.events = added;
    ack.duplicates.events = events.length - added;
  }

  for (const h of batch.history) {
    const at = moved(h.at, MAX_SESSION_AGE_FALLBACK);
    if (at === null) {
      ack.stale++;
      continue;
    }
    const isNew = await repo.addHistory({
      id: h.id,
      playerId: batch.playerId,
      kind: h.kind,
      value: h.value ?? null,
      detail: h.detail ?? null,
      at,
    });
    if (isNew) ack.stored.history++;
    else ack.duplicates.history++;
  }

  return { kind: "stored", ack };
}
