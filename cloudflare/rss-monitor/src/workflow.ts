import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { SourceConfig } from "./sources";
import { parseFeed, computeLatencyMs, FeedItem } from "./rss";
import { extractKeywords, prepareMarkets, matchMarkets, PreparedMarket } from "./keywords";
import { decideImpact, IMPACT_MODEL } from "./impact";

export interface Env {
  RSS_WORKFLOW: Workflow;
  rss_monitor: D1Database;
  AI: { run(model: string, input: unknown): Promise<unknown> };
}

export interface RSSPollParams {
  source: SourceConfig;
}

interface SectionDiff {
  section: string;
  currentGuids: string[];    // written to feed_snapshots every poll
  newItems: FeedItem[];      // empty on first run
  droppedTitles: string[];
  latencyMs: number[];
  isFirstRun: boolean;
}

export class RSSMonitorWorkflow extends WorkflowEntrypoint<Env, RSSPollParams> {
  async run(event: WorkflowEvent<RSSPollParams>, step: WorkflowStep) {
    const { source } = event.payload;

    // Step 1: Fetch each feed in its own step so one dead feed can't poison the cycle.
    const rawFeeds: Record<string, string | null> = {};
    await Promise.all(
      Object.entries(source.feeds).map(async ([section, url]) => {
        rawFeeds[section] = await step.do(`fetch-${section}`, async () => {
          try {
            const resp = await fetch(url, {
              headers: {
                "User-Agent": "rss-monitor/1.0",
                "Cache-Control": "no-cache, no-store",
                "Pragma": "no-cache",
              },
              signal: AbortSignal.timeout(15_000),
            });
            if (!resp.ok) {
              console.error(`[fetch-${section}] ${source.name}: HTTP ${resp.status} from ${url}`);
              return null;
            }
            return await resp.text();
          } catch (err) {
            console.error(`[fetch-${section}] ${source.name}: fetch threw — ${err}`);
            return null;
          }
        });
      })
    );

    // Step 2: Read D1 state and compute diffs. No writes — pure reads + logic.
    const diffs = await step.do("diff-feeds", async () => {
      const results: SectionDiff[] = [];
      const ph = (n: number) => Array(n).fill("?").join(", ");

      for (const [section, xml] of Object.entries(rawFeeds)) {
        if (xml === null) continue;

        let items: FeedItem[];
        try {
          items = parseFeed(xml);
        } catch (err) {
          console.error(`[diff-feeds] ${source.name}/${section}: parseFeed threw — ${err}`);
          continue;
        }

        if (items.length === 0) {
          console.warn(`[diff-feeds] ${source.name}/${section}: parsed 0 items`);
          continue;
        }

        const currentGuids = items.map((i) => i.guid);
        const currentGuidSet = new Set(currentGuids);

        let snapshotResult: D1Result<{ guid: string }>;
        let seenResult: D1Result<{ guid: string }>;
        try {
          [snapshotResult, seenResult] = await Promise.all([
            this.env.rss_monitor
              .prepare("SELECT guid FROM feed_snapshots WHERE source = ? AND section = ?")
              .bind(source.name, section)
              .all<{ guid: string }>() as Promise<D1Result<{ guid: string }>>,
            this.env.rss_monitor
              .prepare(`SELECT guid FROM articles WHERE guid IN (${ph(currentGuids.length)})`)
              .bind(...currentGuids)
              .all<{ guid: string }>() as Promise<D1Result<{ guid: string }>>,
          ]);
        } catch (err) {
          console.error(`[diff-feeds] ${source.name}/${section}: D1 read failed — ${err}`);
          continue;
        }

        const isFirstRun = snapshotResult.results.length === 0;
        const prevGuids = snapshotResult.results.map((r) => r.guid);
        const seenGuidSet = new Set(seenResult.results.map((r) => r.guid));

        // New: in current feed, not yet in articles table.
        const newItems: FeedItem[] = [];
        const latencyMs: number[] = [];
        if (!isFirstRun) {
          for (const item of items) {
            if (!seenGuidSet.has(item.guid)) {
              newItems.push(item);
              const lat = computeLatencyMs(item.pubDate);
              if (lat !== null && lat >= 0) latencyMs.push(lat);
            }
          }
        }

        // Dropped: in previous snapshot, missing from current feed.
        let droppedTitles: string[] = [];
        if (!isFirstRun) {
          const droppedGuids = prevGuids.filter((g) => !currentGuidSet.has(g));
          if (droppedGuids.length > 0) {
            try {
              const { results: dropped } = await this.env.rss_monitor
                .prepare(`SELECT title FROM articles WHERE guid IN (${ph(droppedGuids.length)})`)
                .bind(...droppedGuids)
                .all<{ title: string }>();
              droppedTitles = dropped.map((r) => r.title);
            } catch (err) {
              console.error(`[diff-feeds] ${source.name}/${section}: dropped-titles query failed — ${err}`);
            }
          }
        }

        if (!isFirstRun && newItems.length > 0) {
          console.log(`[diff-feeds] ${source.name}/${section}: ${newItems.length} new, ${droppedTitles.length} dropped`);
        }

        results.push({ section, currentGuids, newItems, droppedTitles, latencyMs, isFirstRun });
      }

      return results;
    });

    if (diffs.length === 0) {
      console.warn(`[workflow] ${source.name}: all sections failed or returned 0 items — nothing to write`);
      return;
    }

    // Step 2.5: Extract keywords from each new article and find Kalshi markets that share them.
    // Carries the article's title/description and the market's title/description forward so the
    // impact step doesn't need to re-query D1.
    interface MatchRecord {
      articleGuid: string;
      articleTitle: string;
      articleDescription: string;
      marketId: string;
      marketTitle: string;
      marketDescription: string | null;
      matchedKeywords: string[];
    }

    const matches = await step.do("match-markets", async (): Promise<MatchRecord[]> => {
      const totalNew = diffs.reduce((acc, d) => acc + d.newItems.length, 0);
      if (totalNew === 0) return [];

      const { results } = await this.env.rss_monitor
        .prepare("SELECT market_id, title, description, keywords FROM kalshi_markets")
        .all<{ market_id: string; title: string; description: string | null; keywords: string }>();

      const markets: PreparedMarket[] = prepareMarkets(results);
      if (markets.length === 0) return [];

      const marketById = new Map(markets.map((m) => [m.marketId, m]));

      const out: MatchRecord[] = [];
      for (const diff of diffs) {
        for (const item of diff.newItems) {
          const articleKeywords = extractKeywords(`${item.title} ${item.description ?? ""}`);
          if (articleKeywords.size === 0) continue;
          for (const m of matchMarkets(articleKeywords, markets)) {
            const market = marketById.get(m.marketId);
            if (!market) continue;
            out.push({
              articleGuid: item.guid,
              articleTitle: item.title,
              articleDescription: item.description ?? "",
              marketId: m.marketId,
              marketTitle: market.title,
              marketDescription: market.description,
              matchedKeywords: m.matchedKeywords,
            });
          }
        }
      }

      if (out.length > 0) {
        console.log(`[match-markets] ${source.name}: ${out.length} article-market matches across ${totalNew} new articles`);
      }
      return out;
    });

    // Step 2.6: For each match, ask Workers AI whether the article actually impacts the market.
    // Each call is its own step.do so a hung/failed AI call doesn't redo the rest, and so
    // verdicts are checkpointed individually on workflow retries. A null verdict (parse/IO
    // failure) still records the keyword overlap with NULL impact/confidence.
    interface JudgedMatch extends MatchRecord {
      impact: 0 | 1 | null;
      confidence: number | null;
      reason: string | null;
      llmModel: string | null;
    }

    const judged: JudgedMatch[] = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const verdict = await step.do(`impact-${i}`, async () => {
        return await decideImpact(this.env.AI, {
          articleTitle: m.articleTitle,
          articleDescription: m.articleDescription,
          marketTitle: m.marketTitle,
          marketDescription: m.marketDescription,
          matchedKeywords: m.matchedKeywords,
        });
      });

      judged.push({
        ...m,
        impact: verdict?.impact ?? null,
        confidence: verdict?.confidence ?? null,
        reason: verdict?.reason ?? null,
        llmModel: verdict ? IMPACT_MODEL : null,
      });
    }

