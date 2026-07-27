# Backlog

Alles wat buiten v1-scope valt. Niets hieruit gaat de sprint in zonder expliciet besluit.

## Bekend gat in v1

- **Whisper-fallback voor transcriptie.** Video's zonder YouTube-captions moeten nu handmatig geplakt worden. De ingest-route geeft daar een expliciete 422 op. Implementatie: audio via yt-dlp → Whisper (Groq/Deepgram), `transcript_source = 'whisper'`. De env-var `GROQ_API_KEY` staat al klaar.
- **Scout-agent (fase 2).** `src/lib/agents/scout.ts` is een bewuste stub. Volgt outliers van `tracked_accounts`, decodeert hook en structuur, schrijft kandidaat-heuristieken die pas actief worden na bevestiging door de Retro-agent met eigen data.

## Later

- Speaker-diarization in het transcript (nu leidt de analysestap sprekers uit context af).
- Meerdere eigen accounts per platform in `tracked_accounts`; nu wordt één mediaan per platform bijgehouden onder handle `ons_account`.
- Plan-versies naast elkaar vergelijken in de UI (oude versies worden wel bewaard, maar niet getoond).
- A/B-rapportage per variant-paar in het performance-scherm.
- Automatische eval-run als pre-deploy hook in plaats van handmatig `npm run eval`.
- Notificatie (mail/Slack) bij een openstaand retro-voorstel of een kostenalert.
