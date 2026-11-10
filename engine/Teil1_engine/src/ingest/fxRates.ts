/**
 * ESTV-Kursliste (Devisen/Banknoten per 31.12.) lesen: je Währung Kurs in CHF für 1 Einheit (Devisenkurs).
 * Beispielzeile: "Europäische Währungsunion EUR Euro 1 2 951 012 0.930500 0.910600"
 *                "Japan JPY Yen 100 2 951 035 0.505400 0.461400"  (Kurs für 100 Einheiten)
 */
import type { EvidenceLine } from './readDocument.js';

export interface FxRateList {
  /** Stichtag der Liste (ISO), z. B. 2025-12-31 */
  date: string | null;
  /** CHF je 1 Einheit Fremdwährung (Devisenkurs "freie Devise") */
  rates: Record<string, number>;
  source: string;
}

export function parseEstvRates(lines: EvidenceLine[], source = 'ESTV Kursliste'): FxRateList {
  let date: string | null = null;
  const rates: Record<string, number> = {};
  for (const l of lines) {
    const t = l.text.replace(/\s+/g, ' ').trim();
    if (!date) {
      const d = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(t) ?? (/(devisen|kursliste|cours|banknoten)/i.test(t) ? /(\d{2})\.(\d{2})\.(\d{4})/.exec(t) : null);
      if (d) date = `${d[3]}-${d[2]}-${d[1]}`;
    }
    // Code, Bezeichnung, Einheit (1/100/1000), Valorennummer (mit Leerzeichen), Devisenkurs, Banknotenkurs oder "-"
    const m = /\b([A-Z]{3})\s+(?![A-Z]{3}\b)[^\d]*?\s(1|10|100|1000|10000)\s+\d{1,3}(?: \d{3})+\s+(\d+\.\d{2,8})(?:\s+(?:\d+\.\d+|-))?\s*$/.exec(t);
    if (m && m[1] !== 'CHF') {
      const unit = Number(m[2]);
      const rate = Number(m[3]) / unit;
      if (Number.isFinite(rate) && rate > 0 && !(m[1]! in rates)) rates[m[1]!] = Math.round(rate * 1e8) / 1e8;
    }
  }
  return { date, rates, source };
}

/** Sieht das Dokument wie eine ESTV-Kursliste aus? */
export const looksLikeRateList = (lines: EvidenceLine[]) =>
  lines.slice(0, 20).some(l => /devisen\s*-\s*banknoten|devises\s*-\s*billets|kursliste/i.test(l.text)) && lines.filter(l => /\b(EUR|USD|GBP)\b/.test(l.text)).length >= 2;
