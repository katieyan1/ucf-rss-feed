export const MARKETS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>UCF RSS Monitor — Kalshi Markets</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #222; }
    header { background: #1a1a2e; color: #fff; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 1.2rem; font-weight: 600; }
    header nav { margin-left: auto; display: flex; gap: 16px; }
    header nav a { color: #fff; text-decoration: none; font-size: 0.85rem; opacity: .85; }
    header nav a:hover { opacity: 1; }
    .badge { background: #e94560; color: #fff; border-radius: 9999px; padding: 2px 10px; font-size: 0.75rem; }
    main { max-width: 1100px; margin: 24px auto; padding: 0 16px 48px; }
    .card { background: #fff; border-radius: 8px; padding: 20px 22px; box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 20px; }
    .card h2 { font-size: 1rem; margin-bottom: 14px; color: #1a1a2e; }
    form .row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
    form label { font-size: 0.72rem; color: #666; text-transform: uppercase; letter-spacing: .05em; }
    form input, form textarea {
      padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px;
      font-size: 0.9rem; background: #fff; font-family: inherit;
    }
    form textarea { resize: vertical; min-height: 60px; }
    form .hint { font-size: 0.75rem; color: #888; margin-top: 2px; }
    form .actions { display: flex; align-items: center; gap: 12px; margin-top: 4px; }
    button { padding: 8px 16px; border: 1px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; font-size: 0.875rem; }
    button:hover { background: #f5f5f5; }
    button.primary { background: #1a1a2e; color: #fff; border-color: #1a1a2e; }
    button.primary:hover { background: #2a2a4e; }
    button.danger { color: #c00; border-color: #f0c8c8; }
    button.danger:hover { background: #fdecec; }
    button:disabled { opacity: 0.5; cursor: default; }
    .form-msg { font-size: 0.85rem; }
    .form-msg.ok  { color: #2e7d32; }
    .form-msg.err { color: #c62828; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    th { background: #1a1a2e; color: #fff; text-align: left; padding: 10px 14px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }
    td { padding: 10px 14px; border-bottom: 1px solid #f0f0f0; font-size: 0.875rem; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .market-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; color: #1a1a2e; }
    .desc-cell { color: #555; max-width: 320px; }
    .keywords-cell { max-width: 280px; }
    .kw-pill { display: inline-block; background: #eef; color: #225; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; margin: 2px 4px 2px 0; }
    .loading { text-align: center; padding: 40px; color: #888; }
  </style>
</head>
<body>
<header>
  <h1>Kalshi Markets</h1>
  <span class="badge" id="count-badge">…</span>
  <nav>
    <a href="/">← Dashboard</a>
    <a href="/docs">API docs →</a>
  </nav>
</header>
<main>
  <div class="card">
    <h2>Add or update a market</h2>
    <form id="market-form">
      <div class="row">
        <label for="f-id">Market ID</label>
        <input id="f-id" name="market_id" required placeholder="e.g. KXPRES-26-DJT" />
        <div class="hint">Used as primary key. Submitting an existing ID overwrites the row.</div>
      </div>
      <div class="row">
        <label for="f-title">Title</label>
        <input id="f-title" name="title" required placeholder="Will Donald Trump remain president on Dec 31 2026?" />
      </div>
      <div class="row">
        <label for="f-desc">Description</label>
        <textarea id="f-desc" name="description" placeholder="Resolves Yes if ..."></textarea>
      </div>
      <div class="row">
        <label for="f-keywords">Keywords</label>
        <input id="f-keywords" name="keywords" required placeholder="trump, president, white house" />
        <div class="hint">Comma-separated. Stored as a JSON array.</div>
      </div>
      <div class="actions">
        <button type="submit" class="primary" id="submit-btn">Save market</button>
        <button type="button" id="reset-btn">Clear</button>
        <span class="form-msg" id="form-msg"></span>
      </div>
    </form>
  </div>

  <div class="card" style="padding: 0; overflow: hidden;">
    <table>
      <thead>
        <tr>
          <th>Market ID</th>
          <th>Title</th>
          <th>Description</th>
          <th>Keywords</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="markets-body">
        <tr><td colspan="5" class="loading">Loading…</td></tr>
      </tbody>
    </table>
  </div>
</main>

<script>
  const form     = document.getElementById('market-form');
  const idEl     = document.getElementById('f-id');
  const titleEl  = document.getElementById('f-title');
  const descEl   = document.getElementById('f-desc');
  const kwEl     = document.getElementById('f-keywords');
  const msgEl    = document.getElementById('form-msg');
  const submitBtn= document.getElementById('submit-btn');
  const resetBtn = document.getElementById('reset-btn');
  const tbody    = document.getElementById('markets-body');
  const badgeEl  = document.getElementById('count-badge');

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function setMsg(text, kind) {
    msgEl.textContent = text;
    msgEl.className = 'form-msg ' + (kind || '');
  }

  async function loadMarkets() {
    try {
      const rows = await fetch('/api/markets').then(r => r.json());
      badgeEl.textContent = rows.length + ' market' + (rows.length === 1 ? '' : 's');
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading">No markets yet. Add one above.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(r => \`
        <tr data-id="\${escapeHtml(r.market_id)}">
          <td class="market-id">\${escapeHtml(r.market_id)}</td>
          <td>\${escapeHtml(r.title)}</td>
          <td class="desc-cell">\${escapeHtml(r.description || '—')}</td>
          <td class="keywords-cell">\${
            (r.keywords || []).map(k => \`<span class="kw-pill">\${escapeHtml(k)}</span>\`).join('')
          }</td>
          <td>
            <button type="button" class="edit-btn">Edit</button>
            <button type="button" class="danger delete-btn">Delete</button>
          </td>
        </tr>
      \`).join('');
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="5" class="loading">Failed to load markets.</td></tr>';
    }
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    setMsg('', '');
    submitBtn.disabled = true;

    const keywords = kwEl.value.split(',').map(s => s.trim()).filter(Boolean);
    const payload = {
      market_id: idEl.value.trim(),
      title:     titleEl.value.trim(),
      description: descEl.value.trim() || null,
      keywords,
    };

    try {
      const resp = await fetch('/api/markets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setMsg(data.error || 'Failed to save', 'err');
      } else {
        setMsg('Saved.', 'ok');
        form.reset();
        loadMarkets();
      }
    } catch (err) {
      setMsg(String(err), 'err');
    } finally {
      submitBtn.disabled = false;
    }
  };

  resetBtn.onclick = () => { form.reset(); setMsg('', ''); };

  tbody.addEventListener('click', async (e) => {
    const row = e.target.closest('tr');
    if (!row) return;
    const id = row.dataset.id;

    if (e.target.classList.contains('delete-btn')) {
      if (!confirm('Delete market ' + id + '?')) return;
      const resp = await fetch('/api/markets?id=' + encodeURIComponent(id), { method: 'DELETE' });
      if (resp.ok) loadMarkets(); else setMsg('Delete failed.', 'err');
    } else if (e.target.classList.contains('edit-btn')) {
      const cells = row.children;
      idEl.value    = cells[0].textContent.trim();
      titleEl.value = cells[1].textContent.trim();
      descEl.value  = cells[2].textContent.trim() === '—' ? '' : cells[2].textContent.trim();
      kwEl.value    = Array.from(cells[3].querySelectorAll('.kw-pill')).map(p => p.textContent).join(', ');
      idEl.focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setMsg('Editing existing market — submit to overwrite.', '');
    }
  });

  loadMarkets();
</script>
</body>
</html>`;
