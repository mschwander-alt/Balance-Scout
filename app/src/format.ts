/** Rappen -> 1'234.56 (Schweizer Format) */
export function chf(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '–';
  const neg = cents < 0;
  const a = Math.abs(cents);
  const int = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${neg ? '-' : ''}${int}.${String(a % 100).padStart(2, '0')}`;
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)} %`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '–';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

export function shortUser(u: string): string {
  return u.includes('@') ? u.split('@')[0]! : u;
}

/** Betrag aus einer Eingabe in Rappen: 1'234.50 · 1234,5 · -500 · (leer → null) */
export function parseChf(input: string): number | null {
  const s = input.trim().replace(/['’\s]/g, '').replace(',', '.');
  if (!s) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
