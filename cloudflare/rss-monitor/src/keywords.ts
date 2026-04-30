// Pure-TS approximation of NLTK-style keyword extraction: lowercase, word-tokenize,
// drop English stopwords and short tokens. Runs in a Workers isolate (no NLTK available).

const STOPWORDS = new Set([
  "a","about","above","after","again","against","all","also","am","an","and","any","are",
  "as","at","be","because","been","before","being","below","between","both","but","by",
  "can","could","did","do","does","doing","don","down","during","each","else","few","for",
  "from","further","get","got","had","has","have","having","he","her","here","hers","herself",
  "him","himself","his","how","if","in","into","is","it","its","itself","just","like","made",
  "make","makes","many","may","me","might","more","most","much","must","my","myself","new",
  "no","nor","not","now","of","off","on","once","one","only","or","other","our","ours",
  "ourselves","out","over","own","said","same","say","says","she","should","so","some",
  "such","than","that","the","their","theirs","them","themselves","then","there","these",
  "they","this","those","through","to","too","two","under","until","up","very","was","we",
  "were","what","when","where","which","while","who","whom","whose","why","will","with",
  "would","yet","you","your","yours","yourself","yourselves",
]);

const TOKEN_RE = /[a-z0-9]+/g;

export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (tok.length < 3) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

export function extractKeywords(text: string): Set<string> {
  return new Set(tokenize(text));
}

// Pre-tokenized representation of a Kalshi market's keyword list. Multi-word phrases
// are kept as token arrays so we can do bag-of-words phrase matching against an
// article's keyword set (every phrase token must be present). title and description
// are kept around so downstream steps (e.g. LLM impact judgment) can reuse them
// without an extra DB lookup.
export interface PreparedMarket {
  marketId: string;
  title: string;
  description: string | null;
  phrases: { original: string; tokens: string[] }[];
}

export function prepareMarkets(
  rows: { market_id: string; title: string; description: string | null; keywords: string }[],
): PreparedMarket[] {
  const out: PreparedMarket[] = [];
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.keywords);
    } catch {
      continue;
    }
    if (!Array.isArray(raw)) continue;

    const phrases: { original: string; tokens: string[] }[] = [];
    for (const k of raw) {
      if (typeof k !== "string") continue;
      const tokens = tokenize(k);
      if (tokens.length === 0) continue;
      phrases.push({ original: k, tokens });
    }
    if (phrases.length > 0) {
      out.push({
        marketId: row.market_id,
        title: row.title,
        description: row.description,
        phrases,
      });
    }
  }
  return out;
}

export interface MarketMatch {
  marketId: string;
  matchedKeywords: string[]; // original keyword strings (pre-tokenization) that hit
}

export function matchMarkets(
  articleKeywords: Set<string>,
  markets: PreparedMarket[],
): MarketMatch[] {
  const out: MarketMatch[] = [];
  for (const m of markets) {
    const matched: string[] = [];
    for (const phrase of m.phrases) {
      if (phrase.tokens.every((t) => articleKeywords.has(t))) {
        matched.push(phrase.original);
      }
    }
    if (matched.length > 0) {
      out.push({ marketId: m.marketId, matchedKeywords: matched });
    }
  }
  return out;
}
