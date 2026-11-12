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
  { code: 'A16', name: 'IC-Forderungen (Konzern, Beteiligte, Nahestehende)', category: 'aktiven', subcategory: 'Umlaufvermögen', prefixes: [], order: 16 },
  { code: 'A20', name: 'Finanzanlagen', category: 'aktiven', subcategory: 'Anlagevermögen', prefixes: ['14'], order: 20 },
  { code: 'A25', name: 'Beteiligungen', category: 'aktiven', subcategory: 'Anlagevermögen', prefixes: ['148', '149'], order: 20.5 },
  { code: 'A21', name: 'Mobile Sachanlagen', category: 'aktiven', subcategory: 'Anlagevermögen', prefixes: ['15'], order: 21 },
  { code: 'A22', name: 'Immobile Sachanlagen', category: 'aktiven', subcategory: 'Anlagevermögen', prefixes: ['16'], order: 22 },
  { code: 'A23', name: 'Immaterielle Werte', category: 'aktiven', subcategory: 'Anlagevermögen', prefixes: ['17'], order: 23 },
  { code: 'A24', name: 'Nicht einbezahltes Grund-, Gesellschafter- oder Stiftungskapital', category: 'aktiven', subcategory: 'Anlagevermögen', prefixes: ['18'], order: 24 },
  { code: 'P10', name: 'Verbindlichkeiten aus Lieferungen und Leistungen', category: 'passiven', subcategory: 'Kurzfristiges Fremdkapital', prefixes: ['200'], order: 30 },
  { code: 'P11', name: 'Kurzfristige verzinsliche Verbindlichkeiten', category: 'passiven', subcategory: 'Kurzfristiges Fremdkapital', prefixes: ['210'], order: 31 },
  { code: 'P12', name: 'Übrige kurzfristige Verbindlichkeiten', category: 'passiven', subcategory: 'Kurzfristiges Fremdkapital', prefixes: ['220', '221', '222', '223', '224', '225', '226', '227', '228', '229'], order: 32 },
  { code: 'P14', name: 'IC-Verbindlichkeiten (Konzern, Beteiligte, Nahestehende)', category: 'passiven', subcategory: 'Fremdkapital', prefixes: [], order: 32.5 },
  { code: 'P15', name: 'Steuerrückstellungen / geschuldete direkte Steuern', category: 'passiven', subcategory: 'Fremdkapital', prefixes: [], order: 32.7 },
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
  { code: 'E89', name: 'Direkte Steuern (Steueraufwand)', category: 'aufwand', subcategory: 'Erfolgsrechnung', prefixes: ['89'], order: 65.5 },
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

/**
 * Zuordnung über die Kontobezeichnung, wenn die Nummer nicht zum KMU-Kontenrahmen passt
 * (eigene Kontenpläne, Fremdsysteme). Reihenfolge = Vorrang. Ergebnis immer als "aus Bezeichnung – prüfen" kennzeichnen.
 */
