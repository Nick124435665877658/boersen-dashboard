const ALLOWED_ORIGIN = "https://nick124435665877658.github.io";
const CACHE_SECONDS = 30 * 60;

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) }
  });
}
function extractOutputText(response) {
  for (const item of (response.output || [])) {
    if (item.type === "message" && Array.isArray(item.content)) {
      const part = item.content.find(x => x.type === "output_text");
      if (part?.text) return part.text;
    }
  }
  return "";
}
function parseJson(text) {
  const cleaned = text.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/i, "");
  return JSON.parse(cleaned);
}
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (origin !== ALLOWED_ORIGIN) return json({ error: "Origin not allowed" }, 403, origin);
    const url = new URL(request.url);
    if (url.pathname !== "/api/news" || request.method !== "GET") return json({ error: "Not found" }, 404, origin);
    if (!env.GNEWS_API_KEY || !env.OPENAI_API_KEY) return json({ error: "API-Zugänge im Cloudflare Worker fehlen noch." }, 503, origin);
    const name = (url.searchParams.get("name") || "").trim().slice(0, 100);
    const symbol = (url.searchParams.get("symbol") || "").trim().slice(0, 40);
    if (!name || !symbol) return json({ error: "Name und Börsenkürzel fehlen." }, 400, origin);

    const cacheKey = new Request("https://news-cache.local/" + encodeURIComponent(symbol.toUpperCase()));
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.json();
      return json(body, 200, origin);
    }
    try {
      const query = '"' + name.replace(/"/g, "") + '" OR ' + symbol.replace(/[^A-Za-z0-9.^=-]/g, "");
      const newsUrl = new URL("https://gnews.io/api/v4/search");
      newsUrl.searchParams.set("q", query);
      newsUrl.searchParams.set("lang", "de");
      newsUrl.searchParams.set("max", "10");
      newsUrl.searchParams.set("sortby", "publishedAt");
      newsUrl.searchParams.set("from", new Date(Date.now() - 30 * 86400000).toISOString());
      const newsResponse = await fetch(newsUrl, { headers: { "X-Api-Key": env.GNEWS_API_KEY } });
      if (!newsResponse.ok) throw new Error("Nachrichtenanbieter meldet HTTP " + newsResponse.status);
      const newsData = await newsResponse.json();
      const articles = (newsData.articles || []).map(a => ({
        title: a.title, description: a.description, content: a.content,
        url: a.url, publishedAt: a.publishedAt, publisher: a.source?.name
      }));
      const prompt = [
        "Erstelle eine ausführliche, nüchterne Aktien-News-Analyse auf Deutsch.",
        "Aktie: " + name + " (" + symbol + ").",
        "Analysiere getrennt: Unternehmen, Branche, Konkurrenz, Gesamtmarkt sowie Chancen/Risiken/Ausblick.",
        "Nutze die gelieferten Nachrichten als Faktenbasis. Recherchiere mit Websuche ergänzend aktuelle Branchen-, Wettbewerber- und Makroentwicklungen.",
        "Zeitraum: Schwerpunkt letzte 7 Tage; wichtige Entwicklungen aus den letzten 30 Tagen ergänzen und klar datieren.",
        "Erfinde keine Nachrichten, Kennzahlen, Kursziele oder Quellen. Wenn etwas nicht belegt ist, sage das ausdrücklich.",
        "Trenne Fakten von Interpretation. Keine persönliche Anlageberatung und keine sichere Kursprognose.",
        "Antworte ausschließlich als valides JSON mit diesen Feldern:",
        '{"sentiment":"positiv|neutral|negativ","overallSummary":"...","sections":{"company":{"summary":"...","points":[]},"industry":{"summary":"...","points":[]},"competitors":{"summary":"...","points":[]},"market":{"summary":"...","points":[]},"assessment":{"opportunities":[],"risks":[],"shortTerm":"...","mediumTerm":"..."}}}',
        "Wenn keine passenden Artikel vorhanden sind, sage das offen. Artikel aus dem Feed:",
        JSON.stringify(articles)
      ].join("\n\n");
      const aiResponse = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || "gpt-5.5",
          tools: [{ type: "web_search" }],
          input: prompt,
          max_output_tokens: 3000
        })
      });
      if (!aiResponse.ok) throw new Error("KI-Dienst meldet HTTP " + aiResponse.status);
      const aiData = await aiResponse.json();
      const text = extractOutputText(aiData);
      if (!text) throw new Error("Die KI hat keine Textanalyse zurückgegeben.");
      const analysis = parseJson(text);
      const webSources = [];
      for (const item of (aiData.output || [])) {
        if (item.type === "web_search_call") {
          for (const src of (item.action?.sources || [])) webSources.push({
            title: src.title || src.url, url: src.url, publisher: src.domain || "Websuche"
          });
        }
      }
      const sources = [...articles.map(a => ({ title: a.title, url: a.url, publisher: a.publisher, publishedAt: a.publishedAt })), ...webSources]
        .filter(x => x.url && /^https?:\/\//i.test(x.url))
        .filter((x, i, arr) => arr.findIndex(y => y.url === x.url) === i)
        .slice(0, 16);
      const result = { ...analysis, sources, generatedAt: new Date().toISOString(), newsDelayMinutes: 720 };
      const response = new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + CACHE_SECONDS }
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return json(result, 200, origin);
    } catch (error) {
      return json({ error: error.message || "News-Analyse fehlgeschlagen." }, 502, origin);
    }
  }
};
