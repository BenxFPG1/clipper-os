/**
 * Datum/tijd-weergave voor de UI. Vast op Nederlandse notatie en Nederlandse
 * tijd, óók server-side op Vercel (dat in UTC draait) — anders staat er op de
 * site een andere tijd dan op je klok.
 */
const fmt = new Intl.DateTimeFormat('nl-NL', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Amsterdam',
});

const fmtMetJaar = new Intl.DateTimeFormat('nl-NL', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Amsterdam',
});

export function datumTijd(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const zelfdeJaar = d.getFullYear() === new Date().getFullYear();
  return (zelfdeJaar ? fmt : fmtMetJaar).format(d);
}
