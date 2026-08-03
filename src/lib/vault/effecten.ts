/**
 * De effectenvault: een vaste woordenlijst van geluids- en beeldingrepen die
 * een editor kent en snel kan uitvoeren.
 *
 * Bewust géén audiobestanden. Die zijn licentiegevoelig, vreten opslag en
 * elke editor heeft zijn eigen bibliotheek. Wat we wél vastleggen is wanneer
 * een ingreep werkt en wanneer hij averechts is — dat is de kennis die je
 * anders elke keer opnieuw moet uitleggen. Doordat het vaste slugs zijn, kan
 * de retro later meten welke ingrepen samenhangen met betere retentie, net
 * zoals dat nu met structuren en hooks gebeurt.
 */

export const SFX_SLUGS = [
  'geen',
  'whoosh',
  'riser',
  'impact',
  'bass_drop',
  'stilte',
  'record_scratch',
  'ding',
  'klok_tik',
  'crowd_reactie',
  'typemachine',
  'sub_boom',
] as const;

export const BEELD_EFFECT_SLUGS = [
  'geen',
  'punch_in',
  'snelle_zoom',
  'shake',
  'freeze_frame',
  'speed_ramp',
  'slow_motion',
  'flits_wit',
  'zwart_frame',
  'tekstkaart',
  'pijl_of_cirkel',
  'split_screen',
] as const;

export type SfxSlug = (typeof SFX_SLUGS)[number];
export type BeeldEffectSlug = (typeof BEELD_EFFECT_SLUGS)[number];

export const EFFECTEN = `=== EFFECTENVAULT: GELUID EN BEELD ===

Kies per shot uit deze lijst. Gebruik "geen" als het shot het zonder redt — een
ingreep zonder functie leidt af en kost je de kijker.

GELUID (veld "sfx"):
- whoosh: markeert een tijdsprong of wissel van locatie. Alleen op een echte sprong, niet op elke cut.
- riser: bouwt spanning op naar een onthulling. Duurt 1-2s en stopt exact op het antwoord, nooit erdoorheen.
- impact: legt een klap onder het moment dat de aanname breekt (de barst).
- bass_drop: onder de payoff, maar alleen als de payoff visueel groot is; bij een gesproken payoff overstemt hij de zin.
- stilte: alle muziek en omgevingsgeluid één seconde weg vlak vóór de onthulling. Het goedkoopste en sterkste effect dat er is.
- record_scratch: patroonbreuk in comedy. Één keer per clip, hooguit.
- ding: bevestigt een correct antwoord of een punt in een spel/quiz.
- klok_tik: onder een wachtmoment of aftelling; verhoogt de gevoelde inzet.
- crowd_reactie: alleen als er in de bron echt gereageerd wordt; verzonnen gelach voelt onecht.
- typemachine: onder tekst die letter voor letter verschijnt, bij statistieken of citaten.
- sub_boom: lage klap onder een tekstkaart die hard binnenkomt.

MUZIEK (veld "muziek" op clipniveau):
- geen: gesprek draagt zichzelf. De veiligste keuze bij een sterke dialoog.
- spanningsbed: laag, ritmisch, zonder melodie die de aandacht steelt. Start pas na de hook.
- opbouw: bouwt mee met de escalatie en valt weg op de payoff.
- luchtig: bij comedy en lichte content; nooit onder een emotioneel moment.
- trending_sound: alleen als het platform er baat bij heeft en de dialoog verstaanbaar blijft.

BEELD (veld "beeld_effect"):
- punch_in: kleine sprong dichter op het gezicht bij een belangrijke zin. Werkt als accent op één zin, niet als vaste ritmiek.
- snelle_zoom: energieke overgang tussen twee beats, past bij comedy en hoge tempo's.
- shake: onder een impact; kort (max 3 frames), anders wordt het misselijkmakend.
- freeze_frame: bevriest de reactie op het moment van de barst, meestal samen met een tekstkaart.
- speed_ramp: versnelt saaie aanloop en vertraagt op het moment dat het gebeurt.
- slow_motion: alleen op reacties die je wilt laten landen; nooit op praten (de audio wordt onbruikbaar).
- flits_wit: dekt een harde tijdsprong af; twee frames is genoeg.
- zwart_frame: één zwart frame vlak vóór de payoff; werkt als een ademteug.
- tekstkaart: kaart in beeld met een korte regel ("3 minuten later", "hij weet dit niet"). Verplicht bij elke tijdsprong.
- pijl_of_cirkel: wijst aan waar je moet kijken bij een detail dat anders gemist wordt.
- split_screen: twee reacties tegelijk, of vraag en antwoord naast elkaar.

REGELS:
- Hoogstens twee ingrepen per shot; drie of meer maakt het rommelig en trekt de aandacht weg van de inhoud.
- Elke tijdsprong krijgt een tekstkaart, met of zonder whoosh — anders denkt de kijker dat de clip verkeerd geknipt is.
- Stilte vóór de payoff verslaat bijna elk toegevoegd geluid.
- Kies nooit een effect omdat het "leuk staat": schrijf bij elke keuze wat het voor de kijker doet.`;
