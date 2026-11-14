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
export interface Amounts {
  cy: Cents; py: Cents | null; diff: Cents | null; diffPct: number | null; pctCy: number | null; pctPy: number | null;
  /** eigene Bezugsgrösse dieser Zeile (vom Prüfer gewählt), sonst die allgemeine */
  pctBase?: { key: string; label: string };
}
export interface IncomeAccount extends Amounts { key: string; accountNumber: string; accountName: string; big: boolean }
export interface IncomeSub extends Amounts { key: string; id: string; label: string; accounts: IncomeAccount[] }
export interface IncomeSection extends Amounts { kind: 'section'; key: string; id: string; label: string; subs: IncomeSub[]; accounts: IncomeAccount[] }
export interface IncomeResult extends Amounts { kind: 'result'; key: string; id: string; label: string }
export interface IncomeAnalysis {
  rows: (IncomeSection | IncomeResult)[];
  hasPreviousYear: boolean;
  /** Bezugsgrösse der Prozentangaben (Standard: Betriebsertrag) */
  base: { cy: Cents; py: Cents | null; label: string; key: string };
  /** Saldobilanz führt Erfolgskonten mit umgekehrtem Vorzeichen (Ertrag +) – für die Anzeige gedreht */
  signFlipped: boolean;
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

/** Bezugsgrösse der Prozentangaben: eine Zeile der Staffel (Ergebnis R:…, Gruppe S:…, Untergruppe U:…) oder Einzelkonten */
export type IncomeBase = { kind: 'line'; key: string } | { kind: 'accounts'; accounts: string[] };
/** Platzierung eines Kontos in der Staffel (vom Prüfer per Drag & Drop): Abschnitt und optional Untergruppe */
export type IncomePlacements = Record<string, { section: string; sub?: string }>;
export interface IncomeOptions {
  base?: IncomeBase | null; placements?: IncomePlacements;
  /** Bezugsgrösse je Zeile (Schlüssel: Kontonummer bzw. R:/S:/U:…), z. B. AHV-Aufwand in % des Lohnaufwands */
  rowBases?: Record<string, IncomeBase>;
}

/** Abschnitte und Untergruppen der Staffel (für Auswahllisten und Drag & Drop) */
export const INCOME_SECTIONS = STRUCTURE.filter((d): d is SectionDef => 'id' in d).map(d => ({ id: d.id, label: d.label, subs: d.subs.map(x => ({ id: x.id, label: x.label })) }));
/** Gruppe des KMU-Kontenrahmens je Abschnitt (verschobene Konten erhalten diese Gruppe) */
export const SECTION_GROUP: Record<string, string | null> = { ertrag: 'E30', material: 'E40', personal: 'E50', betrieb: 'E60', abschreibungen: 'E60', finanz: 'E60', neben: 'E70', ausserordentlich: 'E80', ohne: null, steuern: 'E89' };

export function analyzeIncomeStatement(accounts: IncomeAccountInput[], opts: IncomeOptions = {}): IncomeAnalysis {
  const er = accounts.filter(a => a.category === 'aufwand' || a.category === 'ertrag' || (/^E\d\d$/.test(a.groupCode ?? '') && a.category !== 'abschluss'));
  const hasPreviousYear = er.some(a => a.balancePreviousYear !== null && a.balancePreviousYear !== undefined);
  const secOf = (a: IncomeAccountInput) => {
    const pl = opts.placements?.[a.accountNumber];
    return pl && sections.has(pl.section) ? pl.section : sectionOf(a);
  };
  // Vorzeichen: Ertrag positiv, Aufwand negativ. Üblich ist Ertrag im Haben (−) – manche Saldobilanzen führen Erfolgskonten
  // umgekehrt (Ertrag +, Aufwand −); das wird an den Ertrags- bzw. Aufwandskonten erkannt.
  const sections = new Map<string, { def: SectionDef; subs: Map<string, { def: SubDef; accounts: (IncomeAccountInput & Raw)[] }>; accounts: (IncomeAccountInput & Raw)[] }>();
  for (const d of STRUCTURE) if ('id' in d) sections.set(d.id, { def: d, subs: new Map(), accounts: [] });
  const revenue = er.filter(a => secOf(a) === 'ertrag').reduce((x, a) => x + a.balanceCurrentYear, 0);
  const expense = er.filter(a => ['material', 'personal', 'betrieb', 'abschreibungen'].includes(secOf(a))).reduce((x, a) => x + a.balanceCurrentYear, 0);
  const signFlipped = revenue !== 0 ? revenue > 0 : expense < 0;
  const f = signFlipped ? 1 : -1;
  const val = (a: IncomeAccountInput) => ({ cy: f * a.balanceCurrentYear, py: hasPreviousYear ? f * (a.balancePreviousYear ?? 0) : null });
  const sum = (xs: { cy: Cents; py: Cents | null }[]) => ({ cy: xs.reduce((s, x) => s + x.cy, 0), py: hasPreviousYear ? xs.reduce((s, x) => s + (x.py ?? 0), 0) : null });

  type Raw = { cy: Cents; py: Cents | null };
  for (const a of er) {
    const sid = secOf(a);
    const s = sections.get(sid)!;
    const p2 = digits(a.accountNumber).slice(0, 2);
    const wanted = opts.placements?.[a.accountNumber]?.section === sid ? opts.placements[a.accountNumber]!.sub : undefined;
    const sub = (wanted ? s.def.subs.find(x => x.id === wanted) : undefined) ?? s.def.subs.find(x => x.prefixes.includes(p2)) ?? (s.def.subs.length ? { id: 'uebrige', label: 'Übrige', prefixes: [] } : null);
    const item = { ...a, ...val(a) };
    if (!sub) { s.accounts.push(item); continue; }
    const cur = s.subs.get(sub.id) ?? { def: sub, accounts: [] };
    cur.accounts.push(item);
    s.subs.set(sub.id, cur);
  }
  const byNo = (x: { accountNumber: string }, y: { accountNumber: string }) => x.accountNumber.localeCompare(y.accountNumber, 'de', { numeric: true });
  // 1. Durchgang: Beträge; Prozente folgen, sobald die Bezugsgrösse bekannt ist
  const blank = (r: Raw): Amounts => ({ cy: r.cy, py: r.py, diff: r.py === null ? null : r.cy - r.py, diffPct: r.py === null || r.py === 0 ? null : (r.cy - r.py) / Math.abs(r.py), pctCy: null, pctPy: null });
  const acc = (a: IncomeAccountInput & Raw): IncomeAccount => ({ key: a.accountNumber, accountNumber: a.accountNumber, accountName: a.accountName, ...blank(a), big: isBig(a.cy, a.py) });
  const rows: (IncomeSection | IncomeResult)[] = [];
  const running: Raw[] = [];
  for (const d of STRUCTURE) {
    if ('result' in d) {
      rows.push({ kind: 'result', key: `R:${d.result}`, id: d.result, label: d.label, ...blank(sum(running)) });
      continue;
    }
    const s = sections.get(d.id)!;
    const subOrder = [...d.subs.map(x => x.id), 'uebrige'];
    const subs = [...s.subs.values()].sort((x, y) => subOrder.indexOf(x.def.id) - subOrder.indexOf(y.def.id)).map(x => ({
      key: `U:${d.id}/${x.def.id}`, id: x.def.id, label: x.def.label, ...blank(sum(x.accounts)), accounts: x.accounts.sort(byNo).map(acc),
    }));
    const all = [...s.subs.values()].flatMap(x => x.accounts).concat(s.accounts);
    if (!all.length && (d.id === 'ohne' || d.id === 'neben' || d.id === 'ausserordentlich')) continue; // leere Nebenabschnitte weglassen
    const t = sum(all);
    running.push(t);
    rows.push({ kind: 'section', key: `S:${d.id}`, id: d.id, label: d.label, ...blank(t), subs, accounts: s.accounts.sort(byNo).map(acc) });
  }
  // 2. Bezugsgrösse: gewählte Zeile bzw. Konten, sonst Betriebsertrag; je Zeile optional eine eigene
  const lines: (Amounts & { key: string; label: string })[] = rows.flatMap(r => (r.kind === 'section' ? [r, ...r.subs] : [r]) as (Amounts & { key: string; label: string })[]);
  const allAccounts = rows.flatMap(r => (r.kind === 'section' ? [...r.subs.flatMap(x => x.accounts), ...r.accounts] : []));
  type Base = { cy: Cents; py: Cents | null; label: string; key: string };
  const resolve = (bs: IncomeBase | null | undefined): Base | null => {
    if (bs?.kind === 'accounts' && bs.accounts.length) {
      const chosen = allAccounts.filter(x => bs.accounts.includes(x.accountNumber));
      if (!chosen.length) return null;
      return { ...sum(chosen), label: chosen.length === 1 ? `${chosen[0]!.accountNumber} ${chosen[0]!.accountName}` : `${chosen.length} Konten (${chosen.map(x => x.accountNumber).join(', ')})`, key: `A:${chosen.map(x => x.accountNumber).join(',')}` };
    }
    if (bs?.kind === 'line') {
      const l = lines.find(x => x.key === bs.key);
      return l ? { cy: l.cy, py: l.py, label: l.label, key: l.key } : null;
    }
    return null;
  };
  const be = rows.find(r => r.key === 'R:betriebsertrag')!;
  const b: Base = resolve(opts.base) ?? { cy: be.cy, py: be.py, label: be.label, key: be.key };
  // Anteil: gleiches Vorzeichen wie die Bezugsgrösse = positiv (z. B. Sozialversicherungen in % des Lohnaufwands)
  const fill = (x: Amounts & { key: string }) => {
    const own = opts.rowBases?.[x.key] ? resolve(opts.rowBases[x.key]) : null;
    const k = own ?? b;
    x.pctCy = k.cy ? x.cy / k.cy : null;
    x.pctPy = x.py === null || !k.py ? null : x.py / k.py;
    if (own) x.pctBase = { key: own.key, label: own.label };
  };
  for (const r of rows) {
    fill(r);
    if (r.kind === 'section') { for (const sb of r.subs) { fill(sb); sb.accounts.forEach(fill); } r.accounts.forEach(fill); }
  }
  return { rows, hasPreviousYear, base: b, signFlipped, check: { total: sum(er.map(val)).cy, accounts: er.length } };
}
