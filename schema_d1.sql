-- System Cards Platform — Cloudflare D1 Schema
-- Run this in the Cloudflare D1 console for the system-cards database

-- One row per system card file
CREATE TABLE IF NOT EXISTS system_cards (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament      TEXT NOT NULL,          -- e.g. '26riga'
  sub_event       TEXT,                   -- e.g. 'Open Teams'
  event_folder    TEXT,                   -- e.g. 'Open_Teams' (R2 folder)
  file_name       TEXT NOT NULL,          -- e.g. 'BAKKE_BERG.pdf'
  file_url        TEXT,                   -- R2 public URL
  uploaded_at     TEXT DEFAULT (datetime('now')),
  -- Validation
  status          TEXT DEFAULT 'pending', -- 'pending' | 'accepted' | 'refused'
  validated_by    TEXT,
  validated_at    TEXT,
  refused_reason  TEXT
);

-- One row per player on a card (any number of players per card)
CREATE TABLE IF NOT EXISTS system_card_players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     INTEGER NOT NULL REFERENCES system_cards(id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL,           -- WBF/EBL player ID
  player_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_sc_tournament ON system_cards(tournament);
CREATE INDEX IF NOT EXISTS idx_sc_status     ON system_cards(tournament, status);
CREATE INDEX IF NOT EXISTS idx_scp_card      ON system_card_players(card_id);
CREATE INDEX IF NOT EXISTS idx_scp_player    ON system_card_players(player_id);
