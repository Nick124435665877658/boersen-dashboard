# KI-News-Analyse – Einrichtung

Die Chartseiten enthalten bereits die Oberfläche. Für echte Nachrichten und KI-Auswertungen wird ein Cloudflare Worker als geschützter Vermittler benötigt. API-Schlüssel gehören **nicht** in `index.html`.

## 1. Anbieter-Konten und Schlüssel

- GNews: https://gnews.io/ – Free-Tarif ist laut Anbieter für nicht-kommerzielle Tests gedacht, mit 100 Requests/Tag, maximal 10 Artikeln pro Abruf und 12 Stunden Verzögerung. Für aktuelle Echtzeitdaten ist ein kostenpflichtiger Tarif erforderlich.
- OpenAI API: https://platform.openai.com/api-keys – API-Abrechnung ist separat von einem ChatGPT-Abo.

## 2. Worker bereitstellen

1. Bei https://dash.cloudflare.com/ anmelden.
2. **Workers & Pages → Create → Worker** öffnen.
3. Einen Worker z. B. `boersen-news-api` nennen.
4. Den Inhalt von `worker.js` in den Worker kopieren und deployen.
5. Unter **Settings → Variables and Secrets** drei Secrets/Variablen anlegen:
   - `GNEWS_API_KEY` (Secret)
   - `OPENAI_API_KEY` (Secret)
   - optional `OPENAI_MODEL` (Textvariable, Standard im Code: `gpt-5.5`)
6. Worker erneut deployen.

## 3. Dashboard verbinden

In `index.html` nach `NEWS_WORKER_URL` suchen und die leere Zeichenkette durch die Worker-Adresse ersetzen, z. B. `https://boersen-news-api.DEIN-ACCOUNT.workers.dev`. Danach committen und GitHub Pages neu laden.

## Hinweise

- Der Worker erlaubt nur die GitHub-Pages-Origin dieses Dashboards.
- Ergebnisse werden im Cloudflare-Cache 30 Minuten zwischengespeichert.
- Die GNews-Free-Stufe liefert verzögerte Nachrichten (bis zu 12 Stunden) und ist nicht für kommerzielle Nutzung bestimmt. Sie reicht zum technischen Testen, nicht für eine verlässliche Echtzeit-Newsversorgung.
- Die KI ergänzt Branchen-, Wettbewerbs- und Makro-Kontext per Websuche. Prüfe wichtige Originalquellen selbst; KI-Einschätzungen sind keine Anlageberatung.
- Vor öffentlichem Betrieb sollte zusätzlich ein Cloudflare Rate Limit auf `/api/news` gesetzt werden, damit Dritte die API-Kosten nicht unnötig auslösen.
