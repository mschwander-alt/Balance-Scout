/**
 * Analyse der Erfolgsrechnung: Staffel nach KMU-Kontenrahmen mit Zwischenergebnissen (Margen),
 * Anteil am Betriebsertrag, Vorjahresvergleich und Bemerkungen des Prüfers je Konto, Untergruppe, Gruppe oder Ergebnis.
 *
 * Gliederung: Gruppe des Kontos (E30 … E89, berücksichtigt vom Prüfer verschobene Konten), innerhalb der Gruppe
 * nach den ersten zwei Ziffern der Kontonummer (KMU-Kontenrahmen, z. B. 38 = Erlösminderungen, 57 = Sozialversicherungen).
 * Vorzeichen: Ertrag positiv, Aufwand negativ (wie in einer Staffelrechnung).
 */
export type Cents = number;

interface SubDef { id: string; label: string; prefixes: string[] }
interface SectionDef { id: string; label: string; subs: SubDef[] }
interface ResultDef { result: string; label: string; margin?: boolean }

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

/** Reihenfolge der Staffel: Gruppen (Abschnitte) und Zwischenergebnisse */
const STRUCTURE: (SectionDef | ResultDef)[] = [
  { id: 'ertrag', label: 'Betrieblicher Ertrag aus Lieferungen und Leistungen', subs: [
    { id: 'erloese', label: 'Erlöse aus Lieferungen und Leistungen', prefixes: range(30, 36) },
    { id: 'eigen', label: 'Eigenleistungen und Eigenverbrauch', prefixes: ['37'] },
    { id: 'erloesminderungen', label: 'Erlösminderungen', prefixes: ['38'] },
    { id: 'bestand', label: 'Bestandesänderungen unfertige und fertige Erzeugnisse', prefixes: ['39'] },
  ] },
  { result: 'betriebsertrag', label: 'Betriebsertrag', margin: true },
  { id: 'material', label: 'Aufwand für Material, Handelswaren, Dienstleistungen und Energie', subs: [
    { id: 'material', label: 'Materialaufwand', prefixes: ['40', '41'] },
    { id: 'handelswaren', label: 'Handelswarenaufwand', prefixes: ['42', '43'] },
    { id: 'dienstleistungen', label: 'Aufwand für bezogene Dienstleistungen', prefixes: ['44'] },
    { id: 'energie', label: 'Energieaufwand zur Leistungserstellung', prefixes: ['45', '46', '47'] },
    { id: 'bestand', label: 'Bestandesänderungen, Material- und Warenverluste', prefixes: ['48'] },
    { id: 'einkaufsminderungen', label: 'Einkaufspreisminderungen', prefixes: ['49'] },
  ] },
  { result: 'brutto1', label: 'Bruttoergebnis nach Material- und Warenaufwand', margin: true },
  { id: 'personal', label: 'Personalaufwand', subs: [
    { id: 'lohn', label: 'Lohnaufwand', prefixes: range(50, 56) },
    { id: 'sozial', label: 'Sozialversicherungsaufwand', prefixes: ['57'] },
    { id: 'uebriger', label: 'Übriger Personalaufwand', prefixes: ['58'] },
    { id: 'dritte', label: 'Arbeitsleistungen Dritter', prefixes: ['59'] },
  ] },
  { result: 'brutto2', label: 'Bruttoergebnis nach Personalaufwand', margin: true },
  { id: 'betrieb', label: 'Übriger betrieblicher Aufwand', subs: [
    { id: 'raum', label: 'Raumaufwand', prefixes: ['60'] },
    { id: 'unterhalt', label: 'Unterhalt, Reparaturen, Ersatz, Leasing', prefixes: ['61'] },
    { id: 'fahrzeug', label: 'Fahrzeug- und Transportaufwand', prefixes: ['62'] },
    { id: 'versicherungen', label: 'Sachversicherungen, Abgaben, Gebühren, Bewilligungen', prefixes: ['63'] },
    { id: 'energie', label: 'Energie- und Entsorgungsaufwand', prefixes: ['64'] },
    { id: 'verwaltung', label: 'Verwaltungs- und Informatikaufwand', prefixes: ['65'] },
    { id: 'werbung', label: 'Werbeaufwand', prefixes: ['66'] },
    { id: 'sonstiger', label: 'Sonstiger betrieblicher Aufwand', prefixes: ['67'] },
  ] },
  { result: 'ebitda', label: 'Betriebliches Ergebnis vor Abschreibungen, Finanzerfolg und Steuern (EBITDA)', margin: true },
  { id: 'abschreibungen', label: 'Abschreibungen und Wertberichtigungen auf Positionen des Anlagevermögens', subs: [] },
  { result: 'ebit', label: 'Betriebliches Ergebnis vor Finanzerfolg und Steuern (EBIT)', margin: true },
  { id: 'finanz', label: 'Finanzaufwand und Finanzertrag', subs: [] },
  { result: 'betriebsergebnis', label: 'Betriebliches Ergebnis', margin: true },
  { id: 'neben', label: 'Betrieblicher Nebenerfolg', subs: [] },
  { id: 'ausserordentlich', label: 'Betriebsfremder, ausserordentlicher, einmaliger oder periodenfremder Erfolg', subs: [] },
  { id: 'ohne', label: 'Erfolgskonten ohne Gruppe (bitte zuordnen)', subs: [] },
  { result: 'vorSteuern', label: 'Jahresergebnis vor Steuern', margin: true },
  { id: 'steuern', label: 'Direkte Steuern', subs: [] },
  { result: 'gewinn', label: 'Jahresgewinn / Jahresverlust', margin: true },
];

