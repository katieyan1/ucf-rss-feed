# RSS Feed Monitor — System Documentation

This document describes the RSS feed monitoring system: architecture, how to run it, what we learned from a 67-hour continuous monitoring session (Apr 15–18, 2026), and things we tried along the way.

---

## Architecture

### Core Components

```
rss/
├── monitor.sh              # Generic RSS monitor (main script)
├── monitor_nyt_sitemap.sh   # NYT RSS vs sitemap comparison (experimental)
├── monitor_nyt.sh           # Original NYT-only monitor (superseded by monitor.sh)
├── start_all.sh             # Launch/stop all 6 monitors
├── sources/                 # Source config files
│   ├── nyt.conf
│   ├── bbc.conf
│   ├── wsj.conf
│   ├── guardian.conf
│   ├── npr.conf
│   └── aljazeera.conf
├── working_feeds.txt        # Full catalog of 93 verified RSS feeds
├── rss_articles_dataset.csv # Final dataset (1,740 articles from 67h run)
├── .env                     # GitHub token (gitignored)
├── .cache_<source>/         # Per-source cache dirs (gitignored)
│   ├── <Section>.tsv        # Current feed snapshot (guid\ttitle\tpubDate\tdescription)
│   ├── seen_guids.txt       # Dedup: every GUID ever reported as NEW
│   ├── master_gist_id       # This source's master gist ID
│   └── monitor.pid          # PID file for start_all.sh
├── <source>_changes.log     # Per-source log (gitignored)
└── SYSTEM.md                # This file
```

### How `monitor.sh` Works

1. **Loads config** from a `sources/<name>.conf` file (defines `SOURCE_NAME`, `SOURCE_DESCRIPTION`, and a bash associative array `FEEDS` mapping section names to RSS URLs)
2. **Polls every 60 seconds** — fetches each RSS feed via curl, extracts items with a Perl one-liner (guid, title, pubDate, description)
3. **Diffs against cache** — compares current items to the previous snapshot (`<Section>.tsv`) using `comm` on sorted GUIDs
4. **Dedup check** — skips any GUID already in `seen_guids.txt` (prevents re-reporting articles that cycle in and out of feeds)
5. **Computes latency** — parses the article's `pubDate` (RFC 2822) and subtracts from current time to get pub→scrape delay
6. **Logs locally** — writes to `<source>_changes.log` with `[timestamp] NEW section | title (latency: Xm Ys)` format, plus `published:` on the next line
7. **Publishes to GitHub Gist** — creates a private Markdown gist per diff, then appends a row to the source's master index gist (fetches current content, appends, PATCHes)
8. **Updates cache** — writes new snapshot to TSV, adds new GUIDs to `seen_guids.txt`

### Source Configs

Each `.conf` file is a bash snippet sourced by `monitor.sh`:

```bash
SOURCE_NAME="NYT"
SOURCE_DESCRIPTION="New York Times"
declare -A FEEDS=(
  [HomePage]="https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"
  [World]="https://rss.nytimes.com/services/xml/rss/nyt/World.xml"
  # ... more sections
)
```

**Feed counts:** NYT (10), BBC (7), WSJ (7), Guardian (7), NPR (7), Al Jazeera (1). Total: 39 feeds.

### Gist Structure

A hierarchy of private GitHub gists:

- **Master Dashboard** — links to all 6 source indexes
- **Per-source master index** — table with timestamp, change summary, avg latency, link to diff gist
- **Diff gists** — individual Markdown files with new/dropped articles, pubDates, summaries, and scrape latency

Each gist update costs 2-3 GitHub API calls (create diff + read master + PATCH master). At peak, we consumed ~200 calls/hour out of the 5,000/hour limit.

### Dataset Output

`rss_articles_dataset.csv` — generated from the log files and cache:

| Column | Description |
|--------|-------------|
| `source` | NYT, BBC, WSJ, Guardian, NPR, Al Jazeera |
| `publish_time` | Article pubDate (ISO 8601) |
| `scrape_time` | When our monitor first detected it (ISO 8601) |
| `delay_minutes` | pub→scrape latency in minutes (e.g., 5.8) |
| `title` | Article headline |
| `summary` | RSS description (when available — not all feeds include it) |
| `link` | Article URL (when available from cache) |

