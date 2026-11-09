-- MariaDB 10.5+ schema for VOTE. Statements are idempotent and applied automatically at server start.
-- Binary collation keeps comparisons case-sensitive (IDs, tokens, ticket keys); usernames are case-insensitive.
CREATE TABLE IF NOT EXISTS ad_videos (
  kind VARCHAR(16) NOT NULL PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size BIGINT NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CHECK (kind IN ('poll', 'qa', 'game', 'selfie'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS raffle_ad_videos (
  kind VARCHAR(16) NOT NULL PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size BIGINT NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CHECK (kind = 'raffle')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS scramble_ad_videos (
  kind VARCHAR(16) NOT NULL PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size BIGINT NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CHECK (kind = 'scramble')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS polls (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  question TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  logo_mime_type VARCHAR(100) NULL,
  logo LONGBLOB NULL,
  voting_enabled TINYINT NOT NULL DEFAULT 1,
  video_enabled TINYINT NOT NULL DEFAULT 1,
  is_qa TINYINT NOT NULL DEFAULT 0,
  reveal_correct TINYINT NOT NULL DEFAULT 0,
  correct_option_id VARCHAR(64) NULL,
  question_image_mime_type VARCHAR(100) NULL,
  question_image LONGBLOB NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE polls ADD COLUMN IF NOT EXISTS join_title VARCHAR(80) NULL;

CREATE TABLE IF NOT EXISTS poll_options (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  poll_id VARCHAR(64) NOT NULL,
  label TEXT NOT NULL,
  `position` INT NOT NULL,
  votes INT NOT NULL DEFAULT 0,
  image_mime_type VARCHAR(100) NULL,
  image LONGBLOB NULL,
  CHECK (votes >= 0),
  INDEX poll_options_poll_id (poll_id, `position`),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE poll_options ADD COLUMN IF NOT EXISTS hide_label TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS poll_voting_sessions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  poll_id VARCHAR(64) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  consumed_at VARCHAR(32) NULL,
  full_name VARCHAR(255) NULL,
  ticket_number VARCHAR(64) NULL,
  ticket_key VARCHAR(64) NULL,
  registered_at VARCHAR(32) NULL,
  UNIQUE KEY poll_voting_sessions_token (token_hash),
  UNIQUE KEY poll_voting_sessions_ticket (poll_id, ticket_key),
  INDEX poll_voting_sessions_expiry (expires_at),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS poll_voters (
  poll_id VARCHAR(64) NOT NULL,
  voter_id VARCHAR(64) NOT NULL,
  seq BIGINT NOT NULL AUTO_INCREMENT,
  option_id VARCHAR(64) NULL,
  created_at VARCHAR(32) NOT NULL,
  voting_session_id VARCHAR(64) NULL,
  first_name VARCHAR(255) NULL,
  ticket_number VARCHAR(64) NULL,
  is_correct TINYINT NOT NULL DEFAULT 0,
  verification_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  verified_by VARCHAR(64) NULL,
  verified_at VARCHAR(32) NULL,
  PRIMARY KEY (poll_id, voter_id),
  UNIQUE KEY poll_voters_seq (seq),
  UNIQUE KEY poll_voters_voting_session_id (voting_session_id),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
  FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE SET NULL,
  FOREIGN KEY (voting_session_id) REFERENCES poll_voting_sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS ad_playbacks (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  poll_id VARCHAR(64) NOT NULL,
  voting_session_id VARCHAR(64) NOT NULL,
  ad_kind VARCHAR(16) NOT NULL,
  ad_id VARCHAR(255) NOT NULL,
  started_at VARCHAR(32) NOT NULL,
  completed_at VARCHAR(32) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'started',
  max_position DOUBLE NOT NULL DEFAULT 0,
  CHECK (status IN ('started', 'completed')),
  UNIQUE KEY ad_playbacks_session (voting_session_id),
  INDEX ad_playbacks_poll (poll_id),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
  FOREIGN KEY (voting_session_id) REFERENCES poll_voting_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  user_id VARCHAR(64) NULL,
  username VARCHAR(64) NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50) NULL,
  target_id VARCHAR(255) NULL,
  details TEXT NULL,
  ip_address VARCHAR(64) NULL,
  created_at VARCHAR(32) NOT NULL,
  INDEX audit_logs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci,
  password_hash VARBINARY(64) NOT NULL,
  password_salt VARCHAR(64) NOT NULL,
  role VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  CHECK (role IN ('admin', 'host')),
  UNIQUE KEY users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash VARCHAR(64) NOT NULL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  INDEX sessions_expiry (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS game_rooms (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  room_name VARCHAR(255) NOT NULL DEFAULT 'Game room',
  player_x_token_hash VARCHAR(64) NOT NULL,
  player_o_token_hash VARCHAR(64) NULL,
  player_x_name VARCHAR(255) NOT NULL,
  player_o_name VARCHAR(255) NULL,
  status VARCHAR(16) NOT NULL,
  board_json TEXT NOT NULL,
  history_x_json TEXT NOT NULL,
  history_o_json TEXT NOT NULL,
  next_player VARCHAR(1) NOT NULL,
  winner VARCHAR(1) NULL,
  x_image_mime_type VARCHAR(100) NULL,
  x_image LONGBLOB NULL,
  o_image_mime_type VARCHAR(100) NULL,
  o_image LONGBLOB NULL,
  rematch_deadline VARCHAR(32) NULL,
  rematch_x_vote TINYINT NULL,
  rematch_o_vote TINYINT NULL,
  revision INT NOT NULL DEFAULT 0,
  updated_at VARCHAR(32) NOT NULL,
  CHECK (status IN ('waiting', 'playing', 'finished')),
  CHECK (next_player IN ('X', 'O')),
  CHECK (winner IN ('X', 'O')),
  INDEX game_rooms_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS theme_settings (
  id TINYINT NOT NULL PRIMARY KEY,
  draft_json TEXT NOT NULL,
  published_json TEXT NOT NULL,
  updated_by VARCHAR(64) NULL,
  updated_at VARCHAR(32) NOT NULL,
  published_by VARCHAR(64) NULL,
  published_at VARCHAR(32) NULL,
  CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS game_theme_settings (
  id TINYINT NOT NULL PRIMARY KEY,
  draft_json TEXT NOT NULL,
  published_json TEXT NOT NULL,
  updated_by VARCHAR(64) NULL,
  updated_at VARCHAR(32) NOT NULL,
  published_by VARCHAR(64) NULL,
  published_at VARCHAR(32) NULL,
  CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS selfie_sessions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  join_token_hash VARCHAR(64) NOT NULL,
  owner_user_id VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  closed_at VARCHAR(32) NULL,
  UNIQUE KEY selfie_sessions_token (join_token_hash),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS selfie_submissions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL,
  image_mime_type VARCHAR(100) NOT NULL,
  image LONGBLOB NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  CHECK (status IN ('pending', 'approved')),
  INDEX selfie_submissions_session_status (session_id, status, created_at),
  FOREIGN KEY (session_id) REFERENCES selfie_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE selfie_submissions ADD COLUMN IF NOT EXISTS approved_at VARCHAR(32) NULL;

CREATE TABLE IF NOT EXISTS terms_of_service (
  id TINYINT NOT NULL PRIMARY KEY,
  content MEDIUMTEXT NOT NULL,
  version INT NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  updated_by VARCHAR(64) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
ALTER TABLE selfie_sessions ADD COLUMN IF NOT EXISTS paused TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE selfie_sessions ADD COLUMN IF NOT EXISTS santa_enabled TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE selfie_sessions ADD COLUMN IF NOT EXISTS display_token_hash VARCHAR(64) NULL;
ALTER TABLE selfie_sessions ADD COLUMN IF NOT EXISTS banner_mime_type VARCHAR(100) NULL;
ALTER TABLE selfie_sessions ADD COLUMN IF NOT EXISTS banner LONGBLOB NULL;

CREATE TABLE IF NOT EXISTS logo_bank (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  image_mime_type VARCHAR(100) NOT NULL,
  image LONGBLOB NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE INDEX logo_bank_hash (content_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS theme_assets (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  width INT NOT NULL,
  height INT NOT NULL,
  uploaded_by VARCHAR(64) NOT NULL,
  uploaded_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS theme_audit_logs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  administrator_id VARCHAR(64) NOT NULL,
  administrator_name VARCHAR(64) NOT NULL,
  action VARCHAR(100) NOT NULL,
  details TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS raffle_sessions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  title VARCHAR(120) NOT NULL,
  logo_mime_type VARCHAR(100) NULL,
  logo LONGBLOB NULL,
  draw_status VARCHAR(16) NOT NULL DEFAULT 'idle',
  created_by VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CHECK (draw_status IN ('idle', 'drawing')),
  INDEX raffle_sessions_created_at (created_at),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE raffle_sessions ADD COLUMN IF NOT EXISTS display_image_1_mime_type VARCHAR(100) NULL;
ALTER TABLE raffle_sessions ADD COLUMN IF NOT EXISTS display_image_1 LONGBLOB NULL;
ALTER TABLE raffle_sessions ADD COLUMN IF NOT EXISTS display_image_2_mime_type VARCHAR(100) NULL;
ALTER TABLE raffle_sessions ADD COLUMN IF NOT EXISTS display_image_2 LONGBLOB NULL;

CREATE TABLE IF NOT EXISTS raffle_entries (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  raffle_id VARCHAR(64) NOT NULL,
  participant_name VARCHAR(80) NOT NULL,
  ticket_number VARCHAR(40) NOT NULL,
  ticket_key VARCHAR(40) NOT NULL,
  registered_at VARCHAR(32) NOT NULL,
  won_at VARCHAR(32) NULL,
  UNIQUE KEY raffle_entries_ticket (raffle_id, ticket_key),
  INDEX raffle_entries_raffle_registered (raffle_id, registered_at),
  INDEX raffle_entries_raffle_won (raffle_id, won_at),
  FOREIGN KEY (raffle_id) REFERENCES raffle_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS scramble_games (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  title VARCHAR(120) NOT NULL,
  answer VARCHAR(120) NOT NULL,
  scrambled VARCHAR(120) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  answer_revealed_at VARCHAR(32) NULL,
  logo_mime_type VARCHAR(100) NULL,
  logo LONGBLOB NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CHECK (status IN ('draft', 'active', 'paused', 'closed', 'completed')),
  INDEX scramble_games_created_at (created_at),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS scramble_entries (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  game_id VARCHAR(64) NOT NULL,
  participant_name VARCHAR(80) NOT NULL,
  ticket_number VARCHAR(40) NOT NULL,
  ticket_key VARCHAR(40) NOT NULL,
  registered_at VARCHAR(32) NOT NULL,
  answer VARCHAR(120) NULL,
  is_correct TINYINT(1) NULL,
  answered_at VARCHAR(32) NULL,
  selected_at VARCHAR(32) NULL,
  confirmed_at VARCHAR(32) NULL,
  announced_at VARCHAR(32) NULL,
  UNIQUE KEY scramble_entries_ticket (game_id, ticket_key),
  INDEX scramble_entries_game_registered (game_id, registered_at),
  INDEX scramble_entries_game_answered (game_id, answered_at),
  INDEX scramble_entries_game_selected (game_id, selected_at),
  FOREIGN KEY (game_id) REFERENCES scramble_games(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
