# Backlog

Alles wat buiten v1-scope valt. Niets hieruit gaat de sprint in zonder expliciet besluit.

## Bekend gat in v1

- **Scout-agent (fase 2).** `src/lib/agents/scout.ts` is een bewuste stub. Volgt outliers van `tracked_accounts`, decodeert hook en structuur, schrijft kandidaat-heuristieken die pas actief worden na bevestiging door de Retro-agent met eigen data.
- **Transcriberen op Vercel.** De eigen transcriptie leunt op yt-dlp en ffmpeg als lokale binaries. Dat werkt op je Mac en op elke eigen server, maar niet op Vercel serverless. Opties als dat nodig wordt: een kleine worker (Fly.io/Railway) met dezelfde `transcribeYoutube`, of het CLI-script draaien en het resultaat uploaden.

## Later

- Speaker-diarization in het transcript (nu leidt de analysestap sprekers uit context af).
- Meerdere eigen accounts per platform in `tracked_accounts`; nu wordt één mediaan per platform bijgehouden onder handle `ons_account`.
- Plan-versies naast elkaar vergelijken in de UI (oude versies worden wel bewaard, maar niet getoond).
- A/B-rapportage per variant-paar in het performance-scherm.
- Automatische eval-run als pre-deploy hook in plaats van handmatig `npm run eval`.
- Notificatie (mail/Slack) bij een openstaand retro-voorstel of een kostenalert.
