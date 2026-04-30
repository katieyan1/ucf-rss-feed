-- LLM verdict columns on article ↔ market matches.
-- impact: 1 = yes the article impacts the market, 0 = no, NULL = call failed / not yet judged.
-- confidence: 0.0–1.0 from the model.
-- reason: short free-form explanation from the model.
-- llm_model: which Workers AI model produced the verdict (so we can re-judge later if we swap models).
ALTER TABLE article_market_matches ADD COLUMN impact     INTEGER;
ALTER TABLE article_market_matches ADD COLUMN confidence REAL;
ALTER TABLE article_market_matches ADD COLUMN reason     TEXT;
ALTER TABLE article_market_matches ADD COLUMN llm_model  TEXT;