To regenerate from current logs, run the Python script that parses `*_changes.log` files and cross-references `*.tsv` cache files for metadata.

---

## How to Run

### Setup

```bash
# 1. Create .env with your GitHub token (needs 'gist' scope)
#    Get one at: https://github.com/settings/tokens
echo 'GITHUB_TOKEN=ghp_your_token_here' > .env

# 2. Launch all monitors
./start_all.sh

# 3. Stop all monitors
./start_all.sh stop
```

### Running a Single Source

```bash
./monitor.sh sources/nyt.conf              # logs to nyt_changes.log
./monitor.sh sources/bbc.conf my_log.txt   # custom log file
```

### Adding a New Source

1. Create `sources/newsource.conf` with `SOURCE_NAME`, `SOURCE_DESCRIPTION`, and `FEEDS` array
2. Add the source key to the `SOURCES` array in `start_all.sh`
3. Run `./start_all.sh` — it will auto-create the cache dir and master gist

### Monitoring

Logs are the source of truth. Useful commands:

```bash
# Check which monitors are running
ps aux | grep monitor.sh

# See latest changes
tail -20 nyt_changes.log

# Count unique articles per source
wc -l .cache_*/seen_guids.txt

# Check GitHub API rate limit
curl -s -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/rate_limit | python3 -c "import json,sys; d=json.load(sys.stdin)['rate']; print(f'{d[\"remaining\"]}/{d[\"limit\"]}')"
```

---

## What We Tried

### 1. NYT-Only Monitor (monitor_nyt.sh) — Superseded

The first version was a hardcoded NYT-only script polling 10 feeds every 10 seconds. It worked but wasn't generalizable. We refactored into `monitor.sh` with source config files. The old `monitor_nyt.sh` is still in the directory but is no longer used.

### 2. No Dedup — Caused Guardian Feed Churn

Initially, we only diffed against the previous poll's snapshot. The Guardian's feeds aggressively cycle articles in and out — the same 3-4 articles would toggle every minute, generating dozens of duplicate gists. We fixed this by adding `seen_guids.txt`: a persistent file of every GUID ever reported as NEW. Once an article is reported, it's never re-reported even if it leaves and re-enters the feed. This completely solved the churn problem.

### 3. NYT Sitemap Scraper (monitor_nyt_sitemap.sh) — Partially Successful

**Goal:** Compare RSS discovery time vs the NYT daily sitemap (`https://www.nytimes.com/sitemap/2026/04/15/`) to see which finds articles first.

**What the sitemap provides:** HTML page listing all articles published that day with URLs and titles. No timestamps, no descriptions — just links.

**Implementation:** Polls both RSS feeds and the sitemap every 60s, maintains an article database (`article_db.tsv`) tracking first-seen-in-RSS and first-seen-in-sitemap timestamps per URL, then computes which source discovered each article first.

**Results (624 articles tracked):**
- 305 found in both, 196 RSS-only, 123 sitemap-only
- RSS won 70 head-to-head, sitemap won 102, 133 tied (simultaneous detection)
- When RSS wins, median margin: 3 minutes
- When sitemap wins, median margin: 2 minutes
- The ties are mostly from the initial seed pass where both were polled in the same loop iteration

**Key insight:** RSS and sitemap are roughly equal for articles both cover, but they cover *different* content. RSS feeds miss niche sections (Cooking, Style, Corrections, Crosswords), while the sitemap misses articles from previous days that are still in RSS feeds. The sitemap is a snapshot of *today's* articles only.

**Problems encountered:**
- Initial seed pass tried to update the gist ~340 times in a burst, hitting the GitHub API rate limit (5,000/hour). Recovered after the limit reset.
- The `while read | pipe` pattern in bash spawned too many subprocesses on first version. Rewrote to use temp files and sequential processing.
- Gist updates for the comparison table had escaping issues with bash heredocs containing special characters. Switched to Python `json.dumps()` for reliable JSON escaping.

**Verdict:** The sitemap scraper works but adds complexity for marginal value. RSS is the better primary data source. The sitemap is useful only if you need to discover articles in sections not covered by RSS feeds.

### 4. 10-Second Polling — Reduced to 60 Seconds

We initially polled every 10 seconds. This was unnecessarily aggressive — RSS feeds don't update that fast, and it wastes bandwidth. 60-second polling captures the same articles with the same latency (since latency is measured from pubDate, not from the previous poll). The only thing faster polling could improve is reducing the ~30s average detection delay within a polling cycle.

