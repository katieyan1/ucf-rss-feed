/**
 * RSS Monitor Worker
 *
 * - Cron trigger (every minute): spawns one RSSMonitorWorkflow per source.
 * - Fetch handler: serves dashboard / markets / docs pages and the JSON API.
 *
 * Pages:
 *   GET /         — dashboard
 *   GET /markets  — Kalshi market editor
 *   GET /docs     — API docs
 *
 * API routes are defined in src/api.ts.
 */

import { SOURCES } from "./sources";
import { Env } from "./env";
import { handleApi } from "./api";
import { DASHBOARD_HTML } from "./pages/dashboard";
import { DOCS_HTML } from "./pages/docs";
import { MARKETS_HTML } from "./pages/markets";

export { RSSMonitorWorkflow } from "./workflow";
export type { Env } from "./env";

function html(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    for (const source of SOURCES) {
      await env.RSS_WORKFLOW.create({ params: { source } });
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, url, env);
    }

    if (url.pathname === "/" || url.pathname === "") return html(DASHBOARD_HTML);
    if (url.pathname === "/markets")                 return html(MARKETS_HTML);
    if (url.pathname === "/docs")                    return html(DOCS_HTML);

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