const NAME_RULES: [RegExp, string][] = [
  [/kontokorrentkredit|bankkredit|kontokorrent.*(schuld|kredit)/i, 'P11'],
  [/hypothek|darlehen.*(lang|bank)|langfristig.*(darlehen|verbindl)/i, 'P20'],
  [/kreditor|verbindlichkeit(en)? aus (lieferung|l\+l|lul)/i, 'P10'],
  [/delkredere|debitor|forderung(en)? aus (lieferung|l\+l|lul)/i, 'A12'],
  [/passive rechnungsabgrenz|transitorische passiv|\bpra\b|abgegrenzte? aufw/i, 'P13'],
  [/aktive rechnungsabgrenz|transitorische aktiv|\bara\b/i, 'A15'],
  [/rückstellung|rueckstellung/i, 'P22'],
  [/aktienkapital|stammkapital|grundkapital|gesellschaftskapital|genossenschaftskapital/i, 'P30'],
  [/reserve|gewinnvortrag|verlustvortrag|bilanzgewinn|bilanzverlust|jahresgewinn|jahresverlust/i, 'P31'],
  [/geschuldete mwst|mwst.?schuld|umsatzsteuer|sozialversicherung|\bahv\b|\bbvg\b|quellensteuer|steuerrückstell/i, 'P12'],
  [/vorsteuer|verrechnungssteuer|forderung|guthaben|vorschuss|anzahlung an/i, 'A13'],
  [/darlehen|aktionärsdarlehen|gesellschafterdarlehen/i, 'P21'],
  [/\bkasse\b|\bbank\b|postfinance|postkonto|\bpost\b|kontokorrent|sparkonto|festgeld|liquidit/i, 'A10'],
  [/wertschrift|wertpapier/i, 'A11'],
  [/vorr(a|ä)t|warenlager|\blager\b|angefangene arbeit|halbfabrikat|rohmaterial/i, 'A14'],
  [/beteiligung|finanzanlage/i, 'A20'],
  [/mobiliar|maschine|fahrzeug|einrichtung|\bedv\b|informatik|hardware|werkzeug|apparat|büromaschine/i, 'A21'],
  [/liegenschaft|gebäude|grundstück|immobil/i, 'A22'],
  [/patent|lizenz|goodwill|software|marke/i, 'A23'],
  [/umsatz|erlös|erloes|ertrag aus (lieferung|leistung)|dienstleistungsertrag|honorarertrag|warenverkauf|verkaufsertrag/i, 'E30'],
  [/warenaufwand|materialaufwand|wareneinkauf|einkauf|fremdleistung|handelsware/i, 'E40'],
  [/lohn|löhne|loehne|gehalt|salär|sozialleistung|personalaufwand|sozialversicherungsaufwand/i, 'E50'],
  [/ausserordentlich|betriebsfremd|periodenfremd|direkte steuer|ertragssteuer|kapitalsteuer|steueraufwand/i, 'E80'],
  [/miete|raumaufwand|unterhalt|reparatur|versicherung|energie|verwaltung|werbung|abschreibung|zinsaufwand|zinsertrag|bankspesen|büro|telefon|porti|fahrzeugaufwand|beratung/i, 'E60'],
];

export interface Classification {
  group: AccountGroup;
  source: 'nummer' | 'bezeichnung';
}

/** Zuerst über die Kontonummer (KMU-Kontenrahmen), sonst über die Bezeichnung. */
/**
 * Bezeichnungen, die Vorrang vor der Nummer haben, weil der KMU-Kontenrahmen sie nicht als eigene Gruppe führt
 * (Register G = IC, S = Steuern).
 */
const OVERRIDE_RULES: [RegExp, { aktiven?: string; passiven?: string; any?: string }][] = [
  [/konzern|\bic\b|intercompany|gruppengesellschaft|nahestehend|beteiligte\b|gegenüber beteiligungen|aktionär|aktionaer|gesellschafter(?!kapital)/i, { aktiven: 'A16', passiven: 'P14' }],
  [/steuerrückst|steuerrueckst|rückstellung(en)? (für )?(direkte )?steuern|geschuldete (direkte )?steuern|direkte steuern|ertragssteuer|kapitalsteuer|gewinnsteuer/i, { passiven: 'P15', any: 'E89' }],
];