export interface IncomeAccountInput {
  accountNumber: string; accountName: string; groupCode: string | null; category?: string;
  balanceCurrentYear: number; balancePreviousYear?: number | null;
}
/** Beträge einer Zeile: Ertrag positiv, Aufwand negativ */
export interface Amounts { cy: Cents; py: Cents | null; diff: Cents | null; diffPct: number | null; pctCy: number | null; pctPy: number | null }
export interface IncomeAccount extends Amounts { key: string; accountNumber: string; accountName: string; big: boolean }
export interface IncomeSub extends Amounts { key: string; id: string; label: string; accounts: IncomeAccount[] }
export interface IncomeSection extends Amounts { kind: 'section'; key: string; id: string; label: string; subs: IncomeSub[]; accounts: IncomeAccount[] }
export interface IncomeResult extends Amounts { kind: 'result'; key: string; id: string; label: string }
export interface IncomeAnalysis {
  rows: (IncomeSection | IncomeResult)[];
  hasPreviousYear: boolean;
  /** Basis der Prozentangaben (Betriebsertrag) */
  base: { cy: Cents; py: Cents | null };
  /** Abstimmung: Jahresgewinn laut Staffel = Summe aller Erfolgskonten */
  check: { total: Cents; accounts: number };
}
export type IncomeNotes = Record<string, { text: string; at?: string; visum?: string }>;

const digits = (n: string) => n.replace(/\D/g, '');
/** Abschnitt eines Kontos: Gruppe (berücksichtigt verschobene Konten), bei E60 nach Kontonummer (68 Abschreibungen, 69 Finanzerfolg) */
function sectionOf(a: IncomeAccountInput): string {
  const p2 = digits(a.accountNumber).slice(0, 2);
  switch (a.groupCode) {
    case 'E30': return 'ertrag';
    case 'E40': return 'material';
    case 'E50': return 'personal';
    case 'E60': return p2 === '68' ? 'abschreibungen' : p2 === '69' ? 'finanz' : 'betrieb';
    case 'E70': return 'neben';
    case 'E80': return 'ausserordentlich';
    case 'E89': return 'steuern';
    default: return 'ohne';
  }
}

/** Veränderung auffällig? (mind. 25 % und mind. CHF 1'000 – wie in der Kontentabelle) */
const isBig = (cy: Cents, py: Cents | null) => py !== null && Math.abs(cy - py) >= 1_000_00 && (py === 0 || Math.abs((cy - py) / py) >= 0.25);