### 5. GitHub API Rate Limiting

At peak (6 monitors + sitemap all creating gists on every change), we hit the 5,000 requests/hour GitHub API limit. The main offender was the sitemap monitor's initial seed burst. In steady state, the rate was ~200 calls/hour, well within limits. The fix was to batch-update the gist only once per polling round rather than per-article.

---

## Insights from 67 Hours of Monitoring

### Latency by Source (fresh articles <1 hour old)

| Source | Median | Best | P10 | P90 | Fresh/Total |
|--------|--------|------|-----|-----|-------------|
| **WSJ** | **2m 46s** | 16s | 1m 30s | 4m 14s | 227/329 |
| **NYT** | 3m 41s | 7s | 1m 28s | 10m 5s | 340/377 |
| **NPR** | 4m 5s | 57s | 1m 57s | 8m 44s | 95/103 |
| **BBC** | 4m 15s | 22s | 44s | 38m 34s | 194/418 |
| **Guardian** | 7m 59s | 44s | 4m 27s | 14m 25s | 308/473 |
| **Al Jazeera** | 14m 53s | 2m 3s | 6m 45s | 29m 33s | 205/205 |

**Overall:** 1,369 fresh articles, median 5m 9s, avg 8m 30s.

### Source Characteristics

**WSJ** — Fastest and most consistent. Sub-5 min on 75% of articles. Extremely tight P10-P90 spread. Best for financial/earnings data (catches earnings releases within 1-3 minutes of publication). Set the all-time speed record at 16 seconds. Almost no old-article churn.

**NYT** — Strong on breaking US news. Massive batch publishes at ~5am ET (30+ articles in one poll). Also publishes throughout the day with good sub-5-min latency. Live blog updates can be detected in under 10 seconds. Publishes the most opinion pieces overnight.

**BBC** — Most bimodal: incredibly fast on breaking news (22-25s records) but also loads its feeds with articles from days/weeks ago (podcast episodes, evergreen content). Only 194/418 articles were fresh (<1h). Best for UK domestic news, health, and science.

**Guardian** — Highest volume (452 unique articles) but heaviest feed churn. Feeds cycle articles in and out every 1-2 minutes, which caused major issues before dedup was added. Fresh article latency (median 8min) is reasonable. Covers the broadest range of topics including Books, Environment, and extensive US coverage. Strong on Australian news due to its Australian edition.

**NPR** — Smallest feed (capped at 10 items per section) but very efficient — 95/103 articles were fresh. Does morning batch publishes similar to NYT. Good for US politics and science.

**Al Jazeera** — Slowest median latency (15min) but 100% of articles are fresh (no old-content churn at all). Only 1 feed (All), so coverage is curated. Uniquely strong on Middle East conflict coverage, perspectives Western outlets don't carry. Led the Lebanon-Israel ceasefire story by 3 hours before any other source.

### Publishing Patterns

- **NYT** publishes its entire morning edition at once (~5am ET). 30 articles appear in a single 60-second poll.
- **NPR** does a similar morning batch (~4am CDT, 8 articles).
- **WSJ** streams European earnings individually throughout the London morning, each within 2-5 minutes.
- **BBC** and **Guardian** have the heaviest feed rotation — articles cycle in and out throughout the day. BBC's Technology section loaded 16 articles at once when first polled.
- **9-10pm CDT** is consistently the quietest period across all sources (US evening, UK late night, Asia not yet morning).
- **Midnight-1am CDT** sees a pickup as BBC/Guardian start UK morning content.
- **4-5am CDT** is the biggest burst: NYT morning dump + WSJ European earnings + BBC World refresh + NPR morning brief.

### Cross-Source Story Propagation

We tracked several stories across all 6 sources. Key findings:

**Speed hierarchy for breaking news:** NYT and WSJ consistently first on US domestic/financial. BBC fastest on UK/Commonwealth. Al Jazeera leads on Middle East by hours. Guardian is rarely first but covers the broadest angles.

**Notable propagation timelines:**

