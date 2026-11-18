/** What a seat's `state` column holds, as far as the channel handlers read it. */
export interface SeatState {
  ready?: boolean;
  joined?: number;
  rejoined?: number;
  [key: string]: unknown;
}

/** One row of the `players` table. */
export interface SeatRowChange {
  id: string;
  username?: string;
  state?: SeatState | null;
}

/** One row of the `rooms` table. */
export interface RoomRowChange {
  host_id: string;
  settings?: Record<string, unknown> | null;
}

/** A change as supabase-js delivers it from `postgres_changes`. */
export interface RowChange<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new?: T | null;
  old?: Partial<T> | null;
}

/** The room facts the handlers read and update. The page's online session object fits it. */
export interface RoomChannelSession {
  myPlayerId: string;
  onlineRoomId: string | null;
  leavingRoom: boolean;
  isOnlineHost: boolean;
  onlineHostId: string | null;
  onlineJoinedRoomAt: number;
  onlineReadyFlags: Record<string, boolean>;
  isOnlineGame: boolean;
  isSpectator?: boolean;
  onlineGameActive: boolean;
  onlineLocalOrder: string[];
  onlineSeed: number;
  onlineRoomPwdH: string;
}

/** The match facts the handlers read and update. The versus lobby state fits it. */
export interface RoomChannelMatch {
  vsMatchOver: boolean;
  vsActive: boolean;
  vsRound: number;
  vsRoundT: ReturnType<typeof setTimeout> | undefined;
  vs: Record<string, unknown>;
}

export interface RoomChannelDeps {
  roomId: string;
  session: RoomChannelSession;
  match: RoomChannelMatch;
  /** The game's state name: `playing`, `countdown`, `vsround` and so on. */
  gameState(): string;
  now(): number;
  /** When this player last pressed READY, so that the echo of their own change is not applied. */
  lastReadyToggleAt(): number | undefined;
  later(task: () => void, ms: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout> | undefined): void;
  send(event: string, payload: unknown): void;
  rejoinPayload(playerId: string): unknown;
  forcedLeave(message: string): void;
  markLeft(playerId: string, message: string): void;
  refreshPlayers(): void;
  claimHost(departedId: string): void;
  deleteRoomIfEmpty(): void;
  renderLists(): void;
  note(message: string): void;
  /** The host decides how the round goes on (used after a host change in a round). */
  hostDecides(): void;
  /** Re-reads the lobby's rules after the host's settings changed. */
  applyRules(): void;
  startMatch(order: string[]): void;
}

export interface RoomChannelHandlers {
  onSeatChange(change: RowChange<SeatRowChange>): void;
  onRoomUpdate(change: RowChange<RoomRowChange>): void;
  onRoomDelete(): void;
  /** For `channel.subscribe`: once joined, asks the others for a rejoin for as long as it takes. */
  onStatus(status: string): void;
}

/** The deletion of my own seat this soon after joining is not treated as a kick. */
const JUST_JOINED_MS = 8000;
const ROUND_RESUME_DELAY_MS = 800;
const REJOIN_WINDOW_MS = 10000;
const MATCH_START_FRESH_MS = 20000;
const REJOIN_FIRST_MS = 700;
const REJOIN_RETRY_MS = 1500;
const REJOIN_MAX_TRIES = 8;
const READY_ECHO_MS = 2500;

const IN_ROUND = new Set(["playing", "countdown", "vsround"]);

