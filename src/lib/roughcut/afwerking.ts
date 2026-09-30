import { instelling, type InstellingNaam } from './instellingen';
import type { Huisstijl } from './tekstkaarten';

export type AfwerkingOnderdeel = 'easing' | 'hit' | 'kleur' | 'stem' | 'sfx' | 'muziek' | 'jl';

const INSTELLING: Record<AfwerkingOnderdeel, InstellingNaam> = {
  easing: 'AFWERKING_EASING',
  hit: 'AFWERKING_HIT',
  kleur: 'AFWERKING_KLEUR',
  stem: 'AFWERKING_STEM',
  sfx: 'AFWERKING_SFX',
  muziek: 'AFWERKING_MUZIEK',
  jl: 'AFWERKING_JL',
};

/**
 * Staat een afwerkingsonderdeel aan? Uit als de instelling 0 is
 * (MONTAGE_AFWERKING_<X>=0) of als de campagne het in haar huisstijl uitzet.
 * Zo is elk onderdeel afzonderlijk uit te schakelen als het bij een merk
 * niet past, zonder code te wijzigen.
 */
export function afwerkingAan(onderdeel: AfwerkingOnderdeel, stijl?: Huisstijl | null): boolean {
  if (instelling(INSTELLING[onderdeel]) === 0) return false;
  return stijl?.afwerking?.[onderdeel] !== false;
}

/** Welke onderdelen aan staan, voor de log. */
export function afwerkingOverzicht(stijl?: Huisstijl | null): string {
  return (Object.keys(INSTELLING) as AfwerkingOnderdeel[]).map((o) => `${o} ${afwerkingAan(o, stijl) ? 'aan' : 'uit'}`).join(', ');
}
