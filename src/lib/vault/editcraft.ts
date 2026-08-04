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
- Gebruik de huisstijl van de campagne (kleur, toon) in kaarten en accenten, niet de standaardsjabloon van de tool.`;
