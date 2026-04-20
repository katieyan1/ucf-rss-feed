-- Tracks the current set of GUIDs in each feed section.
-- Replaces the KV snapshot:{source}:{section} keys.
-- Cleared and rewritten on every poll; used only to detect dropped articles.
CREATE TABLE IF NOT EXISTS feed_snapshots (
  source  TEXT NOT NULL,
  section TEXT NOT NULL,
  guid    TEXT NOT NULL,
  PRIMARY KEY (source, section, guid)
);
