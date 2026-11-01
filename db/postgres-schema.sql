CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  created_at TEXT NOT NULL,
  logo_mime_type TEXT,
  logo BYTEA,
  is_qa BOOLEAN NOT NULL DEFAULT FALSE,
  correct_option_id TEXT,
  question_image_mime_type TEXT,
  question_image BYTEA,
  voting_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  video_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  reveal_correct BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  votes INTEGER NOT NULL DEFAULT 0 CHECK (votes >= 0),
  image_mime_type TEXT,
  image BYTEA
);
CREATE INDEX IF NOT EXISTS poll_options_poll_id ON poll_options(poll_id, position);

CREATE TABLE IF NOT EXISTS poll_voting_sessions (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  full_name TEXT,
  ticket_number TEXT,
  ticket_key TEXT,
  registered_at TEXT
);
CREATE INDEX IF NOT EXISTS poll_voting_sessions_expiry ON poll_voting_sessions(expires_at);
-- One registration per ticket number (case-insensitive) in each Q&A.
CREATE UNIQUE INDEX IF NOT EXISTS poll_voting_sessions_ticket
  ON poll_voting_sessions(poll_id, ticket_key) WHERE ticket_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS poll_voters (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL,
  option_id TEXT REFERENCES poll_options(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  voting_session_id TEXT REFERENCES poll_voting_sessions(id) ON DELETE SET NULL,
  first_name TEXT,
  ticket_number TEXT,
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  verified_by TEXT,
  verified_at TEXT,
  PRIMARY KEY (poll_id, voter_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS poll_voters_voting_session_id
  ON poll_voters(voting_session_id) WHERE voting_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ad_playbacks (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voting_session_id TEXT NOT NULL UNIQUE REFERENCES poll_voting_sessions(id) ON DELETE CASCADE,
  ad_kind TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed')),
  max_position DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ad_playbacks_poll ON ad_playbacks(poll_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  username TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS game_rooms (
  id TEXT PRIMARY KEY,
  room_name TEXT NOT NULL DEFAULT 'Game room',
  player_x_token_hash TEXT NOT NULL,
  player_o_token_hash TEXT,
  player_x_name TEXT NOT NULL,
  player_o_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'playing', 'finished')),
  board_json TEXT NOT NULL,
  history_x_json TEXT NOT NULL,
  history_o_json TEXT NOT NULL,
  next_player TEXT NOT NULL CHECK (next_player IN ('X', 'O')),
  winner TEXT CHECK (winner IN ('X', 'O')),
  x_image_mime_type TEXT,
  x_image BYTEA,
  o_image_mime_type TEXT,
  o_image BYTEA,
  rematch_deadline TEXT,
  rematch_x_vote INTEGER,
  rematch_o_vote INTEGER,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS game_rooms_updated_at ON game_rooms(updated_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash BYTEA NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'host')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_case_insensitive ON users(LOWER(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS theme_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  draft_json TEXT NOT NULL,
  published_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  published_by TEXT,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS game_theme_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  draft_json TEXT NOT NULL,
  published_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  published_by TEXT,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS selfie_sessions (
  id TEXT PRIMARY KEY,
  join_token_hash TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS selfie_submissions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES selfie_sessions(id) ON DELETE CASCADE,
  image_mime_type TEXT NOT NULL,
  image BYTEA NOT NULL,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS selfie_submissions_session_status
  ON selfie_submissions(session_id, status, created_at);

CREATE TABLE IF NOT EXISTS theme_assets (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS theme_audit_logs (
  id TEXT PRIMARY KEY,
  administrator_id TEXT NOT NULL,
  administrator_name TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);
