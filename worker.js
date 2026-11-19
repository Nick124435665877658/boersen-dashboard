// Börsen-Dashboard Worker (Stand 19.11.2026)
//
// GET /health        → Status, zeigt auch, ob die Workers-AI-Bindung "AI" aktiv ist
// GET /api/analysis  → KI-Zusammenfassung mit Chancen und Risiken aus Schlagzeilen der letzten 7 Tage
//                      (Google News, Bing News, Yahoo Finance, Börsenportale aus news-feed.json)
// GET /api/news      → nur Schlagzeilen (Übergang für ältere Dashboard-Versionen)
//
// Voraussetzung in Cloudflare: Worker → Settings → Bindings → Add → Workers AI, Variablenname "AI".
// Kosten: Workers AI Free = 10.000 Neurons pro Tag. Eine Analyse braucht grob 200–300 Neurons.

const ALLOWED_ORIGIN = "https://nick124435665877658.github.io";
const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_HEADLINES = 25;
const USER_AGENT = "Mozilla/5.0 (compatible; BoersenDashboard/1.1)";
const KIND_LABEL = { stock: "Aktie", index: "ETF/Index", commodity: "Rohstoff" };

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
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(origin) }
  });
}

// ---------- Nachrichtenquellen ----------
// Mehrere Quellen, weil einzelne Anbieter Anfragen aus Cloudflare-Rechenzentren
// zeitweise blockieren (z. B. Google News mit HTTP 503). Eine erreichbare Quelle genügt.

const NEWS_FEED_URL = "https://nick124435665877658.github.io/boersen-dashboard/news-feed.json";
const SOURCE_TIMEOUT_MS = 8000;
const MAX_AGE_MS = 8 * 86400 * 1000;

