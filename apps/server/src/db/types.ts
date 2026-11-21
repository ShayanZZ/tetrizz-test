/**
 * The database as the rest of the server sees it: one interface with two implementations (SQLite
 * and PostgreSQL) that run the same SQL. The same tests run against both.
 *
 * Times are milliseconds since the Unix epoch. A "day" is a UTC date written `YYYY-MM-DD`. Every
 * write that can be repeated (a page that did not hear the answer sends the same thing again) is
 * idempotent: it is keyed by an id the page made up, and a second copy changes nothing.
 */

export type DriverName = "sqlite" | "postgres";

export interface PlayerRecord {
  id: string;
  firstSeen: number;
  lastSeen: number;
  accountId: string | null;
  telemetryOptOut: boolean;
}

/** Coarse facts about a device; nothing here identifies a person. */
export interface DeviceInfo {
  deviceClass: "desktop" | "mobile" | "tablet" | "unknown";
  os?: string;
  osVersion?: string;
  browser?: string;
  browserVersion?: string;
  engine?: string;
  /** A size bucket such as `360x800`, not the exact screen. */
  screen?: string;
  dpr?: number;
  cores?: number;
  memoryGb?: number;
  language?: string;
  displayMode?: "browser" | "pwa" | "single-file";
  model?: string;
}

export interface DeviceRecord {
  fingerprint: string;
  device: DeviceInfo;
  firstSeen: number;
  lastSeen: number;
}

export interface SessionInput {
  id: string;
  playerId: string;
  startedAt: number;
  appVersion?: string | null;
  displayMode?: string | null;
  deviceClass?: string | null;
  offline?: boolean;
}

export interface SessionRecord {
  id: string;
  playerId: string;
  startedAt: number;
  endedAt: number | null;
  appVersion: string | null;
  displayMode: string | null;
  deviceClass: string | null;
  offline: boolean;
}

export type GameResult = "win" | "loss" | "draw" | "finished" | "quit";

export interface GamePlayerInput {
  playerId: string;
  seat?: number | null;
  result: GameResult;
  lines: number;
  score: number;
  pieces: number;
  pps?: number | null;
  apm?: number | null;
}

/** A finished game. Bots are counted, not stored as players. */
export interface GameInput {
  id: string;
  sessionId?: string | null;
  mode: string;
  startedAt: number;
  durationMs: number;
  bots?: number;
  botLevel?: number | null;
  appVersion?: string | null;
  deviceClass?: string | null;
  offline?: boolean;
  players: GamePlayerInput[];
}

/**
 * What a later report may do to a game that already exists: add the reporting player's own rows.
 * Several pages report one match, each with the same game id and only its own row.
 */
export interface GameJoinRules {
  /** The later report must have the same mode and start within this many milliseconds. */
  windowMs: number;
  /** A game never holds more rows than this. */
  maxPlayers: number;
}

/**
 * `created`: a new game. `joined`: the game existed and at least one row was added to it.
 * `duplicate`: nothing new (every row was already stored). `refused`: the game exists but the report
 * does not belong to it (other mode, start too far apart) or the game is full; nothing was written.
 */
export type GameWrite = "created" | "joined" | "duplicate" | "refused";

export interface GameRecord extends Omit<GameInput, "players"> {
  sessionId: string | null;
  bots: number;
  botLevel: number | null;
  appVersion: string | null;
  deviceClass: string | null;
  offline: boolean;
  players: Required<GamePlayerInput>[];
}

export interface EventInput {
  id: string;
  playerId: string;
  sessionId?: string | null;
  kind: string;
  occurredAt: number;
  receivedAt: number;
  offline?: boolean;
  payload?: unknown;
}

export interface EventRecord {
  id: string;
  playerId: string;
  sessionId: string | null;
  kind: string;
  occurredAt: number;
  receivedAt: number;
  offline: boolean;
  payload: unknown;
}

/** One line of a player's append-only history, for example a new personal best. */
export interface HistoryInput {
  id: string;
  playerId: string;
  kind: string;
  value?: number | null;
  detail?: unknown;
  at: number;
}

export interface HistoryRecord {
  id: string;
  playerId: string;
  kind: string;
  value: number | null;
  detail: unknown;
  at: number;
}

/** A rolled-up number for one day. `dim` is `all`, `mode:sprint`, `device:mobile` and so on. */
export interface DailyStat {
  day: string;
  metric: string;
  dim: string;
  value: number;
}

export interface PlayerDay {
  playerId: string;
  day: string;
  games: number;
  playMs: number;
  lines: number;
  bestScore: number;
}

export interface PurgeCutoffs {
  eventsBefore?: number;
  gamesBefore?: number;
  sessionsBefore?: number;
  /** Rows deleted per statement, so that one purge never holds the database for long. */
  batch?: number;
}

export interface PurgeResult {
  events: number;
  games: number;
  sessions: number;
}

export interface DeleteResult {
  player: boolean;
  games: number;
  gamePlayers: number;
  events: number;
  sessions: number;
  devices: number;
  history: number;
  playerDays: number;
}

export interface Counts {
  players: number;
  sessions: number;
  games: number;
  events: number;
}

export interface Repository {
  readonly driver: DriverName;
  /** The newest migration that has been applied. */
  schemaVersion(): Promise<number>;
  ping(): Promise<void>;
  close(): Promise<void>;

  /** Makes the player exist and moves `firstSeen` back or `lastSeen` forward to `at`. */
  touchPlayer(id: string, at: number): Promise<PlayerRecord>;
  getPlayer(id: string): Promise<PlayerRecord | null>;
  setTelemetryOptOut(id: string, optOut: boolean): Promise<void>;
  recordDevice(playerId: string, device: DeviceInfo, at: number): Promise<void>;
  listDevices(playerId: string): Promise<DeviceRecord[]>;

  startSession(session: SessionInput): Promise<void>;
  endSession(id: string, at: number): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;

  /**
   * Stores a finished game with its players. When the id is already stored, the rows of this report
   * that the game does not have yet are added to it (the first report's other fields stay).
   */
  recordGame(game: GameInput, join?: GameJoinRules): Promise<GameWrite>;
  getGame(id: string): Promise<GameRecord | null>;

  /** Stores raw events and returns how many were new; ids already stored are skipped. */
  insertEvents(events: readonly EventInput[]): Promise<number>;
  listEvents(playerId: string, limit: number): Promise<EventRecord[]>;

  /** `false` when this id was already stored. */
  addHistory(entry: HistoryInput): Promise<boolean>;
  listHistory(playerId: string, limit: number): Promise<HistoryRecord[]>;

  /** Recomputes one UTC day of rollups from the raw rows. Safe to run again at any time. */
  rollupDay(day: string): Promise<void>;
  dailyStats(fromDay: string, toDay: string): Promise<DailyStat[]>;
  playerDays(playerId: string, fromDay: string, toDay: string): Promise<PlayerDay[]>;

  /** Deletes old rows, but only from days that have been rolled up. */
  purge(cutoffs: PurgeCutoffs): Promise<PurgeResult>;
  /** Removes everything stored about one player. Anonymous rollups stay. */
  deletePlayer(id: string): Promise<DeleteResult>;

  counts(): Promise<Counts>;
  sizeBytes(): Promise<number>;
  /** Gives freed space back (SQLite); a no-op where the database does it by itself. */
  compact(): Promise<void>;
}
