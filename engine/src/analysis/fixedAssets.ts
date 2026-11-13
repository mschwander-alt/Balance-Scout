/**
 * Vertiefte Prüfung Sachanlagen: Anlagespiegel aus den Kontoblättern und Analyse der Abschreibungen
 * gegenüber den ESTV-Normalsätzen (Merkblatt A 1995, degressiv vom Buchwert; linear = halber Satz).
 */
import type { Ledger, LedgerAccount, LedgerPosting } from '../ingest/ledger.js';

export type Cents = number;
export type MoveClass = 'zugang' | 'abgang' | 'abschreibung' | 'umbuchung';

/** ESTV-Normalsätze (Merkblatt A 1995), Prozent vom Buchwert pro Jahr */
export const ESTV_CATEGORIES: { key: string; label: string; rate: number; rx: RegExp }[] = [
  { key: 'edv', label: 'Datenverarbeitung (Hard- und Software)', rate: 40, rx: /\b(edv|informatik|hardware|software|computer|server|it-?anlage)/i },
  { key: 'bueromaschinen', label: 'Büromaschinen', rate: 40, rx: /büromaschin|bueromaschin|kopierer|drucker/i },
  { key: 'fahrzeuge', label: 'Motorfahrzeuge aller Art', rate: 40, rx: /fahrzeug|fuhrpark|\bauto|\bpw\b|lkw|lieferwagen|stapler|traktor|bagger/i },
  { key: 'werkzeuge', label: 'Werkzeuge', rate: 45, rx: /werkzeug/i },
  { key: 'immateriell', label: 'Immaterielle Werte (Patente, Lizenzen, Goodwill)', rate: 40, rx: /patent|lizenz|goodwill|marke|konzession|nutzungsrecht|immateriell/i },
  { key: 'anhaenger', label: 'Transportmittel ohne Motor (Anhänger)', rate: 30, rx: /anhänger|anhaenger/i },
  { key: 'maschinen_schwer', label: 'Maschinen im Schichtbetrieb / Baumaschinen', rate: 40, rx: /baumaschin|strassenbau|schichtbetrieb/i },
  { key: 'maschinen', label: 'Apparate und Maschinen zu Produktionszwecken', rate: 30, rx: /maschin|apparat|laborger|anlage(n)?\b(?!.*gebäude)|produktionsanlag/i },
  { key: 'mobiliar', label: 'Geschäftsmobiliar, Werkstatt- und Lagereinrichtungen', rate: 25, rx: /mobiliar|möbel|einrichtung|installation|mietmaterial|baracke/i },
  { key: 'fabrik', label: 'Fabrik-, Lager- und Werkstattgebäude (Gebäude allein)', rate: 8, rx: /fabrik|lagergebäude|lagerhalle|werkstatt|betriebsgebäude|produktionsgebäude|laborgebäude|gewerbe/i },
  { key: 'hotel', label: 'Gebäude Gastgewerbe/Hotellerie (Gebäude allein)', rate: 6, rx: /hotel|restaurant|gastgewerb/i },
  { key: 'geschaeft', label: 'Geschäftshäuser, Büro- und Bankgebäude (Gebäude allein)', rate: 4, rx: /geschäftshaus|bürogebäude|buerogebäude|geschäftsliegenschaft/i },
  { key: 'wohn', label: 'Wohnhäuser (Gebäude allein)', rate: 2, rx: /wohnhaus|wohnliegenschaft|personalhaus/i },
  { key: 'land', label: 'Grundstücke / Land (keine Abschreibung)', rate: 0, rx: /grundstück|\bland\b|boden|parzelle/i },
  { key: 'gebaeude', label: 'Gebäude (Art prüfen) – Geschäftshaus 4 %', rate: 4, rx: /gebäude|liegenschaft|immobil|baute/i },
];