- **Geelong refinery fire** — 24-hour lifecycle across all 6 sources: WSJ broke it (2m 59s) → Guardian fuel price impact (11m) → BBC "unprecedented" (5h) → Al Jazeera Iran war fuel context → fire extinguished → PM visits → government says no restrictions
- **Lebanon-Israel ceasefire** — Al Jazeera first by 3 hours, then BBC, NYT, NPR. Al Jazeera published 7+ articles on it before BBC's first standalone piece
- **UK GDP data** — Guardian first (6m 8s) → BBC (3m 25s) → WSJ (47s). WSJ had the fastest latency but was last by clock time
- **Jet fuel 6-week supply** — Took 7 hours to propagate through all 6 sources (NYT → Guardian → WSJ → BBC → Al Jazeera)
- **Mandelson vetting scandal** — 7 articles across 5 sources over 10 hours: Guardian broke it → BBC political fallout → NYT Epstein connection → Al Jazeera PM under fire → BBC official resigns → BBC "nightmare" analysis

**Framing differences on same story:**
- Lebanon ceasefire: NYT "forced into a corner", Al Jazeera "Trump forced Israel", BBC neutral
- Hormuz blockade: NYT says "Strait of Hormuz blockade", Al Jazeera reports US general clarifying "only Iranian ports, not the Strait" — factual disagreement
- Iran war: Al Jazeera covers anti-war protests, Lego propaganda videos; Western outlets focus on economic impact, diplomacy

### Feed Reliability

- All 6 sources had 100% uptime over 67 hours — no feed ever went down or returned errors
- RSS pubDate format is consistent (RFC 2822) across all sources. NPR uses numeric timezone offset (-0400), others use GMT. Both parse fine.
- **CNN** was originally considered but their feeds had stale data from 2023. **Reuters** and **AP** have no public RSS feeds. **USA Today** redirects RSS URLs to HTML.
- Al Jazeera has only 1 feed (all content in one). This makes it the simplest to monitor but means we can't filter by section.

### GitHub Gist as a Publishing Backend

Gists work but have limitations:
- Rate limit of 5,000 API calls/hour means ~1,600 gist operations/hour max (each takes ~3 calls)
- Large gists with many table rows get slow to update (fetch + modify + push)
- No built-in way to organize gists hierarchically — we used a master-of-masters pattern
- Secret gists are not truly private — anyone with the URL can view them

---

## Existing GitHub Gists

These gists contain the live data from the 67-hour run:

- **Master Dashboard:** https://gist.github.com/jonters/1eed872c97676bc907fb12240aa31ea1
- **NYT Index:** https://gist.github.com/jonters/724c27e028de305e07f09ac42d0afecb
- **BBC Index:** https://gist.github.com/jonters/4306d63b9a64c85414dc2623f1bb404f
- **WSJ Index:** https://gist.github.com/jonters/a837ff6897e6b7374aed267821be7cff
- **Guardian Index:** https://gist.github.com/jonters/d2f5b34b217a7b3be2956c14e8e3adce
- **NPR Index:** https://gist.github.com/jonters/69c475d23a1ebc1477548d627418d365
- **Al Jazeera Index:** https://gist.github.com/jonters/c562bef27884216038e12e59f23b61ad
- **NYT RSS vs Sitemap:** https://gist.github.com/jonters/c94e93e21fcd91d03df3c2b08c87809f

---

## Known Issues and Future Improvements

1. **Guardian gist count is inflated** — even with dedup, DROP events still create gists when articles leave the feed. Could suppress gists that only contain drops and no new articles.
2. **No persistent article database** — the CSV is regenerated from logs. A proper database (SQLite) would enable richer queries and cross-source matching.
3. **Cross-source matching is manual** — we identified same-story-different-source by reading titles. An automated fuzzy matcher (title similarity, entity extraction) would enable systematic cross-source analysis.
4. **Sitemap monitor died mid-run** — the NYT sitemap monitor stopped at some point during the 67-hour run (process not found at hour 67). The RSS monitors were unaffected. The sitemap script needs better error handling and auto-restart.
5. **BBC and Guardian feed churn wastes gists** — articles cycling in/out generate drop-only gists. Could batch changes and only publish gists at fixed intervals (e.g., every 5 minutes) rather than every poll.
6. **No summary for all articles** — RSS descriptions vary by source. WSJ gives good summaries, Al Jazeera gives nothing, NYT is mixed. Full article text would require fetching the actual pages.
7. **Al Jazeera has only 1 feed** — they may have section-specific feeds not discovered. Worth investigating.
