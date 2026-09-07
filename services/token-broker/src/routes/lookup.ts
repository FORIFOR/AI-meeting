/**
 * The character's lookup, run here rather than in the page.
 *
 * Sources that need no credentials, because a key the operator has not got is a feature that does not
 * ship: Google News' public RSS for headlines, Open-Meteo for weather. Both are read-only GETs of
 * public data, and what leaves this machine is a topic word or a place name — never the meeting.
 */
import type { LiveLookupRequest, LiveLookupResult } from "@rcai/meeting-core";

export interface RouteResult<T> {
  status: number;
  body: T;
}

const NEWS_TOP = "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja";
const newsSearch = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`;

/** RSS is XML, and one regex over `<title>` is a smaller dependency than a parser. */
export function headlinesFromRss(xml: string, max = 5): string[] {
  const items = xml.split("<item>").slice(1);
  const out: string[] = [];
  for (const item of items) {
    const m = /<title>([\s\S]*?)<\/title>/.exec(item);
    if (!m) continue;
    const title = decodeXml(m[1]!)
      // Google appends the outlet after a hyphen; the character does not read out a masthead.
      .replace(/\s+-\s+[^-]{2,30}$/u, "")
      .trim();
    if (title) out.push(title);
    if (out.length >= max) break;
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "");
}

/** Open-Meteo's numeric weather codes, in the words a person would use. */
const WEATHER_CODES: Record<number, string> = {
  0: "快晴", 1: "晴れ", 2: "薄曇り", 3: "曇り", 45: "霧", 48: "霧", 51: "小雨", 53: "雨", 55: "強い雨",
  61: "雨", 63: "雨", 65: "強い雨", 66: "みぞれ", 67: "みぞれ", 71: "雪", 73: "雪", 75: "大雪", 77: "雪",
  80: "にわか雨", 81: "にわか雨", 82: "激しいにわか雨", 85: "にわか雪", 86: "にわか雪", 95: "雷雨", 96: "雷雨", 99: "雷雨",
};

export function describeWeather(place: string, current: { temperature_2m?: number; weather_code?: number }, today: { weather_code?: number; temperature_2m_max?: number; temperature_2m_min?: number }): string[] {
  const facts: string[] = [];
  const now = WEATHER_CODES[current.weather_code ?? -1];
  if (now && typeof current.temperature_2m === "number") facts.push(`${place}は今${now}、気温${Math.round(current.temperature_2m)}度`);
  else if (now) facts.push(`${place}は今${now}`);
  const day = WEATHER_CODES[today.weather_code ?? -1];
  if (day && typeof today.temperature_2m_max === "number" && typeof today.temperature_2m_min === "number") {
    facts.push(`今日の${place}は${day}、最高${Math.round(today.temperature_2m_max)}度・最低${Math.round(today.temperature_2m_min)}度`);
  }
  return facts;
}


/**
 * Open-Meteo's geocoder answers in Japanese but will not be *asked* in it: 「東京」 finds nothing while
 * "Tokyo" comes back as 東京都. So the places a Japanese speaker actually names are romanised on the
 * way out, and anything unlisted is passed through — which is right for a name already in latin.
 */
const PLACES: Record<string, string> = {
  東京: "Tokyo", 東京都: "Tokyo", 大阪: "Osaka", 大阪府: "Osaka", 京都: "Kyoto", 京都府: "Kyoto",
  名古屋: "Nagoya", 横浜: "Yokohama", 川崎: "Kawasaki", 神戸: "Kobe", 札幌: "Sapporo", 仙台: "Sendai",
  福岡: "Fukuoka", 広島: "Hiroshima", 那覇: "Naha", 沖縄: "Naha", 沖縄県: "Naha", 金沢: "Kanazawa",
  新潟: "Niigata", 静岡: "Shizuoka", 浜松: "Hamamatsu", 千葉: "Chiba", 埼玉: "Saitama", さいたま: "Saitama",
  神奈川: "Yokohama", 北海道: "Sapporo", 青森: "Aomori", 岩手: "Morioka", 盛岡: "Morioka", 宮城: "Sendai",
  秋田: "Akita", 山形: "Yamagata", 福島: "Fukushima", 茨城: "Mito", 水戸: "Mito", 栃木: "Utsunomiya",
  宇都宮: "Utsunomiya", 群馬: "Maebashi", 前橋: "Maebashi", 山梨: "Kofu", 甲府: "Kofu", 長野: "Nagano",
  岐阜: "Gifu", 愛知: "Nagoya", 三重: "Tsu", 滋賀: "Otsu", 大津: "Otsu", 兵庫: "Kobe", 奈良: "Nara",
  和歌山: "Wakayama", 鳥取: "Tottori", 島根: "Matsue", 松江: "Matsue", 岡山: "Okayama", 山口: "Yamaguchi",
  徳島: "Tokushima", 香川: "Takamatsu", 高松: "Takamatsu", 愛媛: "Matsuyama", 松山: "Matsuyama",
  高知: "Kochi", 佐賀: "Saga", 長崎: "Nagasaki", 熊本: "Kumamoto", 大分: "Oita", 宮崎: "Miyazaki",
  鹿児島: "Kagoshima", 福井: "Fukui", 富山: "Toyama", 石川: "Kanazawa",
};

/** The name to ask the geocoder for: romanised where we know it, trimmed of the suffix where we do not. */
export function geocodeName(place: string): string {
  const bare = place.replace(/(都|道|府|県|市|区|町|村)$/u, "");
  return PLACES[place] ?? PLACES[bare] ?? (bare || place);
}

export async function lookupLiveInfo(req: LiveLookupRequest, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<RouteResult<LiveLookupResult>> {
  const at = now().toISOString();
  try {
    if (req.kind === "news") {
      const res = await fetchImpl(req.query ? newsSearch(req.query) : NEWS_TOP, { headers: { accept: "application/rss+xml" } });
      if (!res.ok) return { status: 200, body: { facts: [], at, error: `news source responded ${res.status}` } };
      const facts = headlinesFromRss(await res.text());
      return { status: 200, body: { facts, at, ...(facts.length ? {} : { error: "no headlines found" }) } };
    }
    const place = req.location ?? "東京";
    const geo = await fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(geocodeName(place))}&count=1&language=ja&format=json`);
    if (!geo.ok) return { status: 200, body: { facts: [], at, error: `geocoder responded ${geo.status}` } };
    const g = (await geo.json()) as { results?: { latitude: number; longitude: number; name?: string }[] };
    const spot = g.results?.[0];
    if (!spot) return { status: 200, body: { facts: [], at, error: `place not found: ${place}` } };
    const wx = await fetchImpl(`https://api.open-meteo.com/v1/forecast?latitude=${spot.latitude}&longitude=${spot.longitude}&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`);
    if (!wx.ok) return { status: 200, body: { facts: [], at, error: `weather source responded ${wx.status}` } };
    const w = (await wx.json()) as { current?: Record<string, number>; daily?: Record<string, number[]> };
    const daily = w.daily ?? {};
    const facts = describeWeather(spot.name ?? place, w.current ?? {}, {
      weather_code: daily.weather_code?.[0],
      temperature_2m_max: daily.temperature_2m_max?.[0],
      temperature_2m_min: daily.temperature_2m_min?.[0],
    });
    return { status: 200, body: { facts, at, ...(facts.length ? {} : { error: "no weather returned" }) } };
  } catch (err) {
    return { status: 200, body: { facts: [], at, error: err instanceof Error ? err.message.slice(0, 120) : "lookup failed" } };
  }
}
