# Padel Ladder — TC Lunteren

Losstaand React-project van de padel-ladder-app, klaar om te deployen op Netlify.

## Gedeelde data via Supabase

Deze versie gebruikt [Supabase](https://supabase.com) (een gratis Postgres-database
met een REST-API) als vervanging voor de `window.storage`-functie die alleen binnen
Claude.ai-artifacts bestaat (zie `src/storage.js`). Alle bezoekers van de site zien
dus dezelfde, gedeelde ladderstand — precies zoals bedoeld voor een clubtool met
meerdere gebruikers.

### 1. Supabase-project + tabel

1. Maak een gratis account/project aan op [supabase.com](https://supabase.com).
2. Ga naar **SQL Editor** → "New query" → plak en run:
   ```sql
   create table kv_store (
     key text primary key,
     value text not null,
     updated_at timestamptz not null default now()
   );

   alter table kv_store enable row level security;

   create policy "Anon kan alles lezen"   on kv_store for select to anon using (true);
   create policy "Anon kan alles schrijven" on kv_store for insert to anon with check (true);
   create policy "Anon kan alles bijwerken" on kv_store for update to anon using (true);
   create policy "Anon kan alles verwijderen" on kv_store for delete to anon using (true);
   ```
3. Ga naar **Project Settings → API** en noteer de **Project URL** en de **anon
   public key**.

> **Let op — beveiliging:** de policies hierboven geven iedereen die de anon key
> kent (die zichtbaar is in de website-broncode, dat is normaal bij Supabase)
> volledig lees/schrijf/verwijder-toegang, zonder in te loggen. Voor een interne
> clubtool zonder inlogsysteem is dat vergelijkbaar met de huidige situatie in de
> app zelf. Wil je dit later steviger afschermen, dan is Supabase Auth de
> logische vervolgstap.

### 2. Omgevingsvariabelen instellen

Kopieer `.env.example` naar `.env` en vul je eigen gegevens in:
```
VITE_SUPABASE_URL=https://jouw-project.supabase.co
VITE_SUPABASE_ANON_KEY=jouw-anon-public-key
```
`.env` staat in `.gitignore` en wordt dus nooit meegecommit.

### 3. Testen vóór productie

Gebruik een **apart Supabase-project voor testen** (bijv. `padel-ladder-test`) en
koppel dat aan je `ontwikkel`-branch/preview-deploy in Netlify. Pas als alles goed
werkt, koppel je een tweede, "echt" Supabase-project aan je productiesite (`main`).
Zie de projectnotities voor de volledige branch/deploy-workflow.

## Lokaal draaien

```bash
npm install
npm run dev
```

Opent op `http://localhost:5173`.

## Deployen op Netlify

**Belangrijk:** voeg de omgevingsvariabelen ook toe in Netlify zelf (**Site
configuration → Environment variables**), met dezelfde namen (`VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`) — anders werkt de live site niet, ook al staat alles
goed in je lokale `.env`.

**Optie A — via GitHub (aanbevolen)**

1. Zet dit project in een GitHub-repo (zie eerdere instructies).
2. Ga naar [app.netlify.com](https://app.netlify.com) → "Add new site" →
   "Import an existing project" → kies je GitHub-repo.
3. Voeg de omgevingsvariabelen toe (zie hierboven) vóór de eerste deploy.
4. Netlify herkent automatisch `netlify.toml`. Klik op "Deploy site".
5. Elke nieuwe push naar de gekoppelde branch deployt automatisch opnieuw.

**Optie B — direct uploaden (zonder GitHub)**

1. Bouw de app lokaal:
   ```bash
   npm install
   npm run build
   ```
2. Sleep de gegenereerde `dist`-map naar [app.netlify.com/drop](https://app.netlify.com/drop).

## Projectstructuur

```
padel-ladder-app/
├─ index.html
├─ netlify.toml          ← Netlify build-configuratie
├─ package.json
├─ vite.config.js
├─ .env.example           ← sjabloon voor je Supabase-gegevens
├─ public/
│  └─ _redirects          ← SPA-redirect voor Netlify
└─ src/
   ├─ main.jsx             ← React entry point
   ├─ App.jsx               ← De volledige app (ongewijzigd overgenomen)
   └─ storage.js             ← Supabase-koppeling voor window.storage
```
