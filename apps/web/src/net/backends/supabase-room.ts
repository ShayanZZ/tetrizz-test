import type { JoinRoomResult, RoomBackend, Transport } from "@tetrizz/protocol";

/** One row of a Supabase result. */
export interface SeatRow {
  id: string;
  state?: { role?: string; joined?: number; [key: string]: unknown } | null;
  last_active?: string | null;
}

export interface SbResult<T = unknown> {
  data?: T | null;
  error?: unknown;
}

/** A supabase-js query: filters chain, and awaiting it runs it. */
export interface SbQuery<T = unknown> extends PromiseLike<SbResult<T>> {
  eq(column: string, value: unknown): SbQuery<T>;
  neq(column: string, value: unknown): SbQuery<T>;
  maybeSingle(): PromiseLike<SbResult<T>>;
}

/** A room row as `select("host_id,settings")` returns it. */
export interface RoomRow {
  host_id: string;
  settings?: Record<string, unknown> | null;
}

export interface SbTable {
  select<T = SeatRow[]>(columns: string): SbQuery<T>;
  insert(values: Record<string, unknown>): PromiseLike<SbResult>;
  upsert(values: Record<string, unknown>, options?: { onConflict: string }): PromiseLike<SbResult>;
  delete(): SbQuery;
  update(values: Record<string, unknown>): SbQuery;
}

/** The part of the supabase-js client the room code uses. */
export interface SupabaseClientLike {
  from(table: string): SbTable;
  removeChannel(channel: unknown): unknown;
}

export interface SupabaseRoomDeps {
  transport: Transport;
  client(): SupabaseClientLike | null | undefined;
  /** Wall-clock milliseconds, for deciding which seats are still alive. */
  now(): number;
  /** The timestamp written to `last_active`. */
  isoNow(): string;
  debug(scope: string, error: unknown): void;
  /** Reported to the console by default: a join that got as far as writing the seat and failed. */
  warn(scope: string, error: unknown): void;
}

/** A room seats this many players; anyone after them joins as a spectator. */
export const ROOM_PLAYER_LIMIT = 4;

/** True when the row was active within `minutes`; a row with no timestamp counts as fresh. */
export function rowIsFresh(
  row: { last_active?: string | null } | null | undefined,
  minutes: number,
  nowMs: number,
): boolean {
  const t = row && row.last_active ? Date.parse(row.last_active) : 0;
  if (!t) return true;
  return nowMs - t < (minutes || 10) * 60000;
}

const joinedOf = (row: SeatRow): number => (row.state && row.state.joined) || 0;

