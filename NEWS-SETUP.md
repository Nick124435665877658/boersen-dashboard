# KI-Nachrichtenanalyse – Einrichtung

Die Chartseiten zeigen pro Wert eine KI-Analyse der Nachrichtenlage: Zusammenfassung, Chancen, Risiken und „Worauf achten“. Grundlage sind die Google-News-Schlagzeilen der letzten 7 Tage auf Deutsch und Englisch.

## Wie es funktioniert

1. Das Dashboard ruft `GET /api/analysis` beim Cloudflare-Worker `boersen-dashboard-worker` auf. Mitgeschickt werden Name, Suchbegriffe und die Kursentwicklung über 1 Woche und 1 Monat.
2. Der Worker holt die passenden Schlagzeilen über Google News RSS.
3. Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) erstellt daraus die Analyse als JSON. Jede Aussage verweist auf die Nummer ihrer Quelle.
4. Das Dashboard speichert die Analyse 3 Stunden lokal und lädt sie nur per Knopfdruck neu.

Es wird kein API-Schlüssel benötigt.

## Kosten

Workers AI Free: 10.000 Neurons pro Tag, Reset um 00:00 UTC (01:00 Uhr MEZ). Eine Analyse braucht grob 200–300 Neurons, das reicht für etwa 30–45 Analysen am Tag. Ist das Limit erreicht, zeigt das Dashboard einen Hinweis. Auf dem Workers-Free-Plan entstehen dabei keine Kosten.

## Worker deployen (Cloudflare-Dashboard)

1. https://dash.cloudflare.com → **Workers & Pages** → `boersen-dashboard-worker` → **Edit code**.
2. Den gesamten Inhalt von `worker.js` aus diesem Repo einfügen und auf **Deploy** tippen.
3. Zurück zum Worker → **Settings → Bindings → Add → Workers AI**, Variablenname `AI` → speichern bzw. deployen.
4. Test: `https://boersen-dashboard-worker.beckmannnick.workers.dev/health` muss `"ai":true` zeigen.

Mit Wrangler genügt `wrangler deploy`, die AI-Bindung steht bereits in `wrangler.toml`.

## Grenzen

- Die KI sieht nur Schlagzeilen, keine vollständigen Artikel.
- Kleine oder exotische Werte haben oft wenige oder keine Treffer. Dann wird bewusst keine Analyse erstellt.
- Suchnamen und Zusatzbegriffe pro Wert stehen in `index.html` unter `NEWS_HINTS`.
- KI-Ausgaben können Fehler enthalten und sind keine Anlageberatung.