    if (judged.length > 0) {
      const yes = judged.filter((j) => j.impact === 1).length;
      const no = judged.filter((j) => j.impact === 0).length;
      const failed = judged.filter((j) => j.impact === null).length;
      console.log(`[decide-impact] ${source.name}: ${yes} impact / ${no} no-impact / ${failed} unjudged`);
    }

    // Step 3: Write everything to D1 in one step.
    await step.do(
      "write-to-db",
      { retries: { limit: 3, delay: 5000, backoff: "exponential" } },
      async () => {
        const detectedAt = new Date().toISOString();
        const statements: D1PreparedStatement[] = [];

        let totalNew = 0;
        let totalDrop = 0;
        const allLatencyMs: number[] = [];

        for (const diff of diffs) {
          // Always replace the snapshot so it reflects the current feed.
          statements.push(
            this.env.rss_monitor
              .prepare("DELETE FROM feed_snapshots WHERE source = ? AND section = ?")
              .bind(source.name, diff.section)
          );
          for (const guid of new Set(diff.currentGuids)) {
            statements.push(
              this.env.rss_monitor
                .prepare("INSERT OR IGNORE INTO feed_snapshots (source, section, guid) VALUES (?, ?, ?)")
                .bind(source.name, diff.section, guid)
            );
          }

          // Insert new articles (skipped on first run since newItems is empty).
          for (const item of diff.newItems) {
            const latMs = computeLatencyMs(item.pubDate);
            statements.push(
              this.env.rss_monitor
                .prepare(`
                  INSERT OR IGNORE INTO articles
                    (source, section, guid, title, pub_date, description, detected_at, latency_ms)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `)
                .bind(
                  source.name, diff.section,
                  item.guid, item.title,
                  item.pubDate || null, item.description || null,
                  detectedAt,
                  latMs !== null && latMs >= 0 ? latMs : null
                )
            );
          }

          totalNew += diff.newItems.length;
          totalDrop += diff.droppedTitles.length;
          allLatencyMs.push(...diff.latencyMs);
        }

        // Article ↔ market keyword matches with the LLM impact verdict for this poll's new articles.
        for (const match of judged) {
          statements.push(
            this.env.rss_monitor
              .prepare(`
                INSERT OR IGNORE INTO article_market_matches
                  (article_guid, market_id, overlap_count, matched_keywords, detected_at, impact, confidence, reason, llm_model)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `)
              .bind(
                match.articleGuid,
                match.marketId,
                match.matchedKeywords.length,
                JSON.stringify(match.matchedKeywords),
                detectedAt,
                match.impact,
                match.confidence,
                match.reason,
                match.llmModel,
              )
          );
        }

        // Record a feed_event if any real changes were found (excluding first runs).
        const hasChanges = diffs.some((d) => !d.isFirstRun && (d.newItems.length > 0 || d.droppedTitles.length > 0));
        if (hasChanges) {
          const avgLatencyMs = allLatencyMs.length > 0
            ? Math.round(allLatencyMs.reduce((a, b) => a + b, 0) / allLatencyMs.length)
            : null;
          statements.push(
            this.env.rss_monitor
              .prepare("INSERT OR IGNORE INTO feed_events (source, detected_at, new_count, drop_count, avg_latency_ms) VALUES (?, ?, ?, ?, ?)")
              .bind(source.name, detectedAt, totalNew, totalDrop, avgLatencyMs)
          );
        }

        try {
          await this.env.rss_monitor.batch(statements);
          console.log(`[write-to-db] ${source.name}: batch of ${statements.length} statements succeeded (${totalNew} new articles, ${totalDrop} dropped)`);
        } catch (err) {
          console.error(`[write-to-db] ${source.name}: batch failed — ${err}`);
          throw err; // re-throw so the step retries
        }
      }
    );
  }
}