export function createSupabaseRoom(deps: SupabaseRoomDeps): RoomBackend {
  return {
    kind: "supabase",
    transport: deps.transport,
    async create(request) {
      const sb = deps.client();
      if (!sb) return { ok: false, reason: "unavailable" };
      try {
        const { error: roomError } = await sb.from("rooms").insert({
          id: request.roomId,
          host_id: request.myId,
          settings: request.settings,
          last_active: deps.isoNow(),
        });
        if (roomError) return { ok: false, reason: "failed" };
        const { error: seatError } = await sb.from("players").upsert(
          {
            id: request.myId,
            room_id: request.roomId,
            username: request.myName,
            state: { role: "player", joined: request.now },
          },
          { onConflict: "id" },
        );
        if (seatError) return { ok: false, reason: "failed" };
        return { ok: true, roomId: request.roomId, hostId: request.myId };
      } catch (error) {
        deps.debug("net/backends/supabase-room.create", error);
        return { ok: false, reason: "failed" };
      }
    },
    async join(request): Promise<JoinRoomResult> {
      const sb = deps.client();
      if (!sb) return { ok: false, reason: "unavailable" };
      const roomId = request.roomId;
      try {
        const { data: room, error } = await sb
          .from("rooms")
          .select<RoomRow>("host_id,settings")
          .eq("id", roomId)
          .maybeSingle();
        if (error || !room) return { ok: false, reason: "not-found" };
        const settings = room.settings || {};
        const pwdH = typeof settings.pwdH === "string" ? settings.pwdH : "";
        if (pwdH && !request.passwordChecked) return { ok: false, reason: "password", pwdH };
        const { data: seated } = await sb.from("players").select("id,state").eq("room_id", roomId);
        const rows = seated || [];
        const players = rows.filter((row) => !(row.state && row.state.role === "spec")).length;
        const mine = rows.find((row) => row.id === request.myId);
        const joined = mine && mine.state && mine.state.joined ? mine.state.joined : request.now;
        const role =
          mine && mine.state && mine.state.role
            ? mine.state.role
            : players < ROOM_PLAYER_LIMIT
              ? "player"
              : "spec";
        const { error: seatError } = await sb.from("players").upsert(
          {
            id: request.myId,
            room_id: roomId,
            username: request.myName,
            state: { role, joined, rejoined: request.now },
          },
          { onConflict: "id" },
        );
        if (seatError) {
          deps.warn("net/backends/supabase-room.join", seatError);
          return { ok: false, reason: "failed" };
        }
        return {
          ok: true,
          roomId,
          hostId: room.host_id,
          isHost: room.host_id === request.myId,
          seed: typeof settings.seed === "number" ? settings.seed : 0,
          settings,
        };
      } catch (error) {
        deps.warn("net/backends/supabase-room.join", error);
        return { ok: false, reason: "failed" };
      }
    },
    async leave(request) {
      const sb = deps.client();
      if (!(request.roomId && sb)) return;
      const roomId = request.roomId;
      if (request.announce) {
        deps.transport.send("left", { sender: request.myId, name: request.myName });
      }
      try {
        const { data: rest } = await sb
          .from("players")
          .select("id,state,last_active")
          .eq("room_id", roomId)
          .neq("id", request.myId);
        await sb.from("players").delete().eq("id", request.myId);
        const rows = (rest || []).slice().sort((a, b) => joinedOf(a) - joinedOf(b));
        const live = rows.filter((r) => rowIsFresh(r, 10, deps.now()));
        if (request.isHost) {
          const next = live.find((r) => !(r.state && r.state.role === "spec")) || live[0] || null;
          if (next)
            await sb
              .from("rooms")
              .update({ host_id: next.id, last_active: deps.isoNow() })
              .eq("id", roomId);
        }
        if (!rows.filter((r) => rowIsFresh(r, 60, deps.now())).length)
          await sb.from("rooms").delete().eq("id", roomId);
      } catch (error) {
        deps.debug("net/backends/supabase-room.leave", error);
      }
      deps.transport.close();
    },
    drop(request) {
      const sb = deps.client();
      if (request.roomId && sb) {
        try {
          sb.from("players")
            .delete()
            .eq("id", request.myId)
            .then(() => {});
        } catch (error) {
          deps.debug("net/backends/supabase-room.drop", error);
        }
      }
      deps.transport.close();
    },
    setHost(request) {
      const sb = deps.client();
      if (!sb) return;
      try {
        sb.from("rooms")
          .update({ host_id: request.newHost })
          .eq("id", request.roomId)
          .then(() => {});
      } catch (error) {
        deps.debug("net/backends/supabase-room.setHost", error);
      }
    },
    saveMyState(request) {
      const sb = deps.client();
      if (!sb) return;
      try {
        sb.from("players")
          .update({ state: request.state })
          .eq("id", request.myId)
          .then(() => {});
      } catch (error) {
        deps.debug("net/backends/supabase-room.saveMyState", error);
      }
    },
    kick(request) {
      const sb = deps.client();
      if (!sb) return;
      try {
        sb.from("players")
          .delete()
          .eq("id", request.targetId)
          .then(() => {});
      } catch (error) {
        deps.debug("net/backends/supabase-room.kick", error);
      }
    },
  };
}
