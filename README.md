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

## Research: kijken wat op de platforms werkt

Op `/scout` (menu-item "Research") kijkt de tool naar buiten, op twee manieren:

**Zoektermen** — het Sandcastles-idee. Je geeft zoektermen op ("supergaande", "raad de vrouw") en de scout zoekt daarmee zelf op de platforms, ongeacht van wie de posts zijn. Voor Shorts gebruikt hij YouTube's eigen "deze week"-filter, zodat de set vers is en views direct vergelijkbaar zijn; alles boven 2× de mediaan van de set wordt bewaard en gedecodeerd.

**Accounts volgen** — concurrent-clippers en de creator zelf. Uitschieters zijn hier posts boven 3× de mediaan van dat account zelf, zodat een groot account niet automatisch wint.

Wat werkt zonder scraping-key (gratis, via yt-dlp met je browsercookies): TikTok-accounts, Shorts-kanalen, Shorts-zoektermen, en het tracken van je eigen TikTok/Shorts-clips. Wat de ScrapeCreators-key nodig heeft: alles op Instagram/Reels (de gratis extractor is daar upstream kapot) en zoeken op TikTok. De tool kiest automatisch: zonder key de gratis route, mét key de provider.

Faalt de Claude-decodering (bijvoorbeeld op credits), dan bewaart de scout de vondsten alsnog en decodeert een volgende run ze alsnog.

Beide stromen komen samen in één decodering: Claude legt per vondst uit wat de hook en structuur is en waarom het werkt, en destilleert er kandidaat-regels uit. Een patroon telt pas als het bij minstens twee verschillende accounts terugkomt, en het wordt pas een echte vaultregel als de retro het met onze eigen cijfers bevestigt. Zo blijft de vault gebaseerd op wat bij óns werkt, niet op wat er elders toevallig viraal ging.

De scout draait dagelijks om 07:00 (cron) of handmatig via de knop.

## Opdrachten: briefing in, script uit

`/opdrachten` is de andere kant van de tool. In plaats van knippen uit bestaand materiaal schrijf je hier een briefing, en krijg je een volledig script terug: concept, hook met tekst-overlay en gesproken tekst, een shotlist per seconde met beeld, tekst en editnotitie, captions per platform, benodigdheden, varianten, en een onderbouwing.

Het script wordt geschreven op basis van dezelfde vault als de clip-planner, plus de best presterende scout-vondsten. De onderbouwing legt uit waarom juist die structuur en hook gekozen zijn. Elke generatie wordt bewaard als aparte versie met de vault-snapshot erbij.

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

## Betalen uit je abonnement in plaats van API-credits

Standaard staat `CLAUDE_BACKEND=claude-code` in `.env`: alle Claude-calls (plannen, scripts, decoderingen, retro) lopen dan via de lokale Claude Code CLI en tellen mee in je Claude-abonnement in plaats van losse API-credits. Eenmalig nodig:

```bash
claude login
```

Let op: dit werkt alleen op je eigen machine. Op Vercel bestaat de CLI niet — zet daar `CLAUDE_BACKEND=api` met een `ANTHROPIC_API_KEY`. De tool haalt bij dit backend bewust `ANTHROPIC_API_KEY` uit de omgeving van het subprocess, zodat er nooit stiekem tóch credits verbranden. Zware dagen kunnen tegen de rate-limits van je abonnement aanlopen; dan is de API het vangnet.

## Live zonder Mac én zonder API-credits (GitHub Actions)

De taken kunnen ook in de cloud draaien terwijl je Mac dicht is, zonder API-credits. De truc is `claude setup-token`: die geeft een langlevende abonnements-token die op een server werkt. GitHub Actions levert de gratis servertijd; `.github/workflows/clipper-jobs.yml` bevat dezelfde drie taken als launchd.

Eenmalige setup:

1. Token maken (opent je browser):

   ```bash
   claude setup-token
   ```

