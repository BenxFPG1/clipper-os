# Backlog

Alles wat buiten de huidige scope valt. Niets hieruit gaat de sprint in zonder expliciet besluit.

## Blokkeert nu iets

- **ScrapeCreators-key ontbreekt.** Zonder die key kan de Scout-agent niet bij andere accounts kijken en kan de tracking geen views ophalen. Dit is de enige harde blokkade op twee complete modules.
- **Eval-case #1 wacht op het transcript.** Het script en de verwachtingen staan klaar (`npm run seed:eval -- <bestand>`), maar zonder het Supergaande "Raad de Vrouw"-transcript kan de eval-poort niet groen draaien. Tot die tijd is er geen automatische rem op promptwijzigingen.

## Bekende beperkingen

- **Transcriberen en YouTube-ingest draaien niet op Vercel.** Beide leunen op yt-dlp en ffmpeg als lokale binaries, plus browsercookies om YouTube's bot-check te passeren. Werkt op de Mac en op een eigen server, niet op serverless. Opties als dat nodig wordt: een kleine worker (Fly.io/Railway), of het CLI-script draaien en het resultaat uploaden.
- **YouTube-cookies verlopen.** `YTDLP_COOKIES_FROM_BROWSER=chrome` leest de cookies uit Chrome. Als YouTube je daar uitlogt, faalt de ingest met een duidelijke melding.
- **Instagram-metrics zijn het wankelst.** TikTok en YouTube leveren betrouwbare cijfers via de providers; Reels wisselt per provider en per post.

## Later

- Speaker-diarization in het transcript (nu leidt de analysestap sprekers uit context af).
- Meerdere eigen accounts per platform in `tracked_accounts`; nu wordt één mediaan per platform bijgehouden onder handle `ons_account`.
- Plan- en scriptversies naast elkaar vergelijken in de UI (oude versies worden wel bewaard, maar niet getoond).
- A/B-rapportage per variant-paar in het performance-scherm.
- Scout-vondsten mét transcript: nu decoderen we op caption en cijfers. Het transcript van andermans clip erbij halen zou de decodering scherper maken, maar kost extra credits per post.
- Van script naar clip: een goedgekeurd script als `clips`-rij zodat ook zelfgemaakte video's meelopen in de performance-tracking en dus in de retro.
- Automatische eval-run als pre-deploy hook in plaats van handmatig `npm run eval`.
- Notificatie (mail/Slack) bij een openstaand retro-voorstel of een kostenalert.
