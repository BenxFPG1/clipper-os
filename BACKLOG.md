# Backlog

Alles wat buiten de huidige scope valt. Niets hieruit gaat de sprint in zonder expliciet besluit.

## Blokkeert nu iets

- **ScrapeCreators-key ontbreekt.** Blokkeert alleen nog Instagram/Reels (accounts, zoeken, tracking) en zoeken op TikTok. TikTok-accounts, Shorts en het tracken van eigen TikTok/Shorts-clips werken gratis via yt-dlp.
- **Anthropic-credits zijn op (27 juli).** Plannen, scripts en decoderen liggen stil tot er credits bij zijn; de scout blijft wel vondsten verzamelen.

## Bekende beperkingen

- **Transcriberen en YouTube-ingest draaien niet op Vercel.** Beide leunen op yt-dlp en ffmpeg als lokale binaries, plus browsercookies om YouTube's bot-check te passeren. Werkt op de Mac en op een eigen server, niet op serverless. Opties als dat nodig wordt: een kleine worker (Fly.io/Railway), of het CLI-script draaien en het resultaat uploaden.
- **YouTube-cookies verlopen.** `YTDLP_COOKIES_FROM_BROWSER=chrome` leest de cookies uit Chrome. Als YouTube je daar uitlogt, faalt de ingest met een duidelijke melding.
- **Instagram-metrics zijn het wankelst.** TikTok en YouTube leveren betrouwbare cijfers via de providers; Reels wisselt per provider en per post.

## Later

- **Doorlooptijd van het clip-plan.** Op een video van 39 minuten duurt de pipeline ongeveer tien minuten, waar de definition of done vijf noemt. Instelbaar via `PLAN_EFFORT`; of `high` even goede plannen geeft moet op eigen materiaal getest worden.
- Speaker-diarization in het transcript (nu leidt de analysestap sprekers uit context af).
- Meerdere eigen accounts per platform in `tracked_accounts`; nu wordt één mediaan per platform bijgehouden onder handle `ons_account`.
- Plan- en scriptversies naast elkaar vergelijken in de UI (oude versies worden wel bewaard, maar niet getoond).
- A/B-rapportage per variant-paar in het performance-scherm.
- Scout-vondsten mét transcript: nu decoderen we op caption en cijfers. Het transcript van andermans clip erbij halen zou de decodering scherper maken, maar kost extra credits per post.
- Van script naar clip: een goedgekeurd script als `clips`-rij zodat ook zelfgemaakte video's meelopen in de performance-tracking en dus in de retro.
- Automatische eval-run als pre-deploy hook in plaats van handmatig `npm run eval`.
- Notificatie (mail/Slack) bij een openstaand retro-voorstel of een kostenalert.
