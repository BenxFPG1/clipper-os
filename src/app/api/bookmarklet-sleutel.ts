import { optionalEnv } from '@/lib/env';

/**
 * De sleutel waarmee de bookmarklet (op cliparmy.nl) bij ons binnenkomt.
 *
 * Bewust een eigen variabele: de sleutel staat letterlijk in de bladwijzer
 * van de browser, en de twee routes die hem accepteren staan buiten de
 * Google-poort. Hem los kunnen roteren zonder aan iets anders te zitten is
 * dan het minste. Zolang CLIPPER_BOOKMARKLET_KEY niet gezet is, blijft het
 * oude APP_PASSWORD werken — met een waarschuwing, zodat het niet vergeten
 * wordt.
 */
let gewaarschuwd = false;

export function bookmarkletSleutelKlopt(sleutel: string | null): boolean {
  let verwacht = optionalEnv('CLIPPER_BOOKMARKLET_KEY');
  if (!verwacht) {
    verwacht = optionalEnv('APP_PASSWORD');
    if (verwacht && !gewaarschuwd) {
      gewaarschuwd = true;
      console.warn(
        'CLIPPER_BOOKMARKLET_KEY ontbreekt; de bookmarklet gebruikt nog APP_PASSWORD. Zet een eigen sleutel.',
      );
    }
  }
  // Zonder sleutel in de omgeving is de route dicht, niet open.
  if (!verwacht || !sleutel) return false;
  return sleutel === verwacht;
}
