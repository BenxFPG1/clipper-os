/**
 * Is deze kaarttekst een aanwijzing voor de editor in plaats van tekst voor
 * de kijker? ("Hier opende deze clip mee", "cold open", "2 minuten later",
 * "zie boven".) Zulke tekst hoort als marker in het montageplan, niet in
 * beeld: de kijker weet niet dat er een clip, een montage of een editor is.
 * Geeft de gevonden aanwijzing terug, of null.
 */
export function editorTekst(tekst: string | null | undefined): string | null {
  if (!tekst) return null;
  const t = tekst.toLowerCase();
  const patronen: [RegExp, string][] = [
    [/\b(deze|dit|vorige|volgende)\s+(clip|montage|shot|scène|scene|edit|cut)\b|\bde\s+(clip|montage)\b/, 'verwijst naar de clip/montage'],
    [/\bhier\s+(opende|begon|start|eindigde|sloot)\b/, 'verwijst naar de opbouw van de clip'],
    [/\bcold\s*open\b|\bflash\s*back\b|\bflashforward\b|\bteaser?\b|\bb-?roll\b|\bjump\s*cut\b/, 'montageterm'],
    [/\bzie\s+(boven|eerder|onder|hierboven)\b|\bzoals\s+(eerder|gezegd|hierboven)\b/, 'verwijzing binnen de montage'],
    [/\btijdsprong\b|\b\d+([.,]\d+)?\s*(seconde|seconden|minuut|minuten|uur)\s+(later|eerder|daarna|terug)\b|\b(minuut|minuten|uur)\s+later\b/, 'tijdsprong'],
    [/\beditor\b|\bde\s+kijker\b|\bvoor\s+de\s+kijker\b/, 'spreekt over editor/kijker'],
    [/^(knip|zet|toon|laat)\b.*\b(kaart|overlay|beeld|shot)\b/, 'montage-instructie'],
  ];
  for (const [re, waarom] of patronen) if (re.test(t)) return waarom;
  return null;
}
