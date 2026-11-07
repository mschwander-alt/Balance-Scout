/**
 * Gruppierung nach Schweizer KMU-Kontenrahmen (Sterchi), Gliederung nach OR 959a/959b.
 * Massgebend ist die längste passende Präfix-Regel.
 */

export type Category = 'aktiven' | 'passiven' | 'aufwand' | 'ertrag' | 'abschluss' | 'unbekannt';

export interface AccountGroup {
  code: string;
  name: string;
  category: Category;
  subcategory: string;
  prefixes: string[];
  order: number;
}

export const KMU_GROUPS: AccountGroup[] = [
  { code: 'A10', name: 'Flüssige Mittel', category: 'aktiven', subcategory: 'Umlaufvermögen', prefixes: ['100', '101', '102', '103', '104', '105'], order: 10 },
  { code: 'A11', name: 'Kurzfristig gehaltene Aktiven mit Börsenkurs', category: 'aktiven', subcategory: 'Umlaufvermögen', prefixes: ['106', '107', '108', '109'], order: 11 },
  { code: 'A12', name: 'Forderungen aus Lieferungen und Leistungen', category: 'aktiven', subcategory: 'Umlaufvermögen', prefixes: ['110', '111', '112', '113'], order: 12 },
  { code: 'A13', name: 'Übrige kurzfristige Forderungen', category: 'aktiven', subcategory: 'Umlaufvermögen', prefixes: ['114', '115', '116', '117', '118', '119'], order: 13 },
  { code: 'A14', name: 'Vorräte und nicht fakturierte Dienstleistungen', category: 'aktiven', subcategory: 'Umlaufvermögen', prefixes: ['12'], order: 14 },
  { code: 'A15', name: 'Aktive Rechnungsabgrenzungen', category: 'aktiven', subcategory: 'Umlaufvermögen', prefixes: ['13'], order: 15 },
  { code: 'A20', name: 'Finanzanlagen', category: 'aktiven', subcategory: 'Anlagevermögen', prefixes: ['14'], order: 20 },
  { code: 'A21', name: 'Mobile Sachanlagen', category: 'aktiven', subcategory: 'Anlagevermögen', prefixes: ['15'], order: 21 },
  { code: 'A22', name: 'Immobile Sachanlagen', category: 'aktiven', subcategory: 'Anlagevermögen', prefixes: ['16'], order: 22 },
  { code: 'A23', name: 'Immaterielle Werte', category: 'aktiven', subcategory: 'Anlagevermögen', prefixes: ['17'], order: 23 },
  { code: 'A24', name: 'Nicht einbezahltes Grund-, Gesellschafter- oder Stiftungskapital', category: 'aktiven', subcategory: 'Anlagevermögen', prefixes: ['18'], order: 24 },
  { code: 'P10', name: 'Verbindlichkeiten aus Lieferungen und Leistungen', category: 'passiven', subcategory: 'Kurzfristiges Fremdkapital', prefixes: ['200'], order: 30 },
  { code: 'P11', name: 'Kurzfristige verzinsliche Verbindlichkeiten', category: 'passiven', subcategory: 'Kurzfristiges Fremdkapital', prefixes: ['210'], order: 31 },
  { code: 'P12', name: 'Übrige kurzfristige Verbindlichkeiten', category: 'passiven', subcategory: 'Kurzfristiges Fremdkapital', prefixes: ['220', '221', '222', '223', '224', '225', '226', '227', '228', '229'], order: 32 },
  { code: 'P13', name: 'Passive Rechnungsabgrenzungen und kurzfristige Rückstellungen', category: 'passiven', subcategory: 'Kurzfristiges Fremdkapital', prefixes: ['23'], order: 33 },
  { code: 'P20', name: 'Langfristige verzinsliche Verbindlichkeiten', category: 'passiven', subcategory: 'Langfristiges Fremdkapital', prefixes: ['24'], order: 40 },
  { code: 'P21', name: 'Übrige langfristige Verbindlichkeiten', category: 'passiven', subcategory: 'Langfristiges Fremdkapital', prefixes: ['25'], order: 41 },
  { code: 'P22', name: 'Rückstellungen sowie vom Gesetz vorgesehene ähnliche Positionen', category: 'passiven', subcategory: 'Langfristiges Fremdkapital', prefixes: ['26'], order: 42 },
  { code: 'P30', name: 'Grund-, Gesellschafter- oder Stiftungskapital', category: 'passiven', subcategory: 'Eigenkapital', prefixes: ['280'], order: 50 },
  { code: 'P31', name: 'Reserven und Gewinn-/Verlustvortrag', category: 'passiven', subcategory: 'Eigenkapital', prefixes: ['28', '29'], order: 51 },
  { code: 'E30', name: 'Betrieblicher Ertrag aus Lieferungen und Leistungen', category: 'ertrag', subcategory: 'Erfolgsrechnung', prefixes: ['3'], order: 60 },
  { code: 'E40', name: 'Aufwand für Material, Handelswaren, Dienstleistungen und Energie', category: 'aufwand', subcategory: 'Erfolgsrechnung', prefixes: ['4'], order: 61 },
  { code: 'E50', name: 'Personalaufwand', category: 'aufwand', subcategory: 'Erfolgsrechnung', prefixes: ['5'], order: 62 },
  { code: 'E60', name: 'Übriger betrieblicher Aufwand, Abschreibungen, Finanzergebnis', category: 'aufwand', subcategory: 'Erfolgsrechnung', prefixes: ['6'], order: 63 },
  { code: 'E70', name: 'Betrieblicher Nebenerfolg', category: 'ertrag', subcategory: 'Erfolgsrechnung', prefixes: ['7'], order: 64 },
  { code: 'E80', name: 'Betriebsfremder, ausserordentlicher, einmaliger oder periodenfremder Erfolg; Steuern', category: 'aufwand', subcategory: 'Erfolgsrechnung', prefixes: ['8'], order: 65 },
  { code: 'X90', name: 'Abschlusskonten', category: 'abschluss', subcategory: 'Abschluss', prefixes: ['9'], order: 90 },
];

export function classifyAccount(accountNumber: string): AccountGroup | null {
  const digits = accountNumber.replace(/\D/g, '');
  if (!digits) return null;
  let best: AccountGroup | null = null;
  let bestLen = 0;
  for (const g of KMU_GROUPS) {
    for (const p of g.prefixes) {
      if (digits.startsWith(p) && p.length > bestLen) {
        best = g;
        bestLen = p.length;
      }
    }
  }
  return best;
}

export function isBalanceSheet(c: Category): boolean {
  return c === 'aktiven' || c === 'passiven';
}
