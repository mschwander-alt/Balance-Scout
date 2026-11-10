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

const FIXED_NAME = /maschin|apparat|fahrzeug|fuhrpark|mobiliar|möbel|einrichtung|installation|hardware|software|edv|informatik|werkzeug|gebäude|liegenschaft|immobil|baracke|mietmaterial|anlage|patent|lizenz|goodwill|stapler|laborger/i;
const NOT_FIXED = /darlehen|beteiligung|wertschrift|transitor|rechnungsabgrenz|forderung|kaution|depot|guthaben|vorsteuer|kasse|\bbank\b|post(konto|check)|frankier|verbindlichkeit|hypothek|rückstellung|rueckstellung|kreditor/i;

export interface FixedAssetsParams {
  /** Ausgewählte Konten; ohne Angabe: Vorschlag (Sachanlagen/immaterielle Werte nach Gruppe und Bezeichnung) */
  accounts?: string[] | null;
  /** Kategorie (ESTV) je Konto */
  categories?: Record<string, string>;
  /** Klassierung einzelner Buchungen (Schlüssel `${konto}|${seite}|${zeile}`) */
  classes?: Record<string, MoveClass>;
}

export interface FixedPosting extends LedgerPosting { key: string; cls: MoveClass; auto: MoveClass; why: string }
export interface FixedAssetRow {
  accountNumber: string; accountName: string;
  opening: Cents; additions: Cents; disposals: Cents; depreciation: Cents; transfers: Cents; closing: Cents;
  /** Saldo laut Saldobilanz, Differenz zum Kontoblatt */
  tbBalance: Cents | null; tbDiff: Cents | null;
  category: string | null; categoryLabel: string | null; estvRate: number | null;
  /** Effektiver Satz degressiv: Abschreibung / (Anfangsbestand + Zugänge − Abgänge) */
  effectiveRate: number | null;
  flags: string[];
  postings: FixedPosting[];
  consistent: boolean;
}
export interface FixedAssetsResult {
  available: boolean;
  reason?: string;
  candidates: { accountNumber: string; accountName: string; balance: Cents; suggested: boolean; inLedger: boolean }[];
  rows: FixedAssetRow[];
  totals: { opening: Cents; additions: Cents; disposals: Cents; depreciation: Cents; transfers: Cents; closing: Cents; tbBalance: Cents };
  categories: { key: string; label: string; rate: number }[];
  suggestions: string[];
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
      return { accountNumber: a.accountNumber, accountName: a.accountName, balance: a.balanceCurrentYear, suggested: true, inLedger: !!la };
    });
  const base = { candidates, categories: ESTV_CATEGORIES.map(({ key, label, rate }) => ({ key, label, rate })) };
  const empty = { opening: 0, additions: 0, disposals: 0, depreciation: 0, transfers: 0, closing: 0, tbBalance: 0 };
  if (!res.ledger?.accounts.length) return { ...base, available: false, reason: 'Für den Anlagespiegel werden die Kontoblätter benötigt (bei „Neue Prüfung“, Schritt 4).', rows: [], totals: empty, suggestions: [] };
  const selected = p.accounts?.length ? p.accounts : candidates.filter(c => c.inLedger).map(c => c.accountNumber);
  const fixedNumbers = new Set(selected.map(norm));
  const rows: FixedAssetRow[] = [];
  for (const num of selected) {
    const tb = res.accounts.find(a => a.accountNumber === num);
    const la: LedgerAccount | undefined = ledgerBy.get(norm(num));
    if (!la) continue;
    const postings: FixedPosting[] = la.postings.map(x => {
      const key = `${num}|${x.page}|${x.lineNo}`;
      const auto = classify(x, fixedNumbers);
      return { ...x, key, auto: auto.cls, cls: p.classes?.[key] ?? auto.cls, why: auto.why };
    });
    const sum = (c: MoveClass) => postings.filter(x => x.cls === c).reduce((s, x) => s + x.amount, 0);
    const opening = la.opening ?? 0;
    const additions = sum('zugang');
    const disposals = -sum('abgang') || 0; // "|| 0": keine −0
    const depreciation = -sum('abschreibung') || 0;
    const transfers = sum('umbuchung');
    const closing = la.closing ?? opening + additions - disposals - depreciation + transfers;
    const catKey = p.categories?.[num] ?? categoryOf(la.accountName || tb?.accountName || '')?.key ?? null;
    const cat = ESTV_CATEGORIES.find(c => c.key === catKey) ?? null;
    const baseValue = opening + additions - disposals + transfers;
    const effectiveRate = baseValue > 0 && depreciation !== 0 ? depreciation / baseValue : depreciation === 0 ? 0 : null;
    const flags: string[] = [];
    if (cat && effectiveRate !== null && effectiveRate * 100 > cat.rate + 0.5) flags.push(`Abschreibung ${(effectiveRate * 100).toFixed(1)} % über dem ESTV-Normalsatz von ${cat.rate} % – Begründung (z. B. ausserordentliche Wertminderung) dokumentieren.`);
    if (cat && cat.rate === 0 && depreciation > 0) flags.push('Abschreibung auf Land/Grundstück – steuerlich grundsätzlich nicht zulässig.');
    if (!cat) flags.push('Kategorie (ESTV-Satz) wählen.');
    if (additions > 0 && depreciation >= additions * 0.9 && opening === 0) flags.push('Zugang im selben Jahr (nahezu) vollständig abgeschrieben – Sofortabschreibung?');
    if (disposals > 0) flags.push(`Abgänge CHF ${fmt(disposals)} – Veräusserungserlös und Gewinn/Verlust prüfen.`);
    const tbDiff = tb ? closing - tb.balanceCurrentYear : null;
    if (tbDiff) flags.push(`Endbestand Kontoblatt weicht von der Saldobilanz ab (CHF ${fmt(tbDiff)}).`);
    if (!la.consistent) flags.push('Kontoblatt: Saldovortrag + Buchungen ≠ Schlusssaldo.');
    rows.push({
      accountNumber: num, accountName: tb?.accountName ?? la.accountName, opening, additions, disposals, depreciation, transfers, closing,
      tbBalance: tb?.balanceCurrentYear ?? null, tbDiff, category: cat?.key ?? null, categoryLabel: cat?.label ?? null, estvRate: cat?.rate ?? null,
      effectiveRate, flags, postings, consistent: la.consistent,
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
  return { ...base, available: true, rows, totals, suggestions };
}