export function analyzeIncomeStatement(accounts: IncomeAccountInput[]): IncomeAnalysis {
  const er = accounts.filter(a => a.category === 'aufwand' || a.category === 'ertrag' || (/^E\d\d$/.test(a.groupCode ?? '') && a.category !== 'abschluss'));
  const hasPreviousYear = er.some(a => a.balancePreviousYear !== null && a.balancePreviousYear !== undefined);
  const val = (a: IncomeAccountInput) => ({ cy: -a.balanceCurrentYear, py: hasPreviousYear ? -(a.balancePreviousYear ?? 0) : null });
  const sum = (xs: { cy: Cents; py: Cents | null }[]) => ({ cy: xs.reduce((s, x) => s + x.cy, 0), py: hasPreviousYear ? xs.reduce((s, x) => s + (x.py ?? 0), 0) : null });

  // Rohstruktur ohne Prozente (Basis erst nach dem Betriebsertrag bekannt)
  type Raw = { cy: Cents; py: Cents | null };
  const sections = new Map<string, { def: SectionDef; subs: Map<string, { def: SubDef; accounts: (IncomeAccountInput & Raw)[] }>; accounts: (IncomeAccountInput & Raw)[] }>();
  for (const d of STRUCTURE) if ('id' in d) sections.set(d.id, { def: d, subs: new Map(), accounts: [] });
  for (const a of er) {
    const s = sections.get(sectionOf(a))!;
    const p2 = digits(a.accountNumber).slice(0, 2);
    const sub = s.def.subs.find(x => x.prefixes.includes(p2)) ?? (s.def.subs.length ? { id: 'uebrige', label: 'Übrige', prefixes: [] } : null);
    const item = { ...a, ...val(a) };
    if (!sub) { s.accounts.push(item); continue; }
    const cur = s.subs.get(sub.id) ?? { def: sub, accounts: [] };
    cur.accounts.push(item);
    s.subs.set(sub.id, cur);
  }
  const ertrag = sections.get('ertrag')!;
  const base = sum([...ertrag.subs.values()].flatMap(x => x.accounts).concat(ertrag.accounts));
  const amounts = (r: Raw): Amounts => ({
    cy: r.cy, py: r.py,
    diff: r.py === null ? null : r.cy - r.py,
    diffPct: r.py === null || r.py === 0 ? null : (r.cy - r.py) / Math.abs(r.py),
    pctCy: base.cy ? r.cy / base.cy : null,
    pctPy: r.py === null || !base.py ? null : r.py / base.py,
  });
  const byNo = (x: { accountNumber: string }, y: { accountNumber: string }) => x.accountNumber.localeCompare(y.accountNumber, 'de', { numeric: true });
  const acc = (a: IncomeAccountInput & Raw): IncomeAccount => ({ key: a.accountNumber, accountNumber: a.accountNumber, accountName: a.accountName, ...amounts(a), big: isBig(a.cy, a.py) });

  const rows: (IncomeSection | IncomeResult)[] = [];
  const running: Raw[] = [];
  for (const d of STRUCTURE) {
    if ('result' in d) {
      rows.push({ kind: 'result', key: `R:${d.result}`, id: d.result, label: d.label, ...amounts(sum(running)) });
      continue;
    }
    const s = sections.get(d.id)!;
    const subOrder = [...d.subs.map(x => x.id), 'uebrige'];
    const subs = [...s.subs.values()].sort((x, y) => subOrder.indexOf(x.def.id) - subOrder.indexOf(y.def.id)).map(x => {
      const t = sum(x.accounts);
      return { key: `U:${d.id}/${x.def.id}`, id: x.def.id, label: x.def.label, ...amounts(t), accounts: x.accounts.sort(byNo).map(acc) };
    });
    const all = [...s.subs.values()].flatMap(x => x.accounts).concat(s.accounts);
    if (!all.length && (d.id === 'ohne' || d.id === 'neben' || d.id === 'ausserordentlich')) continue; // leere Nebenabschnitte weglassen
    const t = sum(all);
    running.push(t);
    rows.push({ kind: 'section', key: `S:${d.id}`, id: d.id, label: d.label, ...amounts(t), subs, accounts: s.accounts.sort(byNo).map(acc) });
  }
  return { rows, hasPreviousYear, base, check: { total: sum(er.map(val)).cy, accounts: er.length } };
}
