/**
 * The one thing a character cannot know on its own: what is true right now.
 *
 * Asked 「今日のニュースを教えて」 a model that has no clock and no feed can only say so — and to the
 * person asking, an assistant that cannot answer the most ordinary question of all is broken
 * (2026-09-07, twice in one day). Gemini's own search grounding is the obvious answer and is refused
 * on this key for the live model we use, so the character gets a tool instead: a named lookup, run by
 * the broker against sources that need no credentials, returning a few short facts it may read out.
 *
 * The contract is deliberately narrow. It is not a web browser: two kinds, a handful of headlines or
 * one place's weather, and nothing that invites the model to go wandering.
 */
export const LIVE_LOOKUP_TOOL = {
  name: "lookup_live_info",
  description:
    "今この瞬間の情報（今日のニュースの見出し、指定した場所の天気）を調べる。自分の知識にない“今”のことを聞かれたときだけ使う。過去の一般知識や、この会話で聞いた内容には使わない。",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["news", "weather"], description: "news = ニュース見出し, weather = 天気" },
      query: { type: "string", description: "ニュースの話題（省略時は主要ニュース）。例: 経済, 台風" },
      location: { type: "string", description: "天気を知りたい場所。例: 東京, 大阪。省略時は東京" },
    },
    required: ["kind"],
  },
} as const;

export interface LiveLookupRequest {
  kind: "news" | "weather";
  query?: string;
  location?: string;
}

export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

export interface LiveLookupResult {
  /** Feed publication date, not the date of the underlying event. */
  articles?: NewsArticle[];
  /** Short lines the character may read out. Empty means the lookup found nothing. */
  facts: string[];
  /** When the facts were fetched, for the model to say "as of" if it wants to. */
  at: string;
  /** Set when the lookup could not be done at all; the character says so rather than inventing. */
  error?: string;
}

/** What the model is handed back. Kept tiny: a long tool result becomes a long spoken answer. */
export function currentNewsOnly(result: LiveLookupResult): LiveLookupResult {
  if (result.error || !result.articles) return result;
  const day = (value: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
  const articles = result.articles.filter(a => Number.isFinite(Date.parse(a.publishedAt)) && day(a.publishedAt) === day(result.at));
  return articles.length ? { ...result, articles, facts: articles.map(a => a.title) } : { facts: [], articles: [], at: result.at, error: "No articles published today (Asia/Tokyo) were found. Do not present older articles as today's news." };
}

export function renderLookup(result: LiveLookupResult): Record<string, unknown> {
  result = currentNewsOnly(result);
  return result.error ? { error: result.error, at: result.at } : { facts: result.facts.slice(0, 5), at: result.at, ...(result.articles ? { articles: result.articles.slice(0, 5) } : {}) };
}

/** Read a request out of whatever the model actually sent, without trusting any of it. */
export function parseLookupArguments(args: Record<string, unknown>): LiveLookupRequest | null {
  const kind = typeof args.kind === "string" ? args.kind.toLowerCase().trim() : "";
  if (kind !== "news" && kind !== "weather") return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : undefined);
  return { kind, query: str(args.query), location: str(args.location) };
}
