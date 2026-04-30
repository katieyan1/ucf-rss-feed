-- Article ↔ Kalshi market matches: one row per (article, market) pair with at least one keyword overlap.
-- Keyed on article guid (not articles.id) so matches can be inserted in the same batch as the article itself.
CREATE TABLE IF NOT EXISTS article_market_matches (
  article_guid     TEXT    NOT NULL,
  market_id        TEXT    NOT NULL,
  overlap_count    INTEGER NOT NULL,
  matched_keywords TEXT    NOT NULL,   -- JSON array of original kalshi keyword strings that matched
  detected_at      TEXT    NOT NULL,
  PRIMARY KEY (article_guid, market_id)
);

CREATE INDEX IF NOT EXISTS idx_amm_market   ON article_market_matches (market_id);
CREATE INDEX IF NOT EXISTS idx_amm_detected ON article_market_matches (detected_at);
