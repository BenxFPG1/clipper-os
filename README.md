# Clipper OS

Interne tool voor de clipping-workflow: van lange bronvideo naar strategisch clip-plan, naar geposte clips, naar automatische performance-tracking, naar een vault die zichzelf wekelijks bijstelt op basis van eigen data.

## Opzetten

1. **Dependencies**

   ```bash
   npm install
   ```

   Voor eigen transcriptie ook yt-dlp en ffmpeg:

   ```bash
   brew install yt-dlp ffmpeg
   ```

2. **Supabase-schema** — draai `supabase/schema.sql` in de SQL-editor van je Supabase-project.

3. **Env-vars** — kopieer `.env.example` naar `.env` en vul in:

   ```bash
   cp .env.example .env
   ```

   Minimaal nodig om te plannen: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`.
   Voor eigen transcriptie `GROQ_API_KEY`, voor tracking `SCRAPECREATORS_API_KEY` (of `APIFY_TOKEN` met `SCRAPING_PROVIDER=apify`).

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
2. **Bronvideo** — op `/videos`: plak een YouTube-URL. Zijn er captions, dan gebruiken we die; zo niet, dan bouwen we zelf een transcript (yt-dlp haalt de audio, Whisper op Groq transcribeert). Het vinkje "altijd zelf transcriberen" slaat captions over — dat geeft nauwkeurigere tijdcodes dan auto-captions. Een transcript plakken kan ook.

   Voor lange video's is het CLI-script prettiger, want dat heeft geen last van request-timeouts:

   ```bash
   npm run transcribe -- "https://youtube.com/watch?v=..." --campaign <campagne-uuid>
   ```

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

Het model staat op **Claude Opus 5** (`CLAUDE_MODEL`). Dat model accepteert geen `temperature`, dus de consistentie uit sectie 3 komt niet uit een sampling-parameter maar uit de vastgelegde prompt-versie en vault-snapshot per plan, plus een vaste `effort` per call (`high` voor de character map en de retro, `xhigh` voor het plan zelf).

```
src/lib/
  claude.ts            forced tool use + zod-validatie + één repair-retry
  ingest/              YouTube-captions, eigen Whisper-transcriptie, parsing
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
