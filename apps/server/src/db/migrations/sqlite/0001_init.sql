-- Initial schema (sqlite). Times are milliseconds since the Unix epoch; a day is a UTC date, YYYY-MM-DD.
-- Flags are 0/1 so both databases take the same parameters. Never edit a migration that has shipped: add a new one.

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  account_id TEXT,
  telemetry_opt_out INTEGER NOT NULL DEFAULT 0 CHECK (telemetry_opt_out IN (0, 1))
) STRICT;

CREATE TABLE player_devices (
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  device_class TEXT NOT NULL,
  device TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (player_id, fingerprint)
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  app_version TEXT,
  display_mode TEXT,
  device_class TEXT,
  offline INTEGER NOT NULL DEFAULT 0 CHECK (offline IN (0, 1))
) STRICT;
CREATE INDEX sessions_started_at ON sessions (started_at);
CREATE INDEX sessions_player ON sessions (player_id);

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  mode TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  bots INTEGER NOT NULL DEFAULT 0 CHECK (bots >= 0),
  bot_level INTEGER,
  app_version TEXT,
  device_class TEXT,
  offline INTEGER NOT NULL DEFAULT 0 CHECK (offline IN (0, 1))
) STRICT;
CREATE INDEX games_started_at ON games (started_at);

CREATE TABLE game_players (
  game_id TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  seat INTEGER,
  result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'draw', 'finished', 'quit')),
  lines INTEGER NOT NULL DEFAULT 0 CHECK (lines >= 0),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  pieces INTEGER NOT NULL DEFAULT 0 CHECK (pieces >= 0),
  pps REAL,
  apm REAL,
  PRIMARY KEY (game_id, player_id)
) STRICT;
CREATE INDEX game_players_player ON game_players (player_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  session_id TEXT,
  kind TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  offline INTEGER NOT NULL DEFAULT 0 CHECK (offline IN (0, 1)),
  payload TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX events_occurred_at ON events (occurred_at);
CREATE INDEX events_player ON events (player_id);

CREATE TABLE player_history (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value REAL,
  detail TEXT,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX player_history_player ON player_history (player_id, at);

CREATE TABLE daily_stats (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  dim TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (day, metric, dim)
) STRICT;

CREATE TABLE player_daily (
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  games INTEGER NOT NULL,
  play_ms INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  best_score INTEGER NOT NULL,
  PRIMARY KEY (player_id, day)
) STRICT;

CREATE TABLE rollup_days (
  day TEXT PRIMARY KEY,
  day_start INTEGER NOT NULL,
  rolled_at INTEGER NOT NULL
) STRICT;
