/** Network message types and the wire-compatibility version. It imports nothing from the repo. */

export * from "./version";

/** Events carried inside an `ev` message, or sent as broadcast events on the other transports. */
export const NET_EVENTS = [
  "attack",
  "state",
  "gameover",
  "left",
  "unleft",
  "kick",
  "start",
  "progress",
  "roster",
  "settings",
  "host-xfer",
  "host-resume",
  "ping",
  "pong",
  "hb",
  "rejoin",
  "rejoin-req",
  "ready",
  "ready-flags",
  "lobby-ok",
  "game-active",
  "match-over",
  "closed",
] as const;

export type NetEventName = (typeof NET_EVENTS)[number];

/** Why a host refuses a join request. */
export type DenyReason = "pwd" | "full" | "version";

/** Settings the host shares with everyone in the room. */
export type RoomSettings = Record<string, unknown>;

/** Payloads whose shape is fixed by the sender; the others are passed on as they arrive. */
export interface NetEventPayloads {
  gameover: { sender: string; rnd: number };
  unleft: { sender: string };
  ready: { sender: string; ready: boolean };
  "rejoin-req": { sender: string };
  "host-xfer": { newHost: string; from: string };
  start: { seed: number; settings: RoomSettings; order: unknown };
  roster: { players: unknown[] };
  progress: { kind: "match"; winner: unknown } | { kind: "round"; round: number };
}

/** A guest asks the host for a seat. `v` is absent when the guest is a build without versions. */
export interface JoinMessage {
  t: "join";
  from: string;
  name: string;
  pwd?: string | null;
  v?: number;
}

/** The host accepts a guest and hands over the room. */
export interface AckMessage {
  t: "ack";
  to: string;
  hostId: string;
  roomId: string;
  seed: number;
  settings: RoomSettings;
  v?: number;
}

export interface DenyMessage {
  t: "deny";
  to: string;
  reason: DenyReason;
}

/** A game event relayed through the room topic. */
export interface EventMessage {
  t: "ev";
  from: string;
  event: NetEventName;
  payload: unknown;
}

export interface PingMessage {
  t: "ping";
  from: string;
}

export interface PresenceMessage {
  t: "presence";
  from: string;
  name: string;
  role: string;
}

export interface HostLeftMessage {
  t: "host-left";
  from: string;
  gen?: number;
}

export interface HostTransferMessage {
  t: "host-transfer";
  newHost: string;
  from: string;
}

export interface HostResumeMessage {
  t: "host-resume";
  from: string;
  gen: number;
}

export interface ByeMessage {
  t: "bye";
  from: string;
}

/** Everything that travels over the MQTT relay topics. */
export type RelayMessage =
  | JoinMessage
  | AckMessage
  | DenyMessage
  | EventMessage
  | PingMessage
  | PresenceMessage
  | HostLeftMessage
  | HostTransferMessage
  | HostResumeMessage
  | ByeMessage;

/** The first message a LAN guest sends over its data channel. */
export interface LanHelloMessage {
  t: "hello";
  id: string;
  name: string;
  v?: number;
}

/** A LAN or Supabase message as it is sent after the handshake. */
export interface BroadcastEnvelope {
  event: NetEventName;
  payload: unknown;
}

export * from "./transport";
export * from "./room";
export * from "./server";
export * from "./server-room";
export * from "./telemetry";
