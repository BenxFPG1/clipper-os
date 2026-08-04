/**
 * Editkennis: hoe je van goede knippen een goede edit maakt. Gaat mee in de
 * plan- en scriptprompts én stuurt de automatische montage aan (dode lucht,
 * pacing, kadering). Gebaseerd op gedocumenteerde talking-head- en short-form-
 * praktijk, niet op smaak.
 */
export const EDITCRAFT = `=== EDITCRAFT: STILTES, PACING EN KADER ===

STILTES — welke blijven, welke gaan:
- Dode lucht (denkpauzes, "ehm", stilte midden in een uitleg) gaat eruit. Alles boven ~0,8s zonder functie wordt strak getrokken naar ~0,3s. Dit is het verschil tussen een edit die "loopt" en een die sleept.
- Stilte MET functie blijft: de ademteug vlak vóór een onthulling (spanning), de valstilte ná een klap (laat de klap landen), en een reactiestilte waarin een gezicht het werk doet. Regel: stilte vóór of ín een payoff-shot blijft staan; overal elders wordt hij strak.
- Een lach of reactie nooit afkappen op de eerste piek: de tweede helft van een reactie is waar de kijker mee-lacht.

PACING — het ritme van de beats:
- De eerste drie seconden zijn het dichtst gemonteerd: geen aanloop, audio start mid-zin, beeldwissel binnen 2s.
- Wissel elke 2-4 seconden iets: knip, punch-in, tekstkaart of insert. Niet omdat het moet, maar een shot dat >5s statisch is zonder nieuwe informatie is een uitstapmoment.
- Vertraag bewust op het moment dat het gebeurt: vlak voor en op de payoff mag het ritme juist stil vallen. Constante hoge snelheid maakt de climax onzichtbaar.
- Knip op beweging of op de ademhaling tussen zinnen, nooit midden in een woord. Een knip die je hóórt is een fout, ook als je hem niet ziet.

KADER EN FOCUS — waar de kijker kijkt:
- Verticaal beeld is gevuld beeld. Zwarte balken boven en onder lezen als onafgemaakt; alleen een bewuste letterbox-stijl (mét ondertitelband en huisstijl) is acceptabel, en dan consequent over de hele clip.
- Het kader volgt de spreker: wie praat, staat in beeld. Bij twee personen aan tafel wissel je mee met de dialoog of kies je de reactie als die sterker is dan de tekst.
- Als het script zegt waar de focus ligt (een reactie, een object, een detail), wint het script van de standaard. Vul dan per shot het "focus"-veld: links / midden / rechts.
- Wissel kadrering als accent: een punch-in op de kernzin, een breder kader op de reactie. Twee identieke kadreringen achter elkaar knippen slecht; verschuif minstens 10% of wissel van onderwerp.

CONSISTENTIE — de clip als merk:
- Eén stijl per clip: zelfde ondertitelstijl, zelfde kaartstijl, zelfde kleuraccent. De kijker herkent een account aan de vormtaal vóór hij de naam leest.
- Gebruik de huisstijl van de campagne (kleur, font, toon) in kaarten en accenten, niet de standaardsjabloon van de tool.

RITME ALS DRAMATURGIE (Hillier-Smith, editor Logan Paul, Streamy Best Editing 2020):
- Trage cuts bouwen spanning, snelle cuts zíjn de payoff. Het ritme is niet constant maar volgt de emotie: versnellen naar het moment toe, en op het moment zelf ruimte geven.
- Net te weinig tijd om het beeld helemaal te zien wekt nieuwsgierigheid: een shot dat een fractie te vroeg wegknipt trekt de kijker naar het volgende.
- Elke knip, overgang en effect dient het verhaal. Een effect dat geen gevoel overbrengt is versiering en gaat eruit.
- Geef terugkerende personen of momenten een eigen audio-cue: dezelfde muziek of hetzelfde geluid bij hetzelfde type moment leert de kijker wat er komt, zonder uitleg.
- Geluid eerst: het juiste geluid op de juiste knip doet meer voor de beleving dan een visueel effect. Sound design is onderdeel van de vertelling, geen laag erbovenop.

TALKING-HEAD EN JUMP-CUTS (gedocumenteerde interviewpraktijk):
- Eerst de audio-edit: knip het gesprek zoals het moet klinken (tempo, inhoud), en repareer daarna het beeld. Andersom werken levert mooie beelden op met een slecht verhaal.
- Elke weggeknipte stilte of verspreking geeft een zichtbare sprong. Dek die af: met een insert/b-roll van 2-5 seconden, een punch-in (>10% schaalverschil), of een wissel naar de reactie van de ander.
- Een goed gedekt gesprek verdraagt dat meer dan de helft van de dialoog wegvalt zonder dat de kijker het merkt; ongedekt vallen diezelfde knippen meteen op.

VISUELE AFWISSELING EN TEKST (short-form praktijk, o.a. Ryan Herrick):
- Verander elke 2-4 seconden iets aan het beeld (knip, zoom, tekst, insert); langer dan 5-7 seconden statisch is een uitstapmoment.
- Tekstanimaties clean en kort: tekst die aandacht naar zichzélf trekt in plaats van naar de inhoud is ruis. Eén tekststijl per clip.
- Ondertiteling is verplicht: het overgrote deel van short-form wordt zonder geluid gestart. De ondertitel is bij muted afspelen je enige hook.

BEWEGING EN KEYFRAMES — waarom sommige zooms duur voelen en andere goedkoop:
- Nooit lineair bewegen: een zoom of pan krijgt altijd een aanloop en een remming (ease-in-out, S-curve). Lineaire beweging is het verschil tussen een template-edit en een dure edit.
- Zoom + shake is een klap-effect: kort (rond 0,1s), met een steile curve (cubic-in), en alleen op een beatdrop, impact of onthulling. Als vaste ritmiek wordt het goedkoop.
- Laat beweging, tekst en knippen landen op de tel van de muziek (downbeats). Een edit die op de beat valt voelt strak zonder dat de kijker weet waarom.
- Speed-ramps: versnel de aanloop, vertraag exact op het moment zelf. De vertraging ís de aandachtspijl.

ONDERTITELS ALS RETENTIE-INSTRUMENT (gedocumenteerde caption-praktijk):
- Woord-voor-woord (karaoke) captions die met de spraak meelopen houden aantoonbaar beter vast dan statische blokken: het leesritme volgt het spreekritme.
- Kernwoorden krijgen nadruk: één afwijkende kleur (hoog contrast, bv. geel of de huisstijlkleur) of net groter — ogen volgen beweging en contrast. Hooguit één à twee nadrukwoorden per zin, anders is niets meer nadruk.
- Eén captionstijl per account, consequent: de stijl is merkherkenning. Variatie alleen als bewuste nadruk.
- Plaats ondertitels in het middenvlak, nooit in de onderste ~20% (daar liggen de platformknoppen overheen).

AUDIO — isolatie, muziek en het stiltemoment:
- Spraak eerst schoon: bromtonen onder ~75Hz eruit, ruis dempen, en naar één vast luidheidsniveau. Onverstaanbaar = weggeswiped, en wisselende volumes tussen clips breken het account.
- Muziek is een bed, geen voorgrond: zacht, en met ducking (praat iemand, dan zakt de muziek automatisch). Muziek die met de stem vecht kost verstaanbaarheid én retentie.
- Het stiltemoment: op de payoff of een vragende beat ("...een bieropener?") valt de muziek volledig weg. Contrast maakt het moment groot — de stilte ná constant geluid is het hardste effect dat er is. Na de landing komt de muziek terug.
- SFX ondersteunen de knip, nooit de aandacht: kort, zacht (rond de helft van het spraakniveau), en alleen waar het plan er een functie voor geeft.
- Audio-cues zijn merkgeheugen (Hillier-Smith): zelfde type moment, zelfde geluid — de kijker leert het patroon.

UIT DE WERKWIJZE VAN BEKENDE EDITORS (uit hun eigen tutorials, aug 2026):

Hillier-Smith ("edit like an artist"):
- Schrijf de edit vóór je hem maakt: een montage begint niet met knippen maar met beat voor beat uitschrijven wat je wilt zien — pre-productie ín de post-productie. (Voor ons: dat is precies wat het plan/script doet; de edit voert het uit en improviseert niet.)
- Knip actie vanuit het personage, niet vanuit het spektakel: de vraag is "wat doet dit met hem/haar", niet "wat gebeurt er". Reactie boven gebeurtenis.
- Eye-tracing: onthoud wáár in het frame de kijker het laatst keek en zet de volgende belangrijke informatie daar. Zo voelt een edit glad zonder dat iemand weet waarom.
- De harde les uit het MrBeast-werk: de kijker geeft niets om jouw moeite. Hoeveel creativiteit ben je bereid op te geven voor bereik — en wat behoud je bewust als handtekening.

Finzar (gaming/verhaal-edits):
- Voice-over repareert geen saaie beelden: eerst de beste momenten cherry-picken, dán pas vertellen. De intro beantwoordt altijd wat/waarom/hoe, en de kwaliteit van de eerste seconden is een belofte over de rest ("als dit het niveau is, blijf ik").
- Zooms zijn beweging van A naar B met een functie (aanwijzen), altijd smooth met keyframes. Sound effects op elk groot moment (swish op wissels, pop op animaties) maar de gain laag — te harde sfx is de beginnersfout.
- Tegen de retentie-hysterie in: niet elke dode ruimte wegknippen. Ruimte laten om te praten en persoonlijkheid te tonen onderscheidt je; kijkers zijn klaar met één-knip-per-seconde.
- Eén muzieksmaak per video. En kijk je edit een dag later met frisse ogen terug als kijker, niet als maker.

Ryan Herrick (short-form workflow):
- Knip op de waveform, niet op het beeld: waar spraak is wordt geknipt, ripple delete, klaar. De rough cut van een reel is secondenwerk als je het geluid volgt.
- J-cuts overal: de audio van het volgende shot start 3-4 frames vóór het beeld. Nooit een gat zonder spraak — het oor trekt de kijker over de knip heen.
- B-roll wordt op het gesproken woord gelegd: zeg je "duizend gedachten", dan zie je dat. Beeld bewijst de zin.
- Presets en assetpacks zijn geen luiheid maar consistentie: één tekststijl, één animatietaal (ease-out cubic, ~4 frames motion blur), en een riser vlak vóór het kernpunt. Captions kort (ca. 10 tekens per regel), midden in beeld.

Think Media (talking-head):
- De laatste take is bijna altijd de beste: skim de waveform, gooi alles vóór de laatste take weg, en verfijn daarna pas de naden.
- Vier manieren om een jump-cut te verbergen, in volgorde van voorkeur: b-roll eroverheen, crop-in/crop-out (midden in de zin croppen leest als één take), een morph/flow-overgang bij weinig beweging, en als basis: zelfde houding en stemvolume aanhouden zodat de naad klein blijft.

BRONNEN: Forbes-interview Hayden Hillier-Smith (2023) en zijn Edit Like an Artist-materiaal; talking-head/b-roll-praktijkgidsen (captions.ai, jryze); short-form retentie-editing (AIR Media-Tech, Schedulala); Ryan Herrick short-form/tekstanimatie-materiaal; caption-stijlonderzoek (OpusClip, VocalLab, Blitzcut, Hormozi-stijlgidsen); beat-sync/keyframe-praktijk (CapCut-gidsen, Motion Design School, Toolfarm). Plus de eigen tutorialvideo's van Hillier-Smith, Finzar, Ryan Herrick en Think Media (transcripten, aug 2026); Learn by Leo en Skai Generated leverden geen bruikbaar lesmateriaal op. Verzameld aug 2026.`;