2. De token als secret zetten:

   ```bash
   gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo BenxFPG1/clipper-os
   ```

   (plak de token als hij erom vraagt; Supabase-secrets staan er al)

3. Testen zonder te wachten op de klok:

   ```bash
   gh workflow run clipper-jobs -f job=tracking --repo BenxFPG1/clipper-os
   ```

Draai launchd en Actions niet allebei; zet de lokale taken uit met `launchctl bootout gui/$UID/nl.clipper-os.<taak>` zodra Actions loopt.

Eerlijke kanttekening: GitHub-servers hebben datacenter-IP's. TikTok-research werkt daar meestal; YouTube kan de bot-check opwerpen. Optioneel secret `YTDLP_COOKIES_B64` (base64 van een geëxporteerde cookies.txt) lost dat op; anders logt de scout het als fout per bron en gaat door. De UI zelf zet je live op Vercel (met `CLAUDE_BACKEND=api` als je dáár ooit wilt genereren — de knoppen in de UI blijven anders Mac-werk).

## Automatisering op je Mac (launchd)

Met het abonnements-backend draait de automatisering op je eigen Mac. Dat betekent níet dat hij constant open moet: de taken staan in macOS' eigen takenplanner (launchd), en die haalt gemiste taken in zodra je Mac weer wakker is. Is je Mac om 07:30 dicht, dan draait de scout gewoon zodra je hem openklapt.

Wat er is ingepland (`~/Library/LaunchAgents/nl.clipper-os.*.plist`):

| Taak | Wanneer | Wat |
| --- | --- | --- |
| tracking | 4× per dag (2:15, 8:15, 14:15, 20:15) | views/likes van geposte clips + performance-berekening |
| scout | dagelijks 7:30 | research: accounts volgen + zoektermen, decoderen, kandidaat-regels |
| retro | zondag 9:30 | wekelijks vault-voorstel naar de agent-inbox |

De webserver hoeft er niet voor te draaien; de taken roepen de code rechtstreeks aan (`npm run job -- tracking|scout|retro` doet hetzelfde handmatig). Logs staan in `~/Library/Logs/clipper-os/`. Uitzetten kan per taak met `launchctl bootout gui/$UID/nl.clipper-os.<taak>` plus het plist-bestand weggooien.

Het "zichzelf trainen" heeft je Mac dus maar een paar minuten per dag nodig. De enige stap die echt om jou vraagt is het goedkeuren van retro-voorstellen in de agent-inbox — en dat is bewust zo (sectie 3: de mens keurt goed). Wil je ooit volledige cloud-autonomie zonder Mac: deploy op Vercel met `CLAUDE_BACKEND=api` en de ScrapeCreators-key; dan vervalt alleen de gratis yt-dlp-route.

## Premiere/Resolve-project: de cuts op de tijdlijn

De beste route voor kwaliteit en controle: een echt projectbestand in plaats van een gebakken video.

```bash
npm run project -- <video-id>
```

Dit downloadt de bron in volle kwaliteit en schrijft een `.xml` met per clip een sequence: alle cuts uit het plan los op de tijdlijn, met de editnotities als clipnamen. Elke knip is nog te verschuiven en de verticale uitsnede gebeurt in de editor met volle bronresolutie. Openen: Premiere → File → Import, of DaVinci Resolve (gratis) → File → Import Timeline. CapCut kent geen open projectformaat; daarvoor is de mp4-route hieronder.

## Ruwe montage (het knipwerk automatisch)

De tool levert niet alleen het plan maar ook de ruwe montage: elk fragment uit het plan geknipt en achter elkaar gezet, verticaal 1080x1920, klaar om in CapCut te openen.

```bash
npm run roughcut -- <video-id>            # alle clips uit het nieuwste plan
npm run roughcut -- <video-id> --clip 3   # alleen clip 3
npm run roughcut -- --opruimen            # gedownloade bronvideo's weggooien
```

