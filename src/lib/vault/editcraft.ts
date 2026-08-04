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

BRONNEN: Forbes-interview Hayden Hillier-Smith (2023) en zijn Edit Like an Artist-materiaal; talking-head/b-roll-praktijkgidsen (captions.ai, jryze); short-form retentie-editing (AIR Media-Tech, Schedulala); Ryan Herrick short-form/tekstanimatie-materiaal. Verzameld aug 2026.`;
