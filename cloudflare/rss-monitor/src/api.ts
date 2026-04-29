import { SOURCES } from "./sources";
import { Env } from "./env";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  // POST /api/trigger?source=nyt  — manually fire a workflow instance for one source.
  if (path === "/api/trigger") {
    const sourceName = url.searchParams.get("source");
    const source = SOURCES.find((s) => s.name === sourceName) ?? SOURCES[0];
    const instance = await env.RSS_WORKFLOW.create({ params: { source } });
    return json({ instance_id: instance.id, source: source.name });
  }

  // GET /api/debug?source=nyt — test fetch + D1 read without the workflow.
  if (path === "/api/debug") {
    const sourceName = url.searchParams.get("source") ?? "npr";
    const source = SOURCES.find((s) => s.name === sourceName) ?? SOURCES[0];

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

  // /api/markets — Kalshi market CRUD
  if (path === "/api/markets") {
    if (method === "GET") {
      const { results } = await env.rss_monitor
        .prepare("SELECT market_id, title, description, keywords FROM kalshi_markets ORDER BY market_id")
        .all<{ market_id: string; title: string; description: string | null; keywords: string }>();
      const rows = results.map(r => ({
        market_id: r.market_id,
        title: r.title,
        description: r.description,
        keywords: safeParseKeywords(r.keywords),
      }));
      return json(rows);
    }

    if (method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }

      const b = body as Record<string, unknown>;
      const market_id   = typeof b.market_id   === "string" ? b.market_id.trim()   : "";
      const title       = typeof b.title       === "string" ? b.title.trim()       : "";
      const description = typeof b.description === "string" ? b.description.trim() : null;

      let keywords: string[] = [];
      if (Array.isArray(b.keywords)) {
        keywords = b.keywords.filter((k): k is string => typeof k === "string").map(k => k.trim()).filter(Boolean);
      } else if (typeof b.keywords === "string") {
        keywords = b.keywords.split(",").map(k => k.trim()).filter(Boolean);
      }

      if (!market_id) return json({ error: "market_id is required" }, 400);
      if (!title)     return json({ error: "title is required" }, 400);
      if (!keywords.length) return json({ error: "at least one keyword is required" }, 400);

      await env.rss_monitor
        .prepare("INSERT OR REPLACE INTO kalshi_markets (market_id, title, description, keywords) VALUES (?, ?, ?, ?)")
        .bind(market_id, title, description, JSON.stringify(keywords))
        .run();

      return json({ market_id, title, description, keywords });
    }

    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id query parameter is required" }, 400);
      const res = await env.rss_monitor
        .prepare("DELETE FROM kalshi_markets WHERE market_id = ?")
        .bind(id)
        .run();
      return json({ deleted: res.meta.changes ?? 0 });
    }

    return json({ error: "method not allowed" }, 405);
  }

  return json({ error: "not found" }, 404);
}

function safeParseKeywords(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}
