-- Kalshi markets: maps a set of keywords to a Kalshi market for matching against RSS articles.
CREATE TABLE IF NOT EXISTS kalshi_markets (
  market_id   TEXT PRIMARY KEY,           -- Kalshi market ID (ticker)
  title       TEXT NOT NULL,              -- Kalshi market title
  description TEXT,                       -- Kalshi market description
  keywords    TEXT NOT NULL               -- JSON array of keyword strings
);
