// LLM-based judgment: does this news article actually impact the matched Kalshi market?
// Runs on Cloudflare Workers AI; returns yes/no + confidence + short reason.

export const IMPACT_MODEL = "openai/gpt-5.4-nano";

export interface ImpactVerdict {
  impact: 0 | 1;
  confidence: number; // 0.0–1.0
  reason: string;
}

export interface ImpactInput {
  articleTitle: string;
  articleDescription: string;
  marketTitle: string;
  marketDescription: string | null;
  matchedKeywords: string[];
}

interface AIBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

const SYSTEM_PROMPT =
  "You judge whether a news article materially impacts a Kalshi prediction market. " +
  "Reply ONLY with strict JSON of the form " +
  '{"impact": "yes" | "no", "confidence": <number 0-1>, "reason": "<one short sentence>"}. ' +
  "No prose outside the JSON. " +
  '"impact" is yes ONLY if the article contains information that would plausibly move the market\'s probability to yes' +
  "Confidence reflects how sure you are of the yes/no answer.";

function buildUserPrompt(i: ImpactInput): string {
  return [
    `Market title: ${i.marketTitle}`,
    `Market description: ${i.marketDescription ?? "(none)"}`,
    `Matched keywords: ${i.matchedKeywords.join(", ")}`,
    "",
    `Article title: ${i.articleTitle}`,
    `Article description: ${i.articleDescription || "(none)"}`,
  ].join("\n");
}

// Tolerant parser: the model may wrap JSON in prose or code fences despite the prompt.
function parseVerdict(raw: string): ImpactVerdict | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;

  const impactRaw = typeof p.impact === "string" ? p.impact.toLowerCase().trim() : "";
  if (impactRaw !== "yes" && impactRaw !== "no") return null;

  const confRaw = typeof p.confidence === "number" ? p.confidence : Number(p.confidence);
  const confidence =
    Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;

  const reason = typeof p.reason === "string" ? p.reason.slice(0, 500) : "";

  return { impact: impactRaw === "yes" ? 1 : 0, confidence, reason };
}

export async function decideImpact(
  ai: AIBinding,
  input: ImpactInput,
): Promise<ImpactVerdict | null> {
  let resp: unknown;
  try {
    resp = await ai.run(IMPACT_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
      max_tokens: 200,
      temperature: 0,
    });
  } catch (err) {
    console.error(`[decideImpact] AI.run threw — ${err}`);
    return null;
  }

  const text =
    (resp as { response?: unknown })?.response !== undefined
      ? String((resp as { response: unknown }).response)
      : typeof resp === "string"
        ? resp
        : JSON.stringify(resp);

  const verdict = parseVerdict(text);
  if (!verdict) {
    console.error(`[decideImpact] could not parse model output: ${text.slice(0, 200)}`);
  }
  return verdict;
}