/** Wertberichtigungs-/Abschreibungskonto (indirekte Methode) */
const WB_NAME = /abschr\.|abschreibung|wertberichtig|\bwb\b|kumuliert|amortisation/i;
const FIXED_NAME = /maschin|apparat|fahrzeug|fuhrpark|mobiliar|möbel|einrichtung|installation|hardware|software|edv|informatik|werkzeug|gebäude|liegenschaft|immobil|baracke|mietmaterial|anlage|patent|lizenz|goodwill|stapler|laborger/i;
const NOT_FIXED = /darlehen|beteiligung|wertschrift|transitor|rechnungsabgrenz|forderung|kaution|depot|guthaben|vorsteuer|kasse|\bbank\b|post(konto|check)|frankier|verbindlichkeit|hypothek|rückstellung|rueckstellung|kreditor/i;

export interface FixedAssetsParams {
  /** Ausgewählte Konten; ohne Angabe: Vorschlag (Sachanlagen/immaterielle Werte nach Gruppe und Bezeichnung) */
  accounts?: string[] | null;
  /** Kategorie (ESTV) je Konto */
  categories?: Record<string, string>;
  /** Klassierung einzelner Buchungen (Schlüssel `${konto}|${seite}|${zeile}`) */
  classes?: Record<string, MoveClass>;
  /** Vom Prüfer erfasste Buchungen je Anlagekonto (z. B. fehlende Aktivierung, Korrektur), Betrag + Soll / − Haben */
  manual?: Record<string, ManualFixedPosting[]>;
}
export interface ManualFixedPosting { id: string; date: string; text: string; amount: Cents; cls: MoveClass }

export interface FixedPosting extends LedgerPosting { key: string; cls: MoveClass; auto: MoveClass; why: string; /** vom Prüfer erfasst */ manual?: boolean }
export interface FixedAssetRow {
  accountNumber: string; accountName: string;
  /** Buchwerte (bei indirekter Methode: Anlagekonto + Wertberichtigungskonto) */
  opening: Cents; additions: Cents; disposals: Cents; depreciation: Cents; transfers: Cents; closing: Cents;
  /** Indirekte Methode: zugehöriges Wertberichtigungskonto (z. B. 1501 zu 1500) */
  wbAccount: string | null;
  /** Anschaffungswerte (Anlagekonto) und kumulierte Abschreibungen (Wertberichtigungskonto; bei direkter Methode nur die Abschreibung des Jahres) */
  awOpening: Cents; awAdditions: Cents; awDisposals: Cents; awTransfers: Cents; awClosing: Cents;
  kumOpening: Cents; kumDisposals: Cents; kumOther: Cents; kumClosing: Cents;
  /** Saldo laut Saldobilanz, Differenz zum Kontoblatt */
  tbBalance: Cents | null; tbDiff: Cents | null;
  category: string | null; categoryLabel: string | null; estvRate: number | null;
  /** Effektiver Satz degressiv: Abschreibung / (Anfangsbestand + Zugänge − Abgänge) */
  effectiveRate: number | null;
  /** Nur indirekte Methode: Abschreibung / Anschaffungswert Ende (Vergleich mit dem halben ESTV-Satz für lineare Abschreibung) */
  linearRate: number | null;
  flags: string[];
  postings: FixedPosting[];
  consistent: boolean;
}
/** Eine Zugangsbuchung (für die Zugangsliste) */
export interface FixedAddition {
  /** Zeile im Anlagespiegel (Anlagekonto) und gebuchtes Konto (bei indirekter Methode ggf. das WB-Konto) */
  assetAccount: string; assetName: string; account: string;
  date: string; docNo: string | null; text: string; contra: string | null; amount: Cents;
  /** vom Prüfer als Zugang klassiert (statt Vorschlag) */
  manual: boolean; key: string; page: number; lineNo: number;
}
export interface FixedAssetsResult {
  available: boolean;
  reason?: string;
  candidates: { accountNumber: string; accountName: string; balance: Cents; suggested: boolean; inLedger: boolean; wbFor?: string | null }[];
  rows: FixedAssetRow[];
  totals: { opening: Cents; additions: Cents; disposals: Cents; depreciation: Cents; transfers: Cents; closing: Cents; tbBalance: Cents };
  categories: { key: string; label: string; rate: number }[];
  suggestions: string[];
  /** Zugangsliste: alle als Zugang klassierten Buchungen (Summe = Zugänge im Anlagespiegel) */
  additionsList: FixedAddition[];
  /** Abstimmung mit dem Abschreibungsaufwand laut Saldobilanz (Konten 68xx bzw. „Abschreibungen …“) */
  expense: { accounts: { accountNumber: string; accountName: string; balance: Cents }[]; total: Cents; diff: Cents } | null;
}

