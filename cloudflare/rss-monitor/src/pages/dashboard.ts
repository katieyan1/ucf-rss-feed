export const DASHBOARD_HTML = `<!DOCTYPE html>
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
    header nav { margin-left: auto; display: flex; gap: 16px; }
    header nav a { color: #fff; text-decoration: none; font-size: 0.85rem; opacity: .85; }
    header nav a:hover { opacity: 1; }
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
  <nav>
    <a href="/markets">Kalshi markets →</a>
    <a href="/docs">API docs →</a>
  </nav>
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
