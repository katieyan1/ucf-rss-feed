export interface FeedItem {
  guid: string;
  title: string;
  pubDate: string;
  description: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\t|\n/g, " ");
}

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1");
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeEntities(stripCdata(m[1].trim())) : "";
}

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const body = match[1];
    const guid =
      extractTag(body, "guid") ||
      extractTag(body, "link") ||
      "unknown";
    const title = extractTag(body, "title");
    const pubDate = extractTag(body, "pubDate");
    const description = extractTag(body, "description");

    items.push({ guid, title, pubDate, description });
  }

  return items;
}

export function computeLatencyMs(pubDate: string): number | null {
  if (!pubDate) return null;
  const pub = new Date(pubDate).getTime();
  if (isNaN(pub)) return null;
  return Date.now() - pub;
}

export function formatLatency(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
