-- Initial schema (postgres). Times are milliseconds since the Unix epoch; a day is a UTC date, YYYY-MM-DD.
-- Flags are 0/1 so both databases take the same parameters. Never edit a migration that has shipped: add a new one.

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  account_id TEXT,
  telemetry_opt_out SMALLINT NOT NULL DEFAULT 0 CHECK (telemetry_opt_out IN (0, 1))
);

CREATE TABLE player_devices (
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  device_class TEXT NOT NULL,
  device JSONB NOT NULL,
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  PRIMARY KEY (player_id, fingerprint)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  app_version TEXT,
  display_mode TEXT,
  device_class TEXT,
  offline SMALLINT NOT NULL DEFAULT 0 CHECK (offline IN (0, 1))
);
CREATE INDEX sessions_started_at ON sessions (started_at);
CREATE INDEX sessions_player ON sessions (player_id);

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  mode TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0),
  bots BIGINT NOT NULL DEFAULT 0 CHECK (bots >= 0),
  bot_level BIGINT,
  app_version TEXT,
  device_class TEXT,
  offline SMALLINT NOT NULL DEFAULT 0 CHECK (offline IN (0, 1))
);
CREATE INDEX games_started_at ON games (started_at);

CREATE TABLE game_players (
  game_id TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  seat BIGINT,
  result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'draw', 'finished', 'quit')),
  lines BIGINT NOT NULL DEFAULT 0 CHECK (lines >= 0),
  score BIGINT NOT NULL DEFAULT 0 CHECK (score >= 0),
  pieces BIGINT NOT NULL DEFAULT 0 CHECK (pieces >= 0),
  pps DOUBLE PRECISION,
  apm DOUBLE PRECISION,
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX game_players_player ON game_players (player_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  session_id TEXT,
  kind TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  received_at BIGINT NOT NULL,
  offline SMALLINT NOT NULL DEFAULT 0 CHECK (offline IN (0, 1)),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_occurred_at ON events (occurred_at);
CREATE INDEX events_player ON events (player_id);

CREATE TABLE player_history (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value DOUBLE PRECISION,
  detail JSONB,
  at BIGINT NOT NULL
);
CREATE INDEX player_history_player ON player_history (player_id, at);

CREATE TABLE daily_stats (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  dim TEXT NOT NULL,
  value BIGINT NOT NULL,
  PRIMARY KEY (day, metric, dim)
);

CREATE TABLE player_daily (
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  games BIGINT NOT NULL,
  play_ms BIGINT NOT NULL,
  lines BIGINT NOT NULL,
  best_score BIGINT NOT NULL,
  PRIMARY KEY (player_id, day)
);

CREATE TABLE rollup_days (
  day TEXT PRIMARY KEY,
  day_start BIGINT NOT NULL,
  rolled_at BIGINT NOT NULL
);
