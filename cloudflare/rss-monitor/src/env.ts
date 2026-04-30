export interface Env {
  RSS_WORKFLOW: Workflow;
  rss_monitor: D1Database;
  AI: { run(model: string, input: unknown): Promise<unknown> };
}
