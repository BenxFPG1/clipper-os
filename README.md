# Clipper OS

Interne tool voor de clipping-workflow: van lange bronvideo naar strategisch clip-plan, naar geposte clips, naar automatische performance-tracking, naar een vault die zichzelf wekelijks bijstelt op basis van eigen data.

## Opzetten

1. **Dependencies**

   ```bash
   npm install
   ```

2. **Supabase-schema** — draai `supabase/schema.sql` in de SQL-editor van je Supabase-project.

3. **Env-vars** — kopieer `.env.example` naar `.env` en vul in:

   ```bash
   cp .env.example .env
   ```

   Minimaal nodig om te plannen: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`.
   Voor tracking daarnaast `SCRAPECREATORS_API_KEY` (of `APIFY_TOKEN` met `SCRAPING_PROVIDER=apify`).

4. **Vault en voorbeeldcampagne laden**

   ```bash
   npm run seed
   ```

   Idempotent: bestaande gewichten blijven staan, dus opnieuw seeden wist nooit het leerwerk van de Retro-agent.

5. **Draaien**

   ```bash
   npm run dev
   ```

## De workflow

1. **Campagne** — komt uit de seed, of via `POST /api/campaigns`.
2. **Bronvideo** — op `/videos`: YouTube-URL (captions worden automatisch opgehaald) of transcript plakken met regels als `0:07 tekst`.
3. **Clip-plan** — op de videopagina op "Clip-plan genereren". Twee Claude-calls: eerst de character map over de hele video, dan het plan. Duurt enkele minuten.
4. **Editen en posten** — Marlou werkt de kaarten in de plan-editor af, zet de status om en plakt de post-URL. Zodra de URL binnenkomt gaat de clip op `posted` met een `posted_at`; dat is het nulpunt voor alle tijdvensters.
5. **Tracking** — draait vanzelf elke 6 uur (`vercel.json`). Handmatig:

   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/track
   ```

6. **Wekelijkse retro** — zondagochtend. Het voorstel komt in `/inbox`; Antonie keurt goed of af. Pas bij goedkeuring verandert de vault, met changelog-entry en version bump.

## Evals

Eval-case #1 vraagt om het Supergaande "Raad de Vrouw"-transcript:

```bash
npm run seed:eval -- ./transcripts/supergaande-raad-de-vrouw.txt
npm run eval
```

`npm run eval` geeft exit-code 1 zodra één case faalt — hang dit voor elke prompt- of vault-wijziging ertussen. Gecontroleerd wordt: valide JSON, tijdcodes binnen de videoduur en oplopend, minimum aantal clips, of de bekende gouden momenten gevonden zijn (gezichtsmasker ~16:36, AI/Gemini-reveal ~34:44) en of minstens één edit fragmenten combineert die meer dan 15 minuten uit elkaar liggen.

## Architectuur

```
src/lib/
  claude.ts            forced tool use + zod-validatie + één repair-retry
  ingest/              YouTube-captions, transcript-parsing, normalisatie
  planner/             stap 1 (character map) + stap 2 (clip-plan), prompts, schema
  vault/               seed-data, laden, prompt-weergave
  tracking/            provider-abstractie, snapshots, performance-berekening
  agents/              retro (wekelijks), eval (poort), scout (fase 2)
src/app/               UI-schermen en API-routes
```

Versionering: elke plan-run legt `prompt_version`, `schema_version` en een volledige `vault_snapshot` vast, zodat een plan later exact te herleiden is naar de gewichten waarmee het gemaakt is.

## Kosten

Providerkosten worden per call gelogd in `provider_usage`. De tracking-run geeft een alert zodra de maandkosten `COST_ALERT_EUR` (standaard €20) overschrijden.

## Scope

Geen video-rendering, geen auto-posting, geen multi-user, geen publieke outlier-database. Ideeën daarbuiten gaan naar `BACKLOG.md`.
