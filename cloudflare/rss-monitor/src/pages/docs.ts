export const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>UCF RSS Monitor — API Docs</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #222; line-height: 1.5; }
    header { background: #1a1a2e; color: #fff; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 1.2rem; font-weight: 600; }
    header a { color: #fff; text-decoration: none; font-size: 0.85rem; opacity: .85; margin-left: auto; }
    main { max-width: 880px; margin: 24px auto; padding: 0 16px 48px; }
    .intro { background: #fff; border-radius: 8px; padding: 18px 22px; box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 20px; font-size: 0.92rem; color: #444; }
    .intro code { background: #f0f0f0; padding: 1px 6px; border-radius: 4px; font-size: 0.85rem; }
    .endpoint { background: #fff; border-radius: 8px; padding: 18px 22px; box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 16px; }
    .endpoint h2 { font-size: 1rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-bottom: 6px; display: flex; align-items: center; gap: 10px; }
    .method { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; letter-spacing: .04em; }
    .method.get  { background: #e0f5e0; color: #1a4d1a; }
    .method.post { background: #fff3cd; color: #664d03; }
    .method.delete { background: #fce8e8; color: #c00000; }
    .endpoint p.desc { color: #555; font-size: 0.9rem; margin: 8px 0 12px; }
    .endpoint h3 { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .06em; color: #888; margin-top: 14px; margin-bottom: 6px; }
    table.params { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    table.params th, table.params td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
    table.params th { color: #666; font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: .04em; }
    table.params td:first-child { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; color: #1a1a2e; }
    table.params td:nth-child(2) { color: #888; white-space: nowrap; }
    pre { background: #1a1a2e; color: #d8d8e8; padding: 12px 14px; border-radius: 6px; font-size: 0.8rem; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
<header>
  <h1>UCF RSS Monitor — API</h1>
  <a href="/">← Dashboard</a>
</header>
<main>
  <div class="intro">
    All endpoints return JSON. Base path is the deployed Worker origin. Sources are one of
    <code>nyt</code>, <code>bbc</code>, <code>wsj</code>, <code>guardian</code>, <code>npr</code>,
    <code>aljazeera</code>, <code>cnn</code>.
  </div>

  <div class="endpoint">
    <h2><span class="method get">GET</span> /api/articles</h2>
    <p class="desc">List articles from the database, newest first. Supports filtering by source, section, and a free-text search across title and description.</p>
    <h3>Query parameters</h3>
    <table class="params">
      <tr><th>Name</th><th>Type</th><th>Description</th></tr>
      <tr><td>source</td>  <td>string</td> <td>Filter to one source (e.g. <code>nyt</code>).</td></tr>
      <tr><td>section</td> <td>string</td> <td>Filter to one section (e.g. <code>world</code>).</td></tr>
      <tr><td>q</td>       <td>string</td> <td>Substring match on title or description (case-insensitive).</td></tr>
      <tr><td>start</td>   <td>date</td>   <td>Lower bound on <code>detected_at</code> (inclusive). Accepts <code>YYYY-MM-DD</code> (treated as start-of-day UTC) or a full ISO timestamp.</td></tr>
      <tr><td>end</td>     <td>date</td>   <td>Upper bound on <code>detected_at</code> (inclusive). Accepts <code>YYYY-MM-DD</code> (treated as end-of-day UTC) or a full ISO timestamp.</td></tr>
      <tr><td>limit</td>   <td>int</td>    <td>Max rows to return. Default 50, capped at 200.</td></tr>
      <tr><td>offset</td>  <td>int</td>    <td>Row offset for pagination. Default 0.</td></tr>
    </table>
    <h3>Example</h3>
    <pre>GET /api/articles?source=bbc&q=ukraine&start=2026-04-01&end=2026-04-27&limit=20</pre>
  </div>

  <div class="endpoint">
    <h2><span class="method get">GET</span> /api/sections</h2>
    <p class="desc">List the distinct section values found in the articles table, optionally scoped to a single source. Useful for populating a section dropdown.</p>
    <h3>Query parameters</h3>
    <table class="params">
      <tr><th>Name</th><th>Type</th><th>Description</th></tr>
      <tr><td>source</td> <td>string</td> <td>Limit sections to those seen for this source.</td></tr>
    </table>
    <h3>Example</h3>
    <pre>GET /api/sections?source=guardian</pre>
  </div>

  <div class="endpoint">
    <h2><span class="method get">GET</span> /api/events</h2>
    <p class="desc">List feed-level events (poll attempts, parse outcomes, errors) recorded by the workflow, newest first.</p>
    <h3>Query parameters</h3>
    <table class="params">
      <tr><th>Name</th><th>Type</th><th>Description</th></tr>
      <tr><td>source</td> <td>string</td> <td>Filter to one source.</td></tr>
      <tr><td>limit</td>  <td>int</td>    <td>Max rows. Default 50, capped at 200.</td></tr>
    </table>
    <h3>Example</h3>
    <pre>GET /api/events?source=npr&limit=100</pre>
  </div>

  <div class="endpoint">
    <h2><span class="method get">GET</span> /api/stats</h2>
    <p class="desc">Per-source aggregates: total articles, first/last detection timestamps, and detection-latency percentiles (min, p50, p90) computed from the articles table.</p>
    <h3>Example response</h3>
    <pre>[
  {
    "source": "bbc",
    "total_articles": 1234,
    "first_seen": "2026-01-12T09:21:03Z",
    "last_seen":  "2026-04-27T18:42:11Z",
    "min_latency_ms": 30000,
    "median_latency_ms": 92000,
    "p90_latency_ms": 480000
  }
]</pre>
  </div>

  <div class="endpoint">
    <h2><span class="method get">GET</span> /api/debug</h2>
    <p class="desc">Smoke-test endpoint: fetches the first feed for the chosen source, parses it, and reports row counts in the D1 tables. Does not write to the database.</p>
    <h3>Query parameters</h3>
    <table class="params">
      <tr><th>Name</th><th>Type</th><th>Description</th></tr>
      <tr><td>source</td> <td>string</td> <td>Source to test. Defaults to <code>npr</code>.</td></tr>
    </table>
    <h3>Example</h3>
    <pre>GET /api/debug?source=wsj</pre>
  </div>

  <div class="endpoint">
    <h2><span class="method post">POST</span> /api/trigger</h2>
    <p class="desc">Manually create one <code>RSSMonitorWorkflow</code> instance for the given source, instead of waiting for the next cron tick. Returns the new workflow instance id.</p>
    <h3>Query parameters</h3>
    <table class="params">
      <tr><th>Name</th><th>Type</th><th>Description</th></tr>
      <tr><td>source</td> <td>string</td> <td>Source to run. Falls back to the first configured source if missing or unknown.</td></tr>
    </table>
    <h3>Example</h3>
    <pre>POST /api/trigger?source=cnn</pre>
  </div>

  <div class="endpoint">
    <h2><span class="method get">GET</span> /api/markets</h2>
    <p class="desc">List all Kalshi markets stored in the <code>kalshi_markets</code> table. The <code>keywords</code> field is returned as a JSON array of strings.</p>
    <h3>Example response</h3>
    <pre>[
  {
    "market_id": "KXPRES-26-DJT",
    "title": "Will Donald Trump remain president on Dec 31 2026?",
    "description": "Resolves Yes if Donald Trump is the sitting US president on Dec 31 2026.",
    "keywords": ["trump", "president", "white house"]
  }
]</pre>
  </div>

  <div class="endpoint">
    <h2><span class="method post">POST</span> /api/markets</h2>
    <p class="desc">Insert or replace a Kalshi market row, keyed by <code>market_id</code>. Body must be <code>application/json</code>.</p>
    <h3>Body fields</h3>
    <table class="params">
      <tr><th>Name</th><th>Type</th><th>Description</th></tr>
      <tr><td>market_id</td>   <td>string</td>            <td>Required. Kalshi market ID (used as primary key).</td></tr>
      <tr><td>title</td>       <td>string</td>            <td>Required. Kalshi market title.</td></tr>
      <tr><td>description</td> <td>string</td>            <td>Optional. Market description.</td></tr>
      <tr><td>keywords</td>    <td>string[] or string</td><td>Required. Array of keyword strings, or a comma-separated string. Empty values are dropped.</td></tr>
    </table>
    <h3>Example</h3>
    <pre>POST /api/markets
Content-Type: application/json

{
  "market_id": "KXPRES-26-DJT",
  "title": "Will Donald Trump remain president on Dec 31 2026?",
  "description": "Resolves Yes if ...",
  "keywords": ["trump", "president", "white house"]
}</pre>
  </div>

  <div class="endpoint">
    <h2><span class="method delete">DELETE</span> /api/markets</h2>
    <p class="desc">Delete a Kalshi market by ID.</p>
    <h3>Query parameters</h3>
    <table class="params">
      <tr><th>Name</th><th>Type</th><th>Description</th></tr>
      <tr><td>id</td> <td>string</td> <td>Required. The <code>market_id</code> to delete.</td></tr>
    </table>
    <h3>Example</h3>
    <pre>DELETE /api/markets?id=KXPRES-26-DJT</pre>
  </div>
</main>
</body>
</html>`;
