import type { Cents } from '../domain/amount.js';

/** DB numeric(18,2) als String -> Rappen (ohne Gleitkomma) */
export function numericToCents(v: string | null): Cents | null {
  if (v === null) return null;
  const neg = v.startsWith('-');
  const [i = '0', f = ''] = (neg ? v.slice(1) : v).split('.');
  const c = Number(i) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -c : c;
}

export function centsToNumeric(c: Cents | null): string | null {
  if (c === null) return null;
  const neg = c < 0;
  const a = Math.abs(c);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
