/**
 * Betragsverarbeitung. Alle Beträge werden intern als ganzzahlige Rappen/Cents
 * (number, sicher bis ±9e13 CHF) geführt, um Gleitkommafehler zu vermeiden.
 */

export type Cents = number;

export interface ParsedAmount {
  cents: Cents;
  /** Anzahl Nachkommastellen im Original (0 = ganzzahlig dargestellt) */
  decimals: number;
  /** true, wenn das Vorzeichen explizit erkennbar war (-, Klammern, nachgestelltes Minus) */
  explicitSign: boolean;
  raw: string;
}

const THOUSANDS_CHARS = /['’`´\u00A0\u202F\u2009 ]/g;

/**
 * Parst einen Betrag in CH-, DE- oder US-Schreibweise.
 * Unterstützt: 1'234.50 · 1’234.50 · 1 234,50 · 1.234,50 · 1,234.50 · -1234.5 ·
 * (1'234.50) · 1'234.50- · CHF 1'234.50 · 1'234.– · 1234
 * Gibt null zurück, wenn der Text kein eindeutiger Betrag ist.
 */
export function parseAmount(input: unknown): ParsedAmount | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return { cents: Math.round(input * 100), decimals: decimalsOfNumber(input), explicitSign: input < 0, raw: String(input) };
  }
  let s = String(input).trim();
  if (!s) return null;
  const raw = s;

  s = s.replace(/^(CHF|EUR|USD|GBP|Fr\.?|SFr\.?|€|\$)\s*/i, '').replace(/\s*(CHF|EUR|USD|GBP|Fr\.?|€|\$)$/i, '').trim();
  s = s.replace(/[−–—]/g, '-');
  // "1'234.–" bzw. "1'234.-" = ganze Franken (nicht als Minus deuten)
  s = s.replace(/[.,]-$/, '');

  let negative = false;
  let explicitSign = false;
  if (/^\(.*\)$/.test(s)) { negative = true; explicitSign = true; s = s.slice(1, -1).trim(); }
  if (s.startsWith('-')) { negative = !negative; explicitSign = true; s = s.slice(1).trim(); }
  else if (s.startsWith('+')) { explicitSign = true; s = s.slice(1).trim(); }
  if (s.endsWith('-')) { negative = !negative; explicitSign = true; s = s.slice(0, -1).trim(); }

  // Apostroph/Leerzeichen als Tausendertrenner: Gruppierung muss stimmen (3er-Gruppen)
  if (/['’`´\u00A0\u202F\u2009 ]/.test(s)) {
    const intPortion = s.replace(/[.,]\d{1,4}$/, '');
    if (!/^\d{1,3}(?:['’`´\u00A0\u202F\u2009 ]\d{3})+$/.test(intPortion)) return null;
  }
  s = s.replace(THOUSANDS_CHARS, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart: string;
  let fracPart = '';

  if (lastDot >= 0 && lastComma >= 0) {
    // Beide vorhanden: das letzte Zeichen ist der Dezimaltrenner
    const decSep = lastDot > lastComma ? '.' : ',';
    const thouSep = decSep === '.' ? ',' : '.';
    const [i, f, ...rest] = s.split(decSep);
    if (rest.length || f === undefined || i === undefined) return null;
    if (!validGrouping(i, thouSep)) return null;
    intPart = i.split(thouSep).join('');
    fracPart = f;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    if (parts.length > 2) {
      // Mehrfach vorkommend => Tausendertrenner
      if (!validGrouping(s, sep)) return null;
      intPart = parts.join('');
    } else {
      const [i = '', f = ''] = parts;
      // Genau 3 Nachkommastellen bei Komma => mehrdeutig (1,234). Bei Komma als
      // Tausender (US) interpretieren, beim Punkt als Tausender (DE).
      if (f.length === 3 && i.length >= 1 && i.length <= 3 && i !== '0') {
        intPart = i + f;
      } else {
        intPart = i || '0';
        fracPart = f;
      }
    }
  } else {
    intPart = s;
  }

  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d+$/.test(fracPart))) return null;
  if (fracPart.length > 4) return null;

  const frac2 = (fracPart + '00').slice(0, 2);
  const roundUp = fracPart.length > 2 && Number(fracPart[2]) >= 5 ? 1 : 0;
  let cents = Number(intPart) * 100 + Number(frac2) + roundUp;
  if (!Number.isSafeInteger(cents)) return null;
  if (negative) cents = -cents;
  return { cents, decimals: fracPart.length, explicitSign, raw };
}

function validGrouping(s: string, sep: string): boolean {
  if (!s.includes(sep)) return true;
  const groups = s.split(sep);
  const [first, ...rest] = groups;
  if (!first || first.length > 3) return false;
  return rest.every(g => g.length === 3);
}

function decimalsOfNumber(n: number): number {
  const s = String(n);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function centsToNumber(c: Cents): number {
  return c / 100;
}

/** Formatiert Rappen im Schweizer Format: -1'234'567.89 */
export function formatChf(c: Cents): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const int = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const frac = (abs % 100).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${int}.${frac}`;
}
