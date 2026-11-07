import { parseAmount, type Cents } from '../amount.js';
import type { EvidenceLine } from '../../ingest/readDocument.js';

export interface AmountCandidate {
  documentId: string;
  page: number;
  lineNo: number;
  line: string;
  raw: string;
  cents: Cents;
  decimals: number;
  explicitSign: boolean;
  /** Herkunft der Zeile (undefined = Textebene des Dokuments) */
  source?: string;
  /** Lage der Zeile auf der Seite (0–1), falls bekannt */
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  /** Kontext-Hinweise aus derselben Zeile */
  context: {
    balanceKeyword: boolean; // Saldo, Total, Schlussbestand, Kontostand ...
    sollHaben: 'soll' | 'haben' | null;
    currency: string | null;
  };
}

// Betrags-Token: optionales Vorzeichen/Klammer, Ziffern mit Tausendertrennern, optionale Dezimalstellen, optional nachgestelltes Minus
const AMOUNT_RX = /(?<![\w.,'’])\(?[-−–+]?\s?\d{1,3}(?:(?:['’\u00A0\u202F ]\d{3})+|(?:[.,]\d{3})+)?(?:[.,]\d{1,2}|[.,][-–])?\)?-?(?![\w'’]|[.,]\d)|(?<![\w.,'’])[-−–]?\d{4,}(?:[.,]\d{1,2})?-?(?![\w'’]|[.,]\d)/g;

const DATE_RX = /\b\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})\b/g;
const IBAN_RX = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g;
const TIME_RX = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const PERCENT_RX = /\d+(?:[.,]\d+)?\s?%/g;
const BALANCE_KW = /\b(saldo|schlusssaldo|endsaldo|kontostand|total|bestand|schlussbestand|guthaben|balance|closing|stand per|saldo per)\b/i;
const CURRENCY_RX = /\b(CHF|EUR|USD|GBP)\b/;

/**
 * Findet Beträge in Belegzeilen. Datumswerte, IBAN, Uhrzeiten, Prozente und
 * reine Jahreszahlen werden vorher ausgeblendet, um Zufallstreffer zu vermeiden.
 */
export function extractAmounts(documentId: string, lines: EvidenceLine[]): AmountCandidate[] {
  const out: AmountCandidate[] = [];
  for (const l of lines) {
    const masked = l.text
      .replace(IBAN_RX, m => ' '.repeat(m.length))
      .replace(DATE_RX, m => ' '.repeat(m.length))
      .replace(TIME_RX, m => ' '.repeat(m.length))
      .replace(PERCENT_RX, m => ' '.repeat(m.length));
    const context = {
      balanceKeyword: BALANCE_KW.test(l.text),
      sollHaben: /\bhaben\b/i.test(l.text) ? ('haben' as const) : /\bsoll\b/i.test(l.text) ? ('soll' as const) : null,
      currency: CURRENCY_RX.exec(l.text)?.[1] ?? null,
    };
    for (const m of masked.matchAll(AMOUNT_RX)) {
      const raw = m[0].trim();
      const parsed = parseAmount(raw);
      if (!parsed) continue;
      // Reine Jahreszahl ohne Dezimalen (1990–2099) ignorieren
      if (parsed.decimals === 0 && /^(19|20)\d{2}$/.test(raw)) continue;
      if (parsed.cents === 0) continue;
      out.push({ documentId, page: l.page, lineNo: l.lineNo, line: l.text, raw, cents: parsed.cents, decimals: parsed.decimals, explicitSign: parsed.explicitSign, source: l.source, bbox: l.bbox, context });
    }
  }
  return out;
}
