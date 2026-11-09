import type { EvidenceDocument } from './readDocument.js';

const MONTHS: Record<string, number> = {
  januar: 1, jan: 1, februar: 2, feb: 2, märz: 3, maerz: 3, mär: 3, mrz: 3, april: 4, apr: 4, mai: 5, juni: 6, jun: 6,
  juli: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12,
};

export interface DateHit {
  iso: string;
  raw: string;
  page: number;
  lineNo: number;
  /** Datum steht neben "per", "Stichtag", "Stand", "Saldo" usw. */
  keyed: boolean;
}

const KEY_RX = /\b(per|stichtag|stand|saldo|kontostand|bestand|abschluss|bilanz|am)\b[^\d]{0,15}$/i;

/** Findet Datumsangaben in den üblichen CH/DE-Schreibweisen. */
export function findDates(doc: EvidenceDocument): DateHit[] {
  const out: DateHit[] = [];
  const rx = /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})\b|\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})\.\s?([A-Za-zäÄ]{3,9})\.?\s(\d{4})\b/g;
  for (const l of doc.lines) {
    for (const m of l.text.matchAll(rx)) {
      let d: number, mo: number, y: number;
      if (m[1]) {
        d = +m[1]; mo = +m[2]!; y = +m[3]!;
        if (y < 100) y += 2000;
      } else if (m[4]) {
        y = +m[4]; mo = +m[5]!; d = +m[6]!;
      } else {
        d = +m[7]!; mo = MONTHS[m[8]!.toLowerCase()] ?? 0; y = +m[9]!;
      }
      if (!mo || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) continue;
      const before = l.text.slice(0, m.index);
      out.push({ iso: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, raw: m[0], page: l.page, lineNo: l.lineNo, keyed: KEY_RX.test(before) });
    }
  }
  return out;
}

/**
 * Stichtag des Belegs: enthält der Beleg den Bilanzstichtag -> dieser.
 * Sonst das erste Datum mit Schlüsselwort ("per 30.11.2025", "Stand 30.11.2025").
 * Sonst unbekannt.
 */
export function detectBalanceDate(doc: EvidenceDocument, closingDate: string | null): { date: string | null; evidence: string | null } {
  const dates = findDates(doc);
  if (closingDate) {
    const hit = dates.find(d => d.iso === closingDate);
    if (hit) return { date: closingDate, evidence: `S. ${hit.page}: ${hit.raw}` };
  }
  const keyed = dates.find(d => d.keyed);
  if (keyed) return { date: keyed.iso, evidence: `S. ${keyed.page}: ${keyed.raw}` };
  return { date: null, evidence: null };
}

const TYPES: [string, RegExp][] = [
  ['Saldobestätigung', /saldobest[äa]tigung|saldenbest[äa]tigung|best[äa]tigen.*saldo|balance confirmation/i],
  ['Kontoauszug', /kontoauszug|kontokorrent|auszug.*konto|account statement|kontostand|schlusssaldo|iban/i],
  ['Debitorenliste', /debitoren|offene posten.*kund|kundenforderung/i],
  ['Kreditorenliste', /kreditoren|offene posten.*lieferant|lieferantenverbindlich/i],
  ['Darlehensvertrag', /darlehen|kreditvertrag|hypothek/i],
  ['Steuerdokument', /steuerverwaltung|steuerrechnung|mwst|mehrwertsteuer|verrechnungssteuer|eidg\. steuer/i],
  ['Inventar', /inventar|lagerbestand|kassensturz|kassenprotokoll|kassabestand/i],
  ['Wertschriften', /depotauszug|wertschriften|depot/i],
  ['Rechnung', /rechnung|faktura|invoice/i],
];

export function guessDocType(doc: EvidenceDocument): string {
  const head = doc.filename + ' ' + doc.lines.slice(0, 60).map(l => l.text).join(' ');
  for (const [name, rx] of TYPES) if (rx.test(head)) return name;
  return doc.lines.length ? 'Sonstiges' : '–';
}
