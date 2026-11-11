/**
 * Tekstregels voor kaarten, zonder afhankelijkheden. Bewust los van
 * tekstkaarten.ts: dat bestand tekent met @napi-rs/canvas (een native
 * module), en de planner — die ook in de webapp draait — mag die niet
 * meetrekken. Dat brak twee weken lang elke deploy.
 */

/** Een opdracht aan de kijker ("Let op wat hij straks bidt", "Onthoud deze zin") is geen tekst die iets toevoegt. */
export function isOpdracht(tekst: string | null | undefined): boolean {
  return /^(onthoud|let op|kijk|luister|wacht|blijf|hou vol|houd vol)\b/i.test((tekst ?? '').trim());
}
