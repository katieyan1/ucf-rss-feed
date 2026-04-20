-- Articles: one row per new feed item detected.
CREATE TABLE IF NOT EXISTS articles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,         -- "nyt", "bbc", etc.
  section     TEXT    NOT NULL,         -- "Politics", "World", etc.
  guid        TEXT    NOT NULL UNIQUE,  -- deduplicated on insert
  title       TEXT    NOT NULL,
  pub_date    TEXT,                     -- original pubDate string
  description TEXT,
  detected_at TEXT    NOT NULL,         -- ISO timestamp of first detection
  latency_ms  INTEGER                   -- ms between pub_date and detected_at
);

-- Feed events: one row per poll cycle that found at least one change.
CREATE TABLE IF NOT EXISTS feed_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT    NOT NULL,
  detected_at     TEXT    NOT NULL,
  new_count       INTEGER NOT NULL DEFAULT 0,
  drop_count      INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_articles_source     ON articles (source, detected_at);
CREATE INDEX IF NOT EXISTS idx_articles_detected   ON articles (detected_at);
CREATE INDEX IF NOT EXISTS idx_feed_events_source  ON feed_events (source, detected_at);