export function classify(accountNumber: string, accountName: string, opts: { digits?: number } = {}): Classification | null {
  const digits = accountNumber.replace(/\D/g, '');
  const base = digits.length >= (opts.digits ?? 4) ? classifyAccount(accountNumber) : null;
  for (const [rx, t] of OVERRIDE_RULES) {
    if (!rx.test(accountName)) continue;
    const cat = base?.category;
    const code = cat === 'aktiven' ? t.aktiven : cat === 'passiven' ? t.passiven : (cat === 'aufwand' || cat === 'ertrag') ? t.any : (t.any ?? t.passiven);
    const g = code ? KMU_GROUPS.find(x => x.code === code) : undefined;
    if (g) return { group: g, source: base ? 'nummer' : 'bezeichnung' };
  }
  // Nummer nur verwenden, wenn sie wie ein KMU-Konto aussieht (4-stellig oder länger, z. B. 102000)
  const byNumber = digits.length >= (opts.digits ?? 4) ? classifyAccount(accountNumber) : null;
  if (byNumber) return { group: byNumber, source: 'nummer' };
  for (const [rx, code] of NAME_RULES) {
    if (rx.test(accountName)) {
      const g = KMU_GROUPS.find(x => x.code === code);
      if (g) return { group: g, source: 'bezeichnung' };
    }
  }
  return null;
}

/** Pseudo-Gruppe für Belege ohne Konto (HR-Auszug, Statuten, Protokolle) */
export const GENERAL_GROUP = 'ALLG';
export const GENERAL_ACCOUNT = '@allgemein';

/** Standard-Register der Revisionsstelle (änderbar in der App unter „Register …“) */
export function defaultGroupLetters(): Record<string, string> {
  return {
    ALLG: 'A', // Allgemeine Prüfungen
    A10: 'B', // Flüssige Mittel
    A11: 'D', // Wertschriften des Umlaufvermögens
    A12: 'E', // Forderungen aus L+L
    A13: 'F', // Sonstige Forderungen
    A16: 'G', P14: 'G', // IC-Forderungen / IC-Verbindlichkeiten
    A14: 'I', // Vorräte (laufende Arbeiten bei Bedarf auf F ändern)
    A25: 'N', // Beteiligungen
    P13: 'Q', // Passive Rechnungsabgrenzungen
    P10: 'R', // Verbindlichkeiten aus L+L
    P15: 'S', E89: 'S', // Steuerrückstellungen / Steueraufwand
    P20: 'T', P21: 'T', // Langfristige Verbindlichkeiten
    P11: 'U', P12: 'U', // Sonstige (kurzfristige) Verbindlichkeiten
    P22: 'W', // Rückstellungen
  };
}

// ---------------------------------------------------------------- Gruppe vom Prüfer ändern
/** Automatisch erkannte Gruppe eines Kontos (vor dem Verschieben durch den Prüfer) */
export interface AutoGroup { code: string | null; name: string | null; category: Category; source: 'nummer' | 'bezeichnung' | null }
/** Konto (Nummer) → Zielgruppe (Code, z. B. "P13"), vom Prüfer verschoben */
export type GroupOverrides = Record<string, { groupCode: string; at?: string; visum?: string }>;

type Groupable = { accountNumber: string; groupCode: string | null; groupName: string | null; category: Category; groupSource: AutoGroup['source'] | 'manuell'; autoGroup?: AutoGroup };

/**
 * Wendet die vom Prüfer verschobenen Gruppen an (Kopie). Die automatische Gruppe bleibt in `autoGroup` erhalten;
 * Konten ohne (oder mit aufgehobener) Verschiebung erhalten wieder die automatische Gruppe. Unbekannte Gruppen werden ignoriert.
 */
export function applyGroupOverrides<T extends Groupable>(accounts: T[], overrides: GroupOverrides | undefined): T[] {
  return accounts.map(a => {
    const auto: AutoGroup = a.autoGroup ?? { code: a.groupCode, name: a.groupName, category: a.category, source: a.groupSource === 'manuell' ? null : a.groupSource };
    const g = overrides?.[a.accountNumber] ? KMU_GROUPS.find(x => x.code === overrides[a.accountNumber]!.groupCode) : undefined;
    if (g && g.code !== auto.code) return { ...a, groupCode: g.code, groupName: g.name, category: g.category, groupSource: 'manuell', autoGroup: auto };
    if (!a.autoGroup) return a;
    const { autoGroup: _a, ...rest } = a;
    return { ...rest, groupCode: auto.code, groupName: auto.name, category: auto.category, groupSource: auto.source } as T;
  });
}