const norm = (n: string) => n.replace(/\D/g, '').replace(/^0+/, '');
const fmt = (c: Cents) => (c / 100).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/’/g, "'");

export function categoryOf(name: string): (typeof ESTV_CATEGORIES)[number] | null {
  return ESTV_CATEGORIES.find(c => c.rx.test(name)) ?? null;
}

/** Buchung klassieren: Gegenkonto (falls vorhanden), dann Buchungstext */
export function classify(p: LedgerPosting, fixedNumbers: Set<string>): { cls: MoveClass; why: string } {
  const t = p.text.toLowerCase();
  const c = p.contra ? norm(p.contra) : '';
  if (c && fixedNumbers.has(c)) return { cls: 'umbuchung', why: `Gegenkonto ${p.contra} (Anlagekonto)` };
  if (/abschreib|\bafa\b|a\.o\. afa|\bwb\b|wertberichtig|abschr\./.test(t)) return { cls: 'abschreibung', why: 'Buchungstext (Abschreibung/Wertberichtigung)' };
  if (c.startsWith('68')) return { cls: 'abschreibung', why: `Gegenkonto ${p.contra} (Abschreibungen)` };
  if (/ausbuch|restwert|\brw\b|verkauf|abgang|veräusser|veraeusser|verschrott|desinvest|ausb\./.test(t)) return { cls: 'abgang', why: 'Buchungstext (Abgang/Verkauf)' };
  if (p.amount < 0 && (c.startsWith('79') || c.startsWith('80') || c.startsWith('85') || c.startsWith('86'))) return { cls: 'abgang', why: `Gegenkonto ${p.contra} (Veräusserung/ausserordentlich)` };
  if (/umbuch|korrektur|übertrag/.test(t) && Math.abs(p.amount) < 100_00) return { cls: 'umbuchung', why: 'Buchungstext (Umbuchung/Korrektur)' };
  if (p.amount > 0) return { cls: 'zugang', why: 'Soll-Buchung (Zugang)' };
  return { cls: 'abgang', why: 'Haben-Buchung ohne Abschreibungshinweis (Abgang – prüfen)' };
}

