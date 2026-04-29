import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { SourceConfig } from "./sources";
import { parseFeed, computeLatencyMs, FeedItem } from "./rss";

export interface Env {
  RSS_WORKFLOW: Workflow;
  rss_monitor: D1Database;
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
