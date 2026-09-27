-- Hand Chess: プレイヤー・対局の保存先 (Cloudflare D1 / SQLite)
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,            -- ランダムなID(公開してよい)
  secret_hash TEXT NOT NULL,               -- 秘密のキーのSHA-256(キー自体は保存しない)
  name        TEXT NOT NULL,
  rating      REAL NOT NULL DEFAULT 1200,
  games       INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  draws       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_rating ON players (rating DESC);

CREATE TABLE IF NOT EXISTS games (
  id            TEXT PRIMARY KEY,
  room          TEXT NOT NULL,
  white_id      TEXT NOT NULL,
  black_id      TEXT NOT NULL,
  white_name    TEXT NOT NULL,
  black_name    TEXT NOT NULL,
  winner        TEXT,                      -- 'w' / 'b' / NULL(引き分け)
  reason        TEXT NOT NULL,
  plies         INTEGER NOT NULL,
  white_before  INTEGER NOT NULL,
  black_before  INTEGER NOT NULL,
  white_after   INTEGER NOT NULL,
  black_after   INTEGER NOT NULL,
  pgn           TEXT NOT NULL,
  played_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_games_white ON games (white_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_black ON games (black_id, played_at DESC);
