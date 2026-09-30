# Eigen muziek en geluidseffecten

Zet hier je eigen gelicenseerde audio neer; de tool mixt hem automatisch onder
de montage. Licenties liggen bij jou (Epidemic Sound, Artlist,
platform-bibliotheken, of rechtenvrije tracks).

## Muziek (assets/muziek)

### Echte tracks per sfeer (aanbevolen)
Maak per sfeer een map en zet er zoveel tracks in als je wilt:

    assets/muziek/spanningsbed/*.mp3   laag, ritmisch bed
    assets/muziek/opbouw/*.mp3         bouwt mee met de escalatie
    assets/muziek/luchtig/*.mp3        comedy en lichte content

(.mp3, .wav en .m4a werken.) De sfeer komt uit het plan (`muziek` per clip).

- **Keuze**: per clip één track, vast bepaald op het clip-id. Dezelfde clip
  krijgt bij een herrender dezelfde track; clips van één video lopen uiteen.
- **Beats**: de track wordt gemeten (energie-onsets per 23 ms, tempo 70–170
  bpm). Knippen die binnen 120 ms (MONTAGE_BEAT_MAX_VERSCHUIF) naast een beat
  vallen, schuiven erop — alleen binnen stilte, nooit door een woord. Een track
  zonder duidelijke puls (ambient) wordt niet gebruikt om op te knippen.
- **Dynamiek**: na de hook komt het bed iets omhoog (MONTAGE_MUZIEK_NA_HOOK,
  standaard ×1,25, in een halve seconde); vlak vóór de payoff valt het weg en
  daarna komt het terug. Onder spraak zakt het mee (ducking).
- Tracks bij voorkeur zonder zang en met een rustige intro: de eerste en
  laatste 1,2 s worden in- en uitgefade, de track wordt herhaald als de clip
  langer is.

Logregel in CI: `muziek: track <map>/<bestand> (<bpm> bpm, <n> beats, zekerheid <x>), <k>/<m> knippen op de beat`.

### Zonder map: één bed per sfeer (oud gedrag)
Staat er geen map of is die leeg, dan geldt het oude gedrag: bestandsnaam =
de sfeer-slug (`spanningsbed.mp3`, `opbouw.mp3`, `luchtig.mp3`), zonder
beat-uitlijning.

Uitzetten: `MONTAGE_AFWERKING_MUZIEK=0` of per campagne
`huisstijl.afwerking.muziek = false` (dan geen tracks, beats of hook-dynamiek;
het oude bed blijft).

## Geluidseffecten (assets/sfx)
Bestandsnaam = de sfx-slug, bv. whoosh.wav, impact.wav, riser.wav, ding.wav.
Het sound design plaatst ze spaarzaam en mechanisch (sounddesign.ts): een
riser in de 1,4 s vóór de payoff, een impact op het payoff-woord, een ding
onder een kaart met een getal, een whoosh op een kaderwissel of een kaart die
binnenkomt — hoogstens één effect per 3 s, laag onder de stem. Ontbreekt een
bestand, dan wordt het effect stil overgeslagen. Uitzetten:
`MONTAGE_AFWERKING_SFX=0` (dan het oude gedrag: sfx per shot uit het plan).