function decodeXml(value) {
  return (value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const TAG_RX = {};
function tag(xml, name) {
  const rx = TAG_RX[name] || (TAG_RX[name] = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  const m = xml.match(rx);
  return m ? decodeXml(m[1]).trim() : "";
}

function isoDate(value) {
  return value && !isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function parseFeed(xml, defaultPublisher, withDescription) {
  const items = [];
  for (const match of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const title = stripHtml(tag(item, "title"));
    const url = tag(item, "link");
    const publisher = stripHtml(tag(item, "source") || tag(item, "News:Source")) || defaultPublisher;
    const description = withDescription ? stripHtml(decodeXml(tag(item, "description"))).slice(0, 300) : "";
    if (title && url) items.push({ title, url, publisher, publishedAt: isoDate(tag(item, "pubDate")), description });
  }
  return items;
}

// Bing verpackt den Artikel-Link in einen Klick-Zähler; die echte Adresse steht im Parameter "url".
function unwrapBingLink(article) {
  const m = article.url.match(/[?&]url=([^&]+)/i);
  if (m) { try { article.url = decodeURIComponent(m[1]); } catch (_) {} }
  return article;
}

function parseNewsFeedJson(text) {
  const data = JSON.parse(text);
  return (Array.isArray(data.articles) ? data.articles : []).map(a => ({
    title: stripHtml(a.title), url: a.url, publisher: a.publisher || "Börsenportal",
    publishedAt: isoDate(a.publishedAt), description: stripHtml(a.description).slice(0, 300)
  })).filter(a => a.title && /^https?:\/\//i.test(a.url || ""));
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/xml;q=0.9, application/json;q=0.8, */*;q=0.5",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8"
      },
      signal: controller.signal
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } catch (error) {
    throw new Error(error && error.name === "AbortError" ? "Zeitüberschreitung" : (error && error.message) || String(error));
  } finally {
    clearTimeout(timer);
  }
}

function newsSources(query, symbol) {
  const q = encodeURIComponent(query);
  const qGoogle = encodeURIComponent(query + " when:7d");
  const sources = [
    { name: "Google News DE", url: "https://news.google.com/rss/search?q=" + qGoogle + "&hl=de&gl=DE&ceid=DE:de", parse: x => parseFeed(x, "Google News", false) },
    { name: "Google News EN", url: "https://news.google.com/rss/search?q=" + qGoogle + "&hl=en-US&gl=US&ceid=US:en", parse: x => parseFeed(x, "Google News", false) },
    { name: "Bing News DE", url: "https://www.bing.com/news/search?q=" + q + "&format=rss&mkt=de-DE", parse: x => parseFeed(x, "Bing News", true).map(unwrapBingLink) },
    { name: "Bing News EN", url: "https://www.bing.com/news/search?q=" + q + "&format=rss&mkt=en-US", parse: x => parseFeed(x, "Bing News", true).map(unwrapBingLink) }
  ];
  if (symbol && /^[A-Z0-9.\-=^]{1,20}$/i.test(symbol)) {
    // Ticker-genauer Feed: Treffer gelten auch ohne Firmennamen im Titel als relevant.
    sources.push({ name: "Yahoo Finance", trusted: true, url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=" + encodeURIComponent(symbol) + "&region=US&lang=en-US", parse: x => parseFeed(x, "Yahoo Finance", true) });
  }
  sources.push({ name: "Börsenportale", url: NEWS_FEED_URL, parse: parseNewsFeedJson });
  return sources;
}

// Google-News-Titel enden meist auf " - Quelle"; das kostet nur Tokens.
function cleanTitle(title, publisher) {
  const suffix = " - " + publisher;
  return publisher && title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

function cleanTerm(value, max) {
  return String(value || "").replace(/["“”„]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// Treffer nur als ganzes Wort, damit z. B. "ING" nicht in "Trading" gefunden wird.
function termRegex(term) {
  const escaped = term.toLocaleLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^\\p{L}\\p{N}])" + escaped + "(?=$|[^\\p{L}\\p{N}])", "u");
}

async function fetchHeadlines(name, terms, symbol) {
  const phrases = [...new Map([name, ...terms].filter(t => t.length >= 2).map(t => [t.toLocaleLowerCase(), t])).values()].slice(0, 5);
  const query = phrases.map(p => '"' + p + '"').join(" OR ");
  const sources = newsSources(query, symbol);
  const results = await Promise.allSettled(sources.map(async s => s.parse(await fetchText(s.url))));
  const matchers = phrases.map(termRegex);
  const now = Date.now();
  const unique = new Map();
  const status = sources.map((s, i) => {
    const r = results[i];
    if (r.status !== "fulfilled") return { name: s.name, status: (r.reason && r.reason.message) || "Fehler", count: 0 };
    let count = 0;
    for (const article of r.value) {
      const title = cleanTitle(article.title, article.publisher);
      const lower = title.toLocaleLowerCase();
      const haystack = lower + " " + (article.description || "").toLocaleLowerCase();
      if (!s.trusted && !matchers.some(rx => rx.test(haystack))) continue;
      if (article.publishedAt && now - Date.parse(article.publishedAt) > MAX_AGE_MS) continue;
      count++;
      const key = lower.replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 90);
      if (!unique.has(key)) unique.set(key, { ...article, title, source: s.name });
    }
    return { name: s.name, status: "ok", count };
  });
  if (!status.some(s => s.status === "ok")) {
    throw new Error("Keine Nachrichtenquelle erreichbar (" + status.map(s => s.name + ": " + s.status).join(" · ") + ")");
  }
  const articles = [...unique.values()]
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, MAX_HEADLINES);
  return { articles, query, sources: status };
}

// ---------- KI-Analyse ----------

const SYSTEM_PROMPT = `Du bist ein nüchterner, kritischer Finanzanalyst und schreibst für einen erfahrenen Privatanleger auf Deutsch.
Du bekommst Schlagzeilen der letzten 7 Tage, teils mit kurzem Anrisstext (keine vollständigen Artikel), und die Kursentwicklung eines Wertpapiers.

Regeln:
1. Stütze dich auf die gelieferten Schlagzeilen und Kursdaten. Erfinde keine Zahlen, Kursziele, Termine, Zitate oder Ereignisse.
2. Belege jede inhaltliche Aussage mit den Nummern der Schlagzeilen, z. B. [2] oder [3][7].
3. Erkläre Kursbewegungen nur, wenn die Schlagzeilen das hergeben. Sonst schreibe, dass die Schlagzeilen die Bewegung nicht erklären.
4. Gewichte reißerische oder werbliche Schlagzeilen (z. B. „Kursexplosion“, „jetzt kaufen“, „Geheimtipp“) vorsichtig und sag es, wenn sie die Nachrichtenlage dominieren.
5. Wenn sich Schlagzeilen widersprechen oder wenig Substanz haben, sag das offen. Lieber kürzer als aufgebläht.
6. Höchstens ein Risiko darf ein allgemein bekanntes Branchen- oder Marktrisiko ohne Beleg sein. Kennzeichne es mit „(allgemein)“ und nenne keine Zahlen dazu.
7. Keine Kauf- oder Verkaufsempfehlung, keine Kursprognose.

Antworte ausschließlich mit einem JSON-Objekt mit diesen Feldern:
- "stimmung": "positiv", "neutral", "negativ" oder "gemischt" – die Tendenz der Nachrichtenlage, nicht deine Meinung zur Aktie
- "zusammenfassung": 3 bis 5 Sätze zur aktuellen Nachrichtenlage
- "chancen": 2 bis 4 kurze Punkte, je ein Satz mit Belegnummern
- "risiken": 2 bis 4 kurze Punkte, je ein Satz mit Belegnummern
- "fazit": 1 bis 2 Sätze, worauf man in den nächsten Tagen achten sollte
Wenn die Schlagzeilen für Chancen oder Risiken nichts hergeben, schreib genau das als einzigen Punkt.`;

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    stimmung: { type: "string", enum: ["positiv", "neutral", "negativ", "gemischt"] },
    zusammenfassung: { type: "string" },
    chancen: { type: "array", items: { type: "string" } },
    risiken: { type: "array", items: { type: "string" } },
    fazit: { type: "string" }
  },
  required: ["stimmung", "zusammenfassung", "chancen", "risiken", "fazit"]
};

function fmtDate(iso) {
  if (!iso) return "Datum unbekannt";
  try {
    return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
  } catch (_) {
    return String(iso).slice(0, 10);
  }
}

function pctText(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n) || Math.abs(n) > 1000) return null;
  return (n > 0 ? "+" : "") + n.toFixed(1).replace(".", ",") + " %";
}

function buildMessages({ name, symbol, kind, perf, articles }) {
  const lines = articles.map((a, i) => {
    const desc = (a.description || "").trim();
    const snippet = desc && !desc.toLocaleLowerCase().startsWith(a.title.toLocaleLowerCase().slice(0, 40)) ? " — " + desc.slice(0, 200) : "";
    return "[" + (i + 1) + "] " + fmtDate(a.publishedAt) + " · " + a.publisher + " · " + a.title + snippet;
  });
  const user = [
    "Wertpapier: " + name + (symbol ? " (" + symbol + ")" : "") + " · Typ: " + kind,
    "Heutiges Datum: " + fmtDate(new Date().toISOString()),
    "Kursentwicklung in EUR laut Dashboard: " + (perf.length ? perf.join(" · ") : "nicht verfügbar"),
    "",
    "Schlagzeilen der letzten 7 Tage, neueste zuerst (" + articles.length + " Stück):",
    ...lines
  ].join("\n");
  return [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }];
}

function extractJson(raw) {
  let r = raw;
  if (r && typeof r === "object" && Array.isArray(r.choices)) r = r.choices[0] && r.choices[0].message && r.choices[0].message.content;
  else if (r && typeof r === "object" && "response" in r) r = r.response;
  if (r && typeof r === "object") return r;
  if (typeof r !== "string" || !r.trim()) throw new Error("Leere KI-Antwort");
  const start = r.indexOf("{"), end = r.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("KI-Antwort enthält kein JSON");
  return JSON.parse(r.slice(start, end + 1));
}

function normalizeAnalysis(o) {
  const text = v => (typeof v === "string" ? v.trim().slice(0, 1500) : "");
  const list = v => (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
    .map(x => (typeof x === "string" ? x : (x && (x.punkt || x.text || x.beschreibung)) || ""))
    .map(s => String(s).trim()).filter(Boolean).slice(0, 5).map(s => s.slice(0, 400));
  const stimmung = ["positiv", "neutral", "negativ", "gemischt"].includes(o && o.stimmung) ? o.stimmung : "neutral";
  const result = { stimmung, zusammenfassung: text(o && o.zusammenfassung), chancen: list(o && o.chancen), risiken: list(o && o.risiken), fazit: text(o && o.fazit) };
  if (!result.zusammenfassung) throw new Error("KI-Antwort unvollständig");
  return result;
}

function isLimitError(error) {
  return /neuron|daily free allocation|4006|quota|capacity|rate limit|too many/i.test(String(error && error.message || error));
}

// Erst mit JSON-Schema, falls das scheitert ohne Schema (das Modell liefert dann trotzdem JSON laut Prompt).
async function runAnalysis(env, messages) {
  const base = { messages, max_tokens: 1200, temperature: 0.2 };
  const attempts = [{ ...base, response_format: { type: "json_schema", json_schema: ANALYSIS_SCHEMA } }, base];
  let lastError = null;
  for (const input of attempts) {
    try {
      return normalizeAnalysis(extractJson(await env.AI.run(AI_MODEL, input)));
    } catch (error) {
      lastError = error;
      if (isLimitError(error)) break;
    }
  }
  throw lastError || new Error("KI-Analyse fehlgeschlagen");
}

async function handleAnalysis(url, env, origin) {
  if (!env || !env.AI) {
    return json({ error: "Workers-AI-Bindung fehlt. In Cloudflare unter Settings → Bindings → Workers AI mit dem Namen „AI“ hinzufügen." }, 500, origin);
  }
  const name = cleanTerm(url.searchParams.get("name"), 90);
  if (!name) return json({ error: "Name des Wertpapiers fehlt." }, 400, origin);
  const terms = (url.searchParams.get("terms") || "").split(",").map(t => cleanTerm(t, 40)).filter(Boolean).slice(0, 4);
  const symbol = cleanTerm(url.searchParams.get("symbol"), 30);
  const kind = KIND_LABEL[url.searchParams.get("kind")] || "Wertpapier";
  const perf = [["1 Tag", "chg1d"], ["1 Woche", "chg1w"], ["1 Monat", "chg1m"]]
    .map(([label, key]) => { const t = pctText(url.searchParams.get(key)); return t ? label + ": " + t : null; })
    .filter(Boolean);

  let headlines;
  try {
    headlines = await fetchHeadlines(name, terms, symbol);
  } catch (error) {
    return json({ error: "Nachrichten konnten nicht geladen werden: " + error.message }, 502, origin);
  }
  const base = { articles: headlines.articles, sources: headlines.sources, query: headlines.query, model: AI_MODEL, generatedAt: new Date().toISOString(), source: "News-RSS + Cloudflare Workers AI" };
  if (!headlines.articles.length) {
    return json({ ...base, analysis: null, note: "In den letzten 7 Tagen wurden keine passenden Schlagzeilen gefunden. Ohne Nachrichtenlage erstellt die KI bewusst keine Analyse." }, 200, origin);
  }
  try {
    const analysis = await runAnalysis(env, buildMessages({ name, symbol, kind, perf, articles: headlines.articles }));
    return json({ ...base, analysis }, 200, origin);
  } catch (error) {
    if (isLimitError(error)) {
      return json({ ...base, analysis: null, error: "Tageslimit der kostenlosen KI erreicht. Es setzt um 01:00 Uhr deutscher Zeit (00:00 UTC) zurück." }, 429, origin);
    }
    return json({ ...base, analysis: null, error: "KI-Analyse fehlgeschlagen: " + (error && error.message ? error.message : String(error)) }, 502, origin);
  }
}

// ---------- Router ----------

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "", url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, worker: "boersen-dashboard-worker", version: "2026-11-19", ai: !!(env && env.AI), model: AI_MODEL, time: new Date().toISOString() }, 200, origin);
    }
    if (origin !== ALLOWED_ORIGIN) return json({ error: "Origin not allowed", receivedOrigin: origin || "(none)" }, 403, origin);
    if (request.method !== "GET") return json({ error: "Not found" }, 404, origin);

    if (url.pathname === "/api/analysis") return handleAnalysis(url, env, origin);

    if (url.pathname === "/api/news") {
      const name = cleanTerm(url.searchParams.get("name"), 90);
      if (!name) return json({ error: "Unternehmensname fehlt." }, 400, origin);
      try {
        const { articles } = await fetchHeadlines(name, []);
        return json({ articles: articles.slice(0, 14), fetchedAt: new Date().toISOString(), source: "Google News RSS" }, 200, origin);
      } catch (error) {
        return json({ error: "Worker-Fehler: " + error.message }, 502, origin);
      }
    }
    return json({ error: "Not found" }, 404, origin);
  }
};
