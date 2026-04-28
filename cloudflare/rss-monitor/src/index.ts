/**
 * RSS Monitor Worker
 *
 * - Cron trigger (every minute): spawns one RSSMonitorWorkflow per source.
 * - Fetch handler: serves a dashboard UI + JSON API for viewing the D1 database.
 *
 * API routes:
 *   GET /api/articles?source=&section=&limit=&offset=
 *   GET /api/events?source=&limit=
 *   GET /api/stats
 *   GET /          — dashboard HTML
 */

import { SOURCES } from "./sources";
export { RSSMonitorWorkflow } from "./workflow";

export interface Env {
  RSS_WORKFLOW: Workflow;
  rss_monitor: D1Database;
}

// ── API helpers ──────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleApi(url: URL, env: Env): Promise<Response> {
  const path = url.pathname;

  // POST /api/trigger?source=nyt  — manually fire a workflow instance for one source.
  // GET  /api/debug?source=nyt    — test fetch + D1 write without the workflow.
  if (path === "/api/trigger") {
    const sourceName = url.searchParams.get("source");
    const source = SOURCES.find((s) => s.name === sourceName) ?? SOURCES[0];
    const instance = await env.RSS_WORKFLOW.create({ params: { source } });
    return json({ instance_id: instance.id, source: source.name });
  }

  if (path === "/api/debug") {
    const sourceName = url.searchParams.get("source") ?? "npr";
    const source = SOURCES.find((s) => s.name === sourceName) ?? SOURCES[0];

    // Pick the first feed for the source and try to fetch it.
    const [section, feedUrl] = Object.entries(source.feeds)[0];
    let fetchStatus: number | string;
    let itemCount = 0;
    let parseError: string | null = null;

    try {
      const resp = await fetch(feedUrl, { headers: { "User-Agent": "rss-monitor/1.0" } });
      fetchStatus = resp.status;
      if (resp.ok) {
        const { parseFeed } = await import("./rss");
        const items = parseFeed(await resp.text());
        itemCount = items.length;
      }
    } catch (e) {
      fetchStatus = "error";
      parseError = String(e);
    }

    // Check D1 table counts.
    const [a, s, e] = await Promise.all([
      env.rss_monitor.prepare("SELECT COUNT(*) AS n FROM articles").first<{ n: number }>(),
      env.rss_monitor.prepare("SELECT COUNT(*) AS n FROM feed_snapshots").first<{ n: number }>(),
      env.rss_monitor.prepare("SELECT COUNT(*) AS n FROM feed_events").first<{ n: number }>(),
    ]);

    return json({
      feed_test: { source: source.name, section, url: feedUrl, http_status: fetchStatus, items_parsed: itemCount, error: parseError },
      d1_row_counts: { articles: a?.n ?? 0, feed_snapshots: s?.n ?? 0, feed_events: e?.n ?? 0 },
    });
  }


  // GET /api/articles
  if (path === "/api/articles") {
    const source  = url.searchParams.get("source") ?? null;
    const section = url.searchParams.get("section") ?? null;
    const q       = url.searchParams.get("q")?.trim() || null;
    const start   = url.searchParams.get("start")?.trim() || null;
    const end     = url.searchParams.get("end")?.trim() || null;
    const limit   = Math.min(parseInt(url.searchParams.get("limit")  ?? "50"), 200);
    const offset  = parseInt(url.searchParams.get("offset") ?? "0");

    const bareDate = /^\d{4}-\d{2}-\d{2}$/;
    const startTs = start ? (bareDate.test(start) ? start + "T00:00:00Z"     : start) : null;
    const endTs   = end   ? (bareDate.test(end)   ? end   + "T23:59:59.999Z" : end)   : null;

    let query = "SELECT * FROM articles WHERE 1=1";
    const bindings: (string | number)[] = [];
    if (source)  { query += " AND source = ?";  bindings.push(source); }
    if (section) { query += " AND section = ?"; bindings.push(section); }
    if (startTs) { query += " AND detected_at >= ?"; bindings.push(startTs); }
    if (endTs)   { query += " AND detected_at <= ?"; bindings.push(endTs); }
    if (q) {
      query += " AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')";
      const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
      bindings.push(like, like);
    }
    query += " ORDER BY detected_at DESC LIMIT ? OFFSET ?";
    bindings.push(limit, offset);

    const { results } = await env.rss_monitor.prepare(query).bind(...bindings).all();
    return json(results);
  }

  // GET /api/sections?source=
  if (path === "/api/sections") {
    const source = url.searchParams.get("source") ?? null;
    let query = "SELECT DISTINCT section FROM articles";
    const bindings: (string | number)[] = [];
    if (source) { query += " WHERE source = ?"; bindings.push(source); }
    query += " ORDER BY section";
    const { results } = await env.rss_monitor.prepare(query).bind(...bindings).all<{ section: string }>();
    return json(results.map(r => r.section));
  }

  // GET /api/events
  if (path === "/api/events") {
    const source = url.searchParams.get("source") ?? null;
    const limit  = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);

    let query = "SELECT * FROM feed_events WHERE 1=1";
    const bindings: (string | number)[] = [];
    if (source) { query += " AND source = ?"; bindings.push(source); }
    query += " ORDER BY detected_at DESC LIMIT ?";
    bindings.push(limit);

    const { results } = await env.rss_monitor.prepare(query).bind(...bindings).all();
    return json(results);
  }

  // GET /api/stats
  if (path === "/api/stats") {
    const [{ results: meta }, { results: latRows }] = await Promise.all([
      env.rss_monitor.prepare(`
        SELECT source, COUNT(*) AS total_articles, MIN(detected_at) AS first_seen, MAX(detected_at) AS last_seen
        FROM articles GROUP BY source ORDER BY source
      `).all<{ source: string; total_articles: number; first_seen: string; last_seen: string }>(),
      env.rss_monitor.prepare(`
        SELECT source, latency_ms FROM articles WHERE latency_ms IS NOT NULL ORDER BY source, latency_ms
      `).all<{ source: string; latency_ms: number }>(),
    ]);

    const latMap: Record<string, number[]> = {};
    for (const r of latRows) {
      (latMap[r.source] ??= []).push(r.latency_ms);
    }

    function pct(sorted: number[], p: number): number | null {
      if (!sorted.length) return null;
      const idx = (p / 100) * (sorted.length - 1);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      return Math.round((sorted[lo] + sorted[hi]) / 2);
    }

    const results = meta.map(row => {
      const lats = latMap[row.source] ?? [];
      return {
        source: row.source,
        total_articles: row.total_articles,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
        min_latency_ms:    lats.length ? lats[0] : null,
        median_latency_ms: pct(lats, 50),
        p90_latency_ms:    pct(lats, 90),
      };
    });
    return json(results);
  }

  return json({ error: "not found" }, 404);
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>UCF RSS Monitor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #222; }
    header { background: #1a1a2e; color: #fff; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 1.2rem; font-weight: 600; }
    .badge { background: #e94560; color: #fff; border-radius: 9999px; padding: 2px 10px; font-size: 0.75rem; }
    main { max-width: 1200px; margin: 24px auto; padding: 0 16px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .stat-card { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    .stat-card .label { font-size: 0.75rem; color: #666; text-transform: uppercase; letter-spacing: .05em; }
    .stat-card .value { font-size: 1.6rem; font-weight: 700; margin-top: 4px; }
    .stat-card .sub { font-size: 0.75rem; color: #888; margin-top: 2px; }
    .controls { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
    select, input { padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.9rem; background: #fff; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    th { background: #1a1a2e; color: #fff; text-align: left; padding: 10px 14px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }
    td { padding: 10px 14px; border-bottom: 1px solid #f0f0f0; font-size: 0.875rem; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafafa; }
    .source-pill { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; }
    .src-nyt { background:#ffe0e0; color:#900; }
    .src-bbc { background:#e0eaff; color:#004; }
    .src-wsj { background:#fff3cd; color:#664d03; }
    .src-guardian { background:#e0f5e0; color:#1a4d1a; }
    .src-npr { background:#fce4ec; color:#880e4f; }
    .src-aljazeera { background:#e8eaf6; color:#283593; }
    .src-cnn { background:#fce8e8; color:#c00000; }
    .latency { color: #666; white-space: nowrap; }
    .latency.fast { color: #2e7d32; }
    .latency.slow { color: #c62828; }
    .title-cell { max-width: 480px; }
    .title-cell a { color: #1a1a2e; text-decoration: none; }
    .title-cell a:hover { text-decoration: underline; }
    .desc { color: #666; font-size: 0.8rem; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .ts { color: #888; white-space: nowrap; font-size: 0.8rem; }
    .loading { text-align: center; padding: 40px; color: #888; }
    .pagination { display: flex; gap: 8px; align-items: center; margin-top: 16px; justify-content: flex-end; }
    button { padding: 8px 16px; border: 1px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; font-size: 0.875rem; }
    button:hover { background: #f5f5f5; }
    button:disabled { opacity: 0.4; cursor: default; }
    #page-info { font-size: 0.85rem; color: #666; }
  </style>
</head>
<body>
<header>
  <h1>UCF RSS Monitor</h1>
  <span class="badge" id="total-badge">...</span>
  <a href="/docs" style="margin-left:auto;color:#fff;text-decoration:none;font-size:0.85rem;opacity:.85">API docs →</a>
</header>
<main>
  <div class="stats-grid" id="stats-grid"><div class="loading">Loading stats…</div></div>
  <div class="controls">
    <select id="filter-source">
      <option value="">All sources</option>
      <option>nyt</option><option>bbc</option><option>wsj</option>
      <option>guardian</option><option>npr</option><option>aljazeera</option><option>cnn</option>
    </select>
    <select id="filter-section"><option value="">All sections</option></select>
    <input id="filter-search" type="search" placeholder="Search titles…" style="flex:1;min-width:180px" />
  </div>
  <table>
    <thead>
      <tr>
        <th>Source</th><th>Section</th><th class="title-cell">Title</th>
        <th>Latency</th><th>Detected</th>
      </tr>
    </thead>
    <tbody id="articles-body"><tr><td colspan="5" class="loading">Loading…</td></tr></tbody>
  </table>
  <div class="pagination">
    <button id="btn-prev" disabled>← Prev</button>
    <span id="page-info"></span>
    <button id="btn-next">Next →</button>
  </div>
</main>

<script>
  const LIMIT = 50;
  let offset = 0;
  let totalShown = 0;

  const sourceEl  = document.getElementById('filter-source');
  const sectionEl = document.getElementById('filter-section');
  const searchEl  = document.getElementById('filter-search');
  const tbody     = document.getElementById('articles-body');
  const prevBtn   = document.getElementById('btn-prev');
  const nextBtn   = document.getElementById('btn-next');
  const pageInfo  = document.getElementById('page-info');

  function fmtLatency(ms) {
    if (ms == null) return '—';
    const s = ms / 1000;
    if (s < 60)   return s.toFixed(0) + 's';
    if (s < 3600) return (s/60).toFixed(0) + 'm';
    return (s/3600).toFixed(1) + 'h';
  }

  function latencyClass(ms) {
    if (ms == null) return '';
    if (ms < 120000) return 'fast';   // under 2 min
    if (ms > 900000) return 'slow';   // over 15 min
    return '';
  }

  function fmtTs(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  function fmtLatMs(ms) {
    if (ms == null) return '—';
    const s = ms / 1000;
    if (s < 60)   return s.toFixed(0) + 's';
    if (s < 3600) return (s / 60).toFixed(0) + 'm';
    return (s / 3600).toFixed(1) + 'h';
  }

  async function loadStats() {
    const data = await fetch('/api/stats').then(r => r.json());
    const grid = document.getElementById('stats-grid');
    let totalArticles = 0;
    grid.innerHTML = data.map(row => {
      totalArticles += row.total_articles;
      return \`<div class="stat-card">
        <div class="label">\${row.source}</div>
        <div class="value">\${row.total_articles.toLocaleString()}</div>
        <div class="sub">min \${fmtLatMs(row.min_latency_ms)} · p50 \${fmtLatMs(row.median_latency_ms)} · p90 \${fmtLatMs(row.p90_latency_ms)}</div>
      </div>\`;
    }).join('');
    document.getElementById('total-badge').textContent = totalArticles.toLocaleString() + ' articles';
  }

  async function loadArticles() {
    tbody.innerHTML = '<tr><td colspan="5" class="loading">Loading…</td></tr>';
    const params = new URLSearchParams({ limit: LIMIT, offset });
    if (sourceEl.value)  params.set('source',  sourceEl.value);
    if (sectionEl.value) params.set('section', sectionEl.value);
    if (searchEl.value.trim()) params.set('q', searchEl.value.trim());
    const rows = await fetch('/api/articles?' + params).then(r => r.json());

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="loading">No articles found.</td></tr>';
      nextBtn.disabled = true;
      prevBtn.disabled = offset === 0;
      pageInfo.textContent = '';
      return;
    }

    tbody.innerHTML = rows.map(r => \`
      <tr>
        <td><span class="source-pill src-\${r.source}">\${r.source}</span></td>
        <td>\${r.section}</td>
        <td class="title-cell">
          <a href="\${r.guid.startsWith('http') ? r.guid : '#'}" target="_blank" rel="noopener">\${r.title}</a>
          \${r.description ? \`<div class="desc">\${r.description}</div>\` : ''}
        </td>
        <td class="latency \${latencyClass(r.latency_ms)}">\${fmtLatency(r.latency_ms)}</td>
        <td class="ts">\${fmtTs(r.detected_at)}</td>
      </tr>
    \`).join('');

    totalShown = rows.length;
    prevBtn.disabled = offset === 0;
    nextBtn.disabled = rows.length < LIMIT;
    pageInfo.textContent = \`Showing \${offset + 1}–\${offset + rows.length}\`;
  }

  async function loadSections() {
    const source = sourceEl.value;
    const url = source ? \`/api/sections?source=\${source}\` : '/api/sections';
    const sections = await fetch(url).then(r => r.json());
    sectionEl.innerHTML = '<option value="">All sections</option>' +
      sections.map(s => \`<option>\${s}</option>\`).join('');
  }

  prevBtn.onclick = () => { offset = Math.max(0, offset - LIMIT); loadArticles(); };
  nextBtn.onclick = () => { offset += LIMIT; loadArticles(); };

  sourceEl.onchange = async () => {
    offset = 0;
    await loadSections();
    loadArticles();
  };
  sectionEl.onchange = () => { offset = 0; loadArticles(); };

  let searchTimer;
  searchEl.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { offset = 0; loadArticles(); }, 300);
  };

  loadStats();
  loadSections();
  loadArticles();
</script>
</body>
</html>`;

// ── API docs HTML ─────────────────────────────────────────────────────────────

const DOCS_HTML = `<!DOCTYPE html>
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
</main>
</body>
</html>`;

// ── Main export ───────────────────────────────────────────────────────────────

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    for (const source of SOURCES) {
      await env.RSS_WORKFLOW.create({ params: { source } });
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(url, env);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    if (url.pathname === "/docs") {
      return new Response(DOCS_HTML, {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