De bestanden komen in `~/Movies/Clipper OS/`. De bronvideo wordt één keer gedownload en hergebruikt voor alle clips uit dezelfde video; dat is verreweg de traagste stap.

Bewust **ruw**: de tool doet het mechanische werk — de juiste fragmenten in de juiste volgorde, ook als die twintig minuten uit elkaar liggen — en laat alles waar oordeel voor nodig is aan de editor: zooms, ondertitels, muziek, precieze in- en uitpunten. Zo blijft de vakkennis waar hij hoort en vervalt alleen het knip- en plakwerk.

Werkt op je Mac (yt-dlp en ffmpeg), niet op Vercel.

## Kosten en doorlooptijd

Gemeten op een echte aflevering van 39 minuten (440 transcriptsegmenten):

| Stap | Duur | Kosten |
| --- | --- | --- |
| Character map | onderdeel van de 10 min | €0,27 |
| Clip-plan (23 clips) | samen ±10 min | €1,14 |
| Script uit een briefing | ±2,5 min | €0,18 |

Een volledig plan kost dus ongeveer €1,40. De tien minuten zitten boven de vijf uit de definition of done; dat komt door de denkdiepte. Die staat per stap in `.env`:

```
CHARMAP_EFFORT=high
PLAN_EFFORT=xhigh
SCRIPT_EFFORT=xhigh
AGENT_EFFORT=high
```

De knoppen om een plan goedkoper te maken, op volgorde van impact:

1. **`CLAUDE_BACKEND=claude-code`** — geen API-kosten meer, zie hierboven.
2. **`PLAN_MAX_CLIPS=15`** (10-25) — de output-tokens zijn de grootste post; minder vulling-clips scheelt direct, de topclips veranderen er niet van.
3. **"Character map hergebruiken"** aanvinken bij een nieuwe planversie — scheelt de hele stap 1.
4. **`PLAN_EFFORT=high`** i.p.v. `xhigh` — halveert de doorlooptijd ruwweg; test op eigen materiaal of je verschil ziet.

Draai de eval alleen bij prompt- of vaultwijzigingen: die kost een volledige plan-run per case.

Providerkosten worden per call gelogd in `provider_usage`. De tracking-run geeft een alert zodra de maandkosten `COST_ALERT_EUR` (standaard €20) overschrijden.

## Scope

Geen finale video-rendering (wel ruwe montages), geen auto-posting, geen multi-user, geen publieke outlier-database. Ideeën daarbuiten gaan naar `BACKLOG.md`.

## Muziek onder de clips

Standaard gebruikt de montage de gesynthetiseerde bedden uit `assets/muziek`
(`scripts/maak-muziek.sh` bouwt ze opnieuw). Rechtenvrij en sober, maar het is
geen productiemuziek.

Dit kost niets en is de standaard: zonder `MUZIEK_PROVIDER` in je `.env` wordt
er nooit een betaalde dienst aangeroepen. Wil je betere muziek zonder kosten,
zet dan zelf rechtenvrije tracks als `assets/muziek/spanningsbed.mp3`,
`opbouw.mp3` en `luchtig.mp3` neer — die winnen automatisch van de
gesynthetiseerde versies.

Wil je per clip een passend bed laten genereren (betaald), zet dan in `.env`:

    MUZIEK_PROVIDER=elevenlabs
    ELEVENLABS_API_KEY=...

Suno heeft geen publieke API — alleen doorverkopers. Wil je die toch gebruiken:

    MUZIEK_PROVIDER=suno_compat
    MUZIEK_BASIS_URL=https://api.van-je-aanbieder.example
    MUZIEK_API_KEY=...

Gegenereerde bedden worden gecachet op sfeer + beschrijving, dus clips met
dezelfde sfeer delen één bed en je betaalt niet per render opnieuw. Eigen
gelicenseerde muziek als `assets/muziek/<sfeer>.mp3` wint altijd wanneer de
provider op `lokaal` staat.