export function createRoomChannelHandlers(deps: RoomChannelDeps): RoomChannelHandlers {
  const { session, match } = deps;
  const inRound = () => IN_ROUND.has(deps.gameState());

  function onSeatDeleted(old: Partial<SeatRowChange>) {
    if (old.id === session.myPlayerId) {
      if (session.leavingRoom || !session.onlineRoomId) return;
      if (session.isOnlineHost) return;
      if (session.onlineJoinedRoomAt && deps.now() - session.onlineJoinedRoomAt < JUST_JOINED_MS)
        return;
      deps.forcedLeave("You were kicked from the room.");
      return;
    }
    deps.markLeft(old.id as string, (old.username || "PLAYER") + " LEFT");
    deps.refreshPlayers();
    if (old.id === session.onlineHostId) deps.claimHost(old.id as string);
    deps.deleteRoomIfEmpty();
  }

  function onSeatChange(change: RowChange<SeatRowChange>) {
    if (change.eventType === "DELETE" && change.old) {
      onSeatDeleted(change.old);
      return;
    }
    const row = change.new;
    if (change.eventType === "UPDATE" && row && row.state && typeof row.state.ready === "boolean") {
      const echoOfMyOwnChange =
        row.id === session.myPlayerId &&
        deps.lastReadyToggleAt() &&
        deps.now() - (deps.lastReadyToggleAt() as number) < READY_ECHO_MS;
      if (!echoOfMyOwnChange) session.onlineReadyFlags[row.id] = row.state.ready;
    } else if (
      change.eventType === "INSERT" &&
      row &&
      session.isOnlineGame &&
      !match.vsMatchOver &&
      row.id !== session.myPlayerId &&
      inRound() &&
      session.onlineLocalOrder.indexOf(row.id) >= 0
    ) {
      deps.send("rejoin", deps.rejoinPayload(row.id));
    } else if (
      change.eventType === "UPDATE" &&
      row &&
      session.isOnlineGame &&
      !match.vsMatchOver &&
      row.id !== session.myPlayerId &&
      inRound() &&
      session.onlineLocalOrder.indexOf(row.id) >= 0
    ) {
      const at =
        row.state &&
        (typeof row.state.rejoined === "number" ? row.state.rejoined : row.state.joined);
      if (at && deps.now() - at < REJOIN_WINDOW_MS) {
        deps.send("rejoin", deps.rejoinPayload(row.id));
      }
    } else if (
      change.eventType === "INSERT" &&
      row &&
      row.id !== session.myPlayerId &&
      (session.isOnlineGame || match.vsActive) &&
      !match.vsMatchOver &&
      session.onlineLocalOrder.indexOf(row.id) < 0 &&
      inRound()
    ) {
      deps.send("game-active", {
        sender: session.myPlayerId,
        seed: session.onlineSeed,
        order: session.onlineLocalOrder,
        round: match.vsRound,
      });
    }
    deps.refreshPlayers();
  }

  function onRoomUpdate(change: RowChange<RoomRowChange>) {
    const row = change.new;
    if (!row) return;
    const wasHost = session.isOnlineHost;
    session.onlineHostId = row.host_id;
    session.isOnlineHost = session.onlineHostId === session.myPlayerId;
    if (session.isOnlineHost) {
      if (!wasHost) deps.note("You are now the HOST");
      deps.renderLists();
      if (deps.gameState() === "vsround" && !match.vsMatchOver) {
        deps.cancel(match.vsRoundT);
        match.vsRoundT = deps.later(deps.hostDecides, ROUND_RESUME_DELAY_MS);
      }
      return;
    }
    const rules = (row.settings || {}) as Record<string, unknown> & {
      seed?: number;
      pwdH?: unknown;
      st?: { order?: unknown; ts?: number; seed?: number };
    };
    for (const key in rules) {
      if (key !== "seed" && key !== "players" && key !== "pwd" && key !== "pwdH")
        match.vs[key] = rules[key];
    }
    if (rules.seed) session.onlineSeed = rules.seed;
    if (typeof rules.pwdH === "string") session.onlineRoomPwdH = rules.pwdH;
    deps.applyRules();
    deps.renderLists();
    const start = rules.st;
    if (
      start &&
      Array.isArray(start.order) &&
      !session.isOnlineGame &&
      deps.now() - (start.ts || 0) < MATCH_START_FRESH_MS
    ) {
      if (start.seed) session.onlineSeed = start.seed;
      const order = start.order as string[];
      if (
        order.indexOf(session.myPlayerId) >= 0 ||
        (session.isSpectator !== undefined && session.isSpectator)
      ) {
        deps.startMatch(order);
      } else {
        session.onlineGameActive = true;
        deps.renderLists();
      }
    }
  }

  function onRoomDelete() {
    if (session.leavingRoom || !session.onlineRoomId) return;
    deps.forcedLeave("The room was closed (expired or empty).");
  }

  let chained = false;
  function onStatus(status: string) {
    if (status !== "SUBSCRIBED" || chained) return;
    chained = true;
    let tries = 0;
    const ask = () => {
      if (!session.onlineRoomId || session.isOnlineGame || session.isSpectator) return;
      if (tries >= REJOIN_MAX_TRIES) return;
      tries++;
      deps.send("rejoin-req", { sender: session.myPlayerId });
      deps.later(() => {
        if (!session.isOnlineGame && !session.isSpectator && session.onlineRoomId) ask();
      }, REJOIN_RETRY_MS);
    };
    deps.later(ask, REJOIN_FIRST_MS);
  }

  return { onSeatChange, onRoomUpdate, onRoomDelete, onStatus };
}

/** The part of a supabase-js realtime channel that listens to table changes. */
export interface RowChannelLike {
  on(
    type: "postgres_changes",
    filter: { event: string; schema: string; table: string; filter: string },
    callback: (change: never) => void,
  ): RowChannelLike;
}

/**
 * Listens to the room's seats (every change), to its row being updated (host and rules) and to
 * its row being deleted. Call it before the broadcast listeners are added and before `subscribe`.
 */
export function listenToRoomRows<T extends RowChannelLike>(
  channel: T,
  roomId: string,
  handlers: RoomChannelHandlers,
): T {
  return channel
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "players", filter: "room_id=eq." + roomId },
      handlers.onSeatChange as (change: never) => void,
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "rooms", filter: "id=eq." + roomId },
      handlers.onRoomUpdate as (change: never) => void,
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "rooms", filter: "id=eq." + roomId },
      handlers.onRoomDelete as (change: never) => void,
    ) as T;
}