export function fixedAssetsFor(
  res: { accounts: { accountNumber: string; accountName: string; groupCode: string | null; category?: string; balanceCurrentYear: number }[]; ledger?: Ledger | null },
  p: FixedAssetsParams = {},
): FixedAssetsResult {
  const ledgerBy = new Map((res.ledger?.accounts ?? []).map(a => [norm(a.accountNumber), a]));
  // Vorschlag: Gruppen Sachanlagen/immaterielle Werte oder Bezeichnung einer Sachanlage – ohne Darlehen/Beteiligungen
  const candidates = res.accounts
    // nur Aktivkonten: Aufwandskonten ("Unterhalt Maschinen"), Hypotheken, Rückstellungen usw. gehören nicht dazu
    .filter(a => (a.category ?? 'aktiven') === 'aktiven')
    .filter(a => (['A21', 'A22', 'A23'].includes(a.groupCode ?? '') || FIXED_NAME.test(a.accountName)) && !NOT_FIXED.test(a.accountName))
    .map(a => {
      const la = ledgerBy.get(norm(a.accountNumber));
      return { accountNumber: a.accountNumber, accountName: a.accountName, balance: a.balanceCurrentYear, suggested: true, inLedger: !!la, wbFor: null as string | null };
    });
  // Indirekte Methode: Wertberichtigungskonto ("Abschr. und Wertberichtigungen", "WB …") dem Anlagekonto davor zuordnen
  for (const c of candidates) {
    if (!WB_NAME.test(c.accountName)) continue;
    const n = Number(norm(c.accountNumber));
    const asset = [...candidates].filter(x => x !== c && !WB_NAME.test(x.accountName) && Number(norm(x.accountNumber)) < n && Number(norm(x.accountNumber)) >= n - 9 && norm(x.accountNumber).length === norm(c.accountNumber).length)
      .sort((x, y) => Number(norm(y.accountNumber)) - Number(norm(x.accountNumber)))[0];
    if (asset) c.wbFor = asset.accountNumber;
  }
  const base = { candidates, categories: ESTV_CATEGORIES.map(({ key, label, rate }) => ({ key, label, rate })) };
  const empty = { opening: 0, additions: 0, disposals: 0, depreciation: 0, transfers: 0, closing: 0, tbBalance: 0 };
  if (!res.ledger?.accounts.length) {
    const files = res.ledger?.sources ?? [];
    const reason = files.length
      ? `In den Kontoblättern (${files.join(', ')}) wurden keine Konten erkannt – Aufbau unbekannt oder PDF ohne Textebene (Hinweis unter „Saldobilanz“). Bitte als Excel bzw. PDF mit Textebene exportieren oder eine Beispielseite melden.`
      : 'Für den Anlagespiegel werden die Kontoblätter benötigt (bei „Neue Prüfung“, Schritt 4).';
    return { ...base, available: false, reason, rows: [], totals: empty, suggestions: [], expense: null, additionsList: [] };
  }
  const selected = p.accounts?.length ? p.accounts : candidates.filter(c => c.inLedger).map(c => c.accountNumber);
  const fixedNumbers = new Set(selected.map(norm));
  // Wertberichtigungskonten, deren Anlagekonto ebenfalls gewählt ist, werden dort eingerechnet (keine eigene Zeile)
  const wbOf = new Map<string, string>();
  for (const c of candidates) if (c.wbFor && selected.includes(c.accountNumber) && selected.includes(c.wbFor)) wbOf.set(c.wbFor, c.accountNumber);
  const merged = new Set(wbOf.values());
  const rows: FixedAssetRow[] = [];
  /**
   * Buchungen eines Anlagekontos (role 'asset') bzw. seines Wertberichtigungskontos (role 'wb') klassieren.
   * partner = das jeweils andere Konto des Paars (Buchungen dazwischen = Auflösung der Wertberichtigung bei Abgang).
   */
  const mk = (num: string, la: LedgerAccount, role: 'asset' | 'wb', partner: string | null, partnerPostings: LedgerPosting[] = []): FixedPosting[] => {
    const docsWithAddition = new Set(la.postings.filter(x => x.amount > 0 && x.docNo).map(x => x.docNo!));
    // Gegenbuchungen auf dem Partnerkonto: Abgang auf dem Anlagekonto (für 'wb') bzw. Auflösung der Wertberichtigung (für 'asset')
    const partnerKeys = new Set<string>();
    for (const x of partnerPostings) if (role === 'wb' ? x.amount < 0 : x.amount > 0) { if (x.docNo) partnerKeys.add('d:' + x.docNo); partnerKeys.add('t:' + x.date); }
    const disposalKeys = role === 'wb' ? partnerKeys : new Set<string>();
    return la.postings.map(x => {
      const key = `${num}|${x.page}|${x.lineNo}`;
      const c = x.contra ? norm(x.contra) : '';
      const t = x.text.toLowerCase();
      let auto = classify(x, fixedNumbers);
      if (partner && c && c === norm(partner)) auto = { cls: 'abgang', why: `Auflösung der Wertberichtigung bei Abgang (Gegenkonto ${x.contra})` };
      else if (role === 'asset' && x.amount < 0 && auto.cls === 'abgang' && ((x.docNo && partnerKeys.has('d:' + x.docNo)) || partnerKeys.has('t:' + x.date)))
        auto = { cls: 'abgang', why: 'Abgang (am selben Beleg/Tag wird die Wertberichtigung aufgelöst)' };
      else if (role === 'asset' && x.amount < 0 && auto.cls === 'abgang' && (/skonto|rabatt|gutschrift|rückvergüt|rueckvergüt|preisminder/.test(t) || (x.docNo && docsWithAddition.has(x.docNo))))
        auto = { cls: 'zugang', why: x.docNo && docsWithAddition.has(x.docNo) ? `Minderung des Zugangs (gleicher Beleg ${x.docNo} wie die Aktivierung, z. B. Skonto/Rabatt)` : 'Minderung des Zugangs (Skonto/Rabatt/Gutschrift)' };
      else if (role === 'wb' && auto.cls !== 'umbuchung') {
        const matchesDisposal = (x.docNo && disposalKeys.has('d:' + x.docNo)) || disposalKeys.has('t:' + x.date);
        if (x.amount < 0) auto = { cls: 'abschreibung', why: 'Wertberichtigungskonto (Haben = Abschreibung)' };
        else if (c.startsWith('68')) auto = { cls: 'abschreibung', why: `Wertberichtigungskonto: Soll gegen Abschreibungsaufwand ${x.contra} = Korrektur/Storno der Abschreibung` };
        else if (matchesDisposal) auto = { cls: 'abgang', why: 'Wertberichtigungskonto: Auflösung bei Abgang (gleicher Beleg/Tag wie der Abgang auf dem Anlagekonto)' };
        else if (/abschreib|storno|korr/.test(t)) auto = { cls: 'abschreibung', why: 'Wertberichtigungskonto: Soll ohne Abgang auf dem Anlagekonto = Korrektur/Storno der Abschreibung (prüfen)' };
        else auto = { cls: 'abgang', why: 'Wertberichtigungskonto (Soll = Auflösung bei Abgang – prüfen)' };
      }
      return { ...x, key, auto: auto.cls, cls: p.classes?.[key] ?? auto.cls, why: auto.why };
    });
  };
  for (const num of selected) {
    if (merged.has(num)) continue;
    const tb = res.accounts.find(a => a.accountNumber === num);
    const la: LedgerAccount | undefined = ledgerBy.get(norm(num));
    if (!la) continue;
    const wbNum = wbOf.get(num) ?? null;
    const wb = wbNum ? ledgerBy.get(norm(wbNum)) : undefined;
    const ap = mk(num, la, 'asset', wbNum, wb?.postings ?? []);
    // manuelle Buchungen des Prüfers: wie Buchungen des Anlagekontos (fliessen in Summen, Zugangsliste und Endbestand)
    const man = (p.manual?.[num] ?? []).map((m, i): FixedPosting => ({
      date: m.date, text: m.text, contra: null, docNo: null, amount: m.amount, balance: null, page: 0, lineNo: i,
      key: `${num}|M|${m.id}`, cls: m.cls, auto: m.cls, why: 'manuell erfasst (Prüfer)', manual: true,
    }));
    ap.push(...man);
    const manualSum = man.reduce((x, m) => x + m.amount, 0);
    const wp = wb ? mk(wbNum!, wb, 'wb', num, la.postings) : [];
    const sum = (list: FixedPosting[], c: MoveClass) => list.filter(x => x.cls === c).reduce((s2, x) => s2 + x.amount, 0);
    // Anschaffungswerte (Anlagekonto) und kumulierte Abschreibungen (Wertberichtigungskonto bzw. bei direkter Methode die Abschreibung des Jahres)
    const awOpening = la.opening ?? 0;
    const awAdditions = sum(ap, 'zugang');
    const awDisposals = -sum(ap, 'abgang') || 0;
    const awTransfers = sum(ap, 'umbuchung');
    const awClosing = awOpening + awAdditions - awDisposals + awTransfers;
    const kumOpening = wb?.opening ?? 0;
    const kumDisposals = sum(wp, 'abgang');
    const depreciation = -(sum(ap, 'abschreibung') + sum(wp, 'abschreibung')) || 0;
    const kumOther = sum(wp, 'zugang') + sum(wp, 'umbuchung');
    const kumClosing = kumOpening - depreciation + kumDisposals + kumOther;
    // Buchwerte
    const additions = awAdditions + sum(wp, 'zugang');
    const transfers = awTransfers + sum(wp, 'umbuchung');
    const opening = awOpening + kumOpening;
    const disposals = awDisposals - kumDisposals;
    const closing = (la.closing ?? awOpening) + manualSum + (wb ? wb.closing ?? kumOpening : 0);
    const postings = [...ap, ...wp].sort((x, y) => x.date.localeCompare(y.date));
    const catKey = p.categories?.[num] ?? categoryOf(la.accountName || tb?.accountName || '')?.key ?? null;
    const cat = ESTV_CATEGORIES.find(c => c.key === catKey) ?? null;
    const baseValue = opening + additions - disposals + transfers;
    const effectiveRate = baseValue > 0 && depreciation !== 0 ? depreciation / baseValue : depreciation === 0 ? 0 : null;
    const flags: string[] = [];
    const linearRate = wb && awClosing > 0 ? depreciation / awClosing : null;
    const overDeg = !!cat && effectiveRate !== null && effectiveRate * 100 > cat.rate + 0.5;
    const overLin = linearRate === null || (!!cat && linearRate * 100 > cat.rate / 2 + 0.5);
    if (cat && overDeg && overLin) flags.push(linearRate === null
      ? `Abschreibung ${(effectiveRate! * 100).toFixed(1)} % über dem ESTV-Normalsatz von ${cat.rate} % – Begründung (z. B. ausserordentliche Wertminderung) dokumentieren.`
      : `Abschreibung über dem ESTV-Normalsatz: ${(effectiveRate! * 100).toFixed(1)} % vom Buchwert (degressiv ${cat.rate} %) bzw. ${(linearRate * 100).toFixed(1)} % vom Anschaffungswert (linear ${cat.rate / 2} %) – Begründung (z. B. ausserordentliche Wertminderung) dokumentieren.`);
    if (cat && cat.rate === 0 && depreciation > 0) flags.push('Abschreibung auf Land/Grundstück – steuerlich grundsätzlich nicht zulässig.');
    if (!cat) flags.push('Kategorie (ESTV-Satz) wählen.');
    if (additions > 0 && depreciation >= additions * 0.9 && opening === 0) flags.push('Zugang im selben Jahr (nahezu) vollständig abgeschrieben – Sofortabschreibung?');
    if (disposals > 0) flags.push(`Abgänge (Buchwert) CHF ${fmt(disposals)} – Veräusserungserlös und Gewinn/Verlust prüfen.`);
    const tbWb = wbNum ? res.accounts.find(a => a.accountNumber === wbNum)?.balanceCurrentYear ?? 0 : 0;
    const tbBalance = tb ? tb.balanceCurrentYear + tbWb : null;
    const tbDiff = tbBalance !== null ? closing - tbBalance : null;
    if (tbDiff) flags.push(`Buchwert laut Kontoblättern weicht von der Saldobilanz ab (CHF ${fmt(tbDiff)}).`);
    if (!la.consistent || (wb && !wb.consistent)) flags.push('Kontoblatt: Anfangssaldo + Buchungen ≠ Endsaldo.');
    if (man.length) flags.push(`${man.length} manuelle Buchung${man.length > 1 ? 'en' : ''} des Prüfers (CHF ${fmt(manualSum)}) – Endbestand weicht entsprechend vom Kontoblatt ab.`);
    if (Math.abs(awClosing + kumClosing - closing) > 1) flags.push('Nicht alle Buchungen eindeutig zugeordnet – Klassierung prüfen.');
    rows.push({
      accountNumber: num, accountName: tb?.accountName ?? la.accountName, opening, additions, disposals, depreciation, transfers, closing,
      wbAccount: wbNum, awOpening, awAdditions, awDisposals, awTransfers, awClosing, kumOpening, kumDisposals, kumOther, kumClosing,
      tbBalance, tbDiff, category: cat?.key ?? null, categoryLabel: cat?.label ?? null, estvRate: cat?.rate ?? null,
      effectiveRate, linearRate, flags, postings, consistent: la.consistent && (!wb || wb.consistent),
    });
  }
  const t = (k: keyof FixedAssetRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
  const totals = { opening: t('opening'), additions: t('additions'), disposals: t('disposals'), depreciation: t('depreciation'), transfers: t('transfers'), closing: t('closing'), tbBalance: rows.reduce((s, r) => s + (r.tbBalance ?? 0), 0) };
  const suggestions: string[] = [];
  const over = rows.filter(r => r.flags.some(f => /über dem ESTV-Normalsatz/.test(f)));
  if (over.length) suggestions.push(`Abschreibungen über ESTV-Normalsatz begründen: ${over.map(r => r.accountNumber).join(', ')}.`);
  if (totals.disposals) suggestions.push(`Abgänge CHF ${fmt(totals.disposals)}: Verkaufsbelege, Erlöse und Buchgewinne/-verluste prüfen.`);
  if (totals.additions) suggestions.push(`Zugänge CHF ${fmt(totals.additions)}: wesentliche Investitionen mit Rechnungen belegen (Aktivierung vs. Aufwand).`);
  const diffs = rows.filter(r => r.tbDiff);
  if (diffs.length) suggestions.push(`Differenzen Kontoblatt ↔ Saldobilanz klären: ${diffs.map(r => r.accountNumber).join(', ')}.`);
  // Abstimmung Abschreibungen ↔ Aufwand: Konten 68xx (KMU-Kontenrahmen) bzw. Aufwandkonten "Abschreibungen …" (ohne Wertberichtigungen auf Forderungen/Vorräten/Finanzanlagen)
  const expAccounts = res.accounts
    .filter(a => (a.category ?? '') === 'aufwand' || /^68/.test(norm(a.accountNumber)))
    .filter(a => /^68/.test(norm(a.accountNumber)) ? !/zins|finanz/i.test(a.accountName) : /abschreib|abschr\.|amortisation/i.test(a.accountName) && !/forderung|debitor|delkredere|vorr[aä]t|warenlager|finanzanlag|beteiligung|wertschrift|darlehen|rückstell|rueckstell|garantie/i.test(a.accountName))
    .filter(a => a.balanceCurrentYear !== 0)
    .map(a => ({ accountNumber: a.accountNumber, accountName: a.accountName, balance: a.balanceCurrentYear }));
  const expTotal = expAccounts.reduce((s, a) => s + a.balance, 0);
  const expense = expAccounts.length ? { accounts: expAccounts, total: expTotal, diff: totals.depreciation - expTotal } : null;
  if (expense && Math.abs(expense.diff) > 100)
    suggestions.push(`Abschreibungen laut Anlagespiegel CHF ${fmt(totals.depreciation)} ≠ Abschreibungsaufwand laut Saldobilanz CHF ${fmt(expTotal)} (${expAccounts.map(a => a.accountNumber).join(', ')}) – Differenz CHF ${fmt(expense.diff)} klären (z. B. nicht gewählte Konten, Abschreibungen auf Finanzanlagen/Beteiligungen).`);
  const additionsList: FixedAddition[] = rows.flatMap(r => r.postings.filter(x => x.cls === 'zugang').map(x => ({
    assetAccount: r.accountNumber, assetName: r.accountName, account: x.key.split('|')[0] ?? r.accountNumber,
    date: x.date, docNo: x.docNo, text: x.text, contra: x.contra, amount: x.amount, manual: x.cls !== x.auto || !!x.manual, key: x.key, page: x.page, lineNo: x.lineNo,
  }))).sort((a, b) => a.assetAccount.localeCompare(b.assetAccount, 'de', { numeric: true }) || a.date.localeCompare(b.date));
  return { ...base, available: true, rows, totals, suggestions, expense, additionsList };
}
