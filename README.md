# Padel Ladder — TC Lunteren

Losstaand React-project van de padel-ladder-app, klaar om te deployen op Netlify.

## Belangrijk: opslag is nu per browser/apparaat

Deze versie gebruikt `localStorage` als vervanging voor de `window.storage`-functie
die alleen binnen Claude.ai-artifacts bestaat (zie `src/storage.js`). Dat betekent:

- De app werkt meteen, zonder server of database.
- **Elke bezoeker ziet zijn eigen data.** Als twee mensen de site openen (ook op
  hetzelfde wifi-netwerk), delen ze GEEN ladderstand — ieder heeft zijn eigen
  lokale kopie in zijn eigen browser.
- Voor een écht gedeelde ladder (iedereen ziet dezelfde stand) heb je een
  database nodig. Zie "Gedeelde data toevoegen" hieronder voor een aanzet.

Voor testen, een demo, of persoonlijk gebruik is dit prima. Voor een club met
meerdere leden die dezelfde ladder moeten zien, is een database eigenlijk
noodzakelijk.

## Lokaal draaien

```bash
npm install
npm run dev
```

Opent op `http://localhost:5173`.

## Deployen op Netlify

**Optie A — via GitHub (aanbevolen)**

1. Zet dit project in een nieuwe GitHub-repo:
   ```bash
   git init
   git add .
   git commit -m "Padel ladder app"
   git branch -M main
   git remote add origin <jouw-repo-url>
   git push -u origin main
   ```
2. Ga naar [app.netlify.com](https://app.netlify.com) → "Add new site" →
   "Import an existing project" → kies je GitHub-repo.
3. Netlify herkent automatisch `netlify.toml` (build command `npm run build`,
   publish directory `dist`). Klik op "Deploy site".
4. Klaar — elke nieuwe push naar `main` deployt automatisch opnieuw.

**Optie B — direct uploaden (zonder GitHub)**

1. Bouw de app lokaal:
   ```bash
   npm install
   npm run build
   ```
2. Ga naar [app.netlify.com/drop](https://app.netlify.com/drop) en sleep de
   gegenereerde `dist`-map in het venster. Klaar.

## Gedeelde data toevoegen (optioneel, voor een echte clubladder)

Om een ladderstand te hebben die alle leden delen, vervang je `src/storage.js`
door een koppeling met een backend. [Supabase](https://supabase.com) heeft een
gratis tier en een one-click Netlify-integratie, en is een goede eerste keus:

1. Maak een gratis Supabase-project aan.
2. Maak een tabel (bijv. `kv_store` met kolommen `key` en `value`) of gebruik
   losse tabellen voor `players`, `duos`, `history`, `current_round`.
3. Herschrijf `src/storage.js` zodat `get`/`set`/`delete` Supabase-queries
   uitvoeren in plaats van `localStorage`.

Zeg het gerust als je hier hulp bij wilt — dat is een aparte stap die ik
kan voorbereiden zodra je zover bent.

## Projectstructuur

```
padel-ladder-app/
├─ index.html
├─ netlify.toml          ← Netlify build-configuratie
├─ package.json
├─ vite.config.js
└─ src/
   ├─ main.jsx            ← React entry point
   ├─ App.jsx              ← De volledige app (ongewijzigd overgenomen)
   └─ storage.js           ← localStorage-vervanging voor window.storage
```
