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

    // Step 1: Fetch all feeds for this source in parallel.
    const rawFeeds = await step.do("fetch-feeds", async () => {
      const results: Record<string, string | null> = {};
      await Promise.all(
        Object.entries(source.feeds).map(async ([section, url]) => {
          try {
            const resp = await fetch(url, {
              headers: {
                "User-Agent": "rss-monitor/1.0",
                "Cache-Control": "no-cache, no-store",
                "Pragma": "no-cache",
              },
              signal: AbortSignal.timeout(15_000),
            });
            results[section] = resp.ok ? await resp.text() : null;
          } catch {
            results[section] = null;
          }
        })
      );
      return results;
    });

    // Step 2: Read D1 state and compute diffs. No writes — pure reads + logic.
    //
    // Returns one SectionDiff per successfully fetched section, including
    // isFirstRun sections (newItems will be empty, but currentGuids still needs
    // to be written to feed_snapshots in step 3).
    const diffs = await step.do("diff-feeds", async () => {
      const results: SectionDiff[] = [];
      const ph = (n: number) => Array(n).fill("?").join(", ");

      for (const [section, xml] of Object.entries(rawFeeds)) {
        if (xml === null) continue;

        const items = parseFeed(xml);
        if (items.length === 0) continue;

        const currentGuids = items.map((i) => i.guid);
        const currentGuidSet = new Set(currentGuids);

        // Read snapshot + seen articles in parallel — no writes here.
        const [snapshotResult, seenResult] = await Promise.all([
          this.env.rss_monitor
            .prepare("SELECT guid FROM feed_snapshots WHERE source = ? AND section = ?")
            .bind(source.name, section)
            .all<{ guid: string }>(),
          this.env.rss_monitor
            .prepare(`SELECT guid FROM articles WHERE guid IN (${ph(currentGuids.length)})`)
            .bind(...currentGuids)
            .all<{ guid: string }>(),
        ]);

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
            const { results: dropped } = await this.env.rss_monitor
              .prepare(`SELECT title FROM articles WHERE guid IN (${ph(droppedGuids.length)})`)
              .bind(...droppedGuids)
              .all<{ title: string }>();
            droppedTitles = dropped.map((r) => r.title);
          }
        }

        results.push({ section, currentGuids, newItems, droppedTitles, latencyMs, isFirstRun });
      }

      return results;
    });

    if (diffs.length === 0) return;

    // Step 3: Write everything to D1 in one step.
    // - Update feed_snapshots for every section (including first-run seeding).
    // - INSERT new articles.
    // - INSERT a feed_event row if anything changed.
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
          for (const guid of diff.currentGuids) {
            statements.push(
              this.env.rss_monitor
                .prepare("INSERT INTO feed_snapshots (source, section, guid) VALUES (?, ?, ?)")
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
              .prepare("INSERT INTO feed_events (source, detected_at, new_count, drop_count, avg_latency_ms) VALUES (?, ?, ?, ?, ?)")
              .bind(source.name, detectedAt, totalNew, totalDrop, avgLatencyMs)
          );
        }

        await this.env.rss_monitor.batch(statements);
      }
    );
  }
}
