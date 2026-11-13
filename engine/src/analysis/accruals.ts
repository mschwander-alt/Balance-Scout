/**
 * Prüfgebiet Rechnungsabgrenzungen: Vorjahresvergleich der aktiven und passiven Rechnungsabgrenzungen aus den Kontoblättern.
 *
 * - Vorjahr: Auflösungen zu Beginn der Periode – Buchungen vom Saldovortrag an, bis das Konto erstmals auf null steht
 *   (ohne Nullstand: Gegenbuchungen der ersten drei Monate).
 * - Laufendes Jahr: Bildung Ende Jahr – Buchungen nach dem letzten Nullstand bis zum Schlusssaldo
 *   (ohne Nullstand: Buchungen der letzten zwei Monate in Richtung des Saldos).
 * - Dazwischen: unterjährige Buchungen (nicht im Vergleich).
 * Positionen beider Jahre werden über Gegenkonto und Buchungstext zugeordnet; jede Buchung ist manuell umklassierbar.
 */
import type { Ledger, LedgerAccount, LedgerPosting } from '../ingest/ledger.js';

export type Cents = number;
export type AccrualClass = 'vorjahr' | 'laufend' | 'unterjaehrig';

export interface AccrualsParams {
  /** Gewählte Konten; ohne Angabe: aktive Rechnungsabgrenzungen (Gruppe A15) und passive (P13 ohne Rückstellungen) mit Kontoblatt */
  accounts?: string[] | null;
  /** Klassierung einzelner Buchungen (Schlüssel `${konto}|${seite}|${zeile}`) */
  classes?: Record<string, AccrualClass>;
}
export interface AccrualPosting extends LedgerPosting { key: string; cls: AccrualClass; auto: AccrualClass; why: string }
export interface AccrualPosition {
  key: string;
  /** Bezeichnung (Text des laufenden Jahres, sonst des Vorjahres) */
  label: string;
  contra: string | null;
  /** positiv = Abgrenzung in Richtung des Kontos (aktiv: Guthaben, passiv: Schuld) */
  cy: Cents; py: Cents; diff: Cents;
  /** nur in einem Jahr vorhanden */
  status: 'beide' | 'neu' | 'entfallen';
  postings: string[];
}
export interface AccrualAccount {
  accountNumber: string; accountName: string; side: 'aktiv' | 'passiv';
  opening: Cents; closing: Cents; tbBalance: Cents | null;
  positions: AccrualPosition[];
  totals: { cy: Cents; py: Cents; diff: Cents };
  /** Abweichungen: Summe Vorjahr ≠ Saldovortrag, Summe laufendes Jahr ≠ Schlusssaldo bzw. Saldobilanz */
  unexplained: { cy: Cents; py: Cents };
  intraYear: number;
  postings: AccrualPosting[];
  flags: string[];
}
export interface AccrualsResult {
  available: boolean; reason?: string;
  candidates: { accountNumber: string; accountName: string; balance: Cents; side: 'aktiv' | 'passiv'; suggested: boolean; inLedger: boolean }[];
  accounts: AccrualAccount[];
  totals: { aktiv: { cy: Cents; py: Cents }; passiv: { cy: Cents; py: Cents } };
  suggestions: string[];
}

const norm = (n: string) => n.replace(/\D/g, '').replace(/^0+/, '');
const RAP_NAME = /abgrenz|transitor|\brap\b|\bta\b|\btp\b|vorausbezahlt|vorauszahlung|noch nicht bezahlt|aufgelaufen/i;
const PROVISION = /rückstellung|rueckstellung|garantie/i;
/** Wörter, die nur die Buchungsart beschreiben (für die Zuordnung der Positionen bedeutungslos) */
const NOISE = /\b(auflösung|aufloesung|auflösen|rückbuchung|rueckbuchung|storno|ausbuchung|bildung|abgrenzung|abgr|aktive?|passive?|transitorische?|transitorien|rap|ta|tp|ra|pa|vj|vorjahr|per|ende|jahr|und|für|fuer|bis|von|ab)\b/gi;
const fmt = (c: Cents) => (c / 100).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/’/g, "'");

/** Vergleichstext: ohne Zahlen, Daten, Satzzeichen und Buchungsart-Wörter */
export function positionText(t: string): string {
  return t.toLowerCase().replace(/\d+/g, ' ').replace(NOISE, ' ').replace(/[^a-zäöüéèàç]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const tokens = (t: string) => new Set(positionText(t).split(' ').filter(w => w.length >= 3));
function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}

/** Bezeichnung ohne vorangestellte Buchungsart („Auflösung TA …“) */
const cleanLabel = (t: string) => t.replace(/^(auflösung|aufloesung|rückbuchung|rueckbuchung|storno)\b\s*(ta|tp|ra|pa|rap|transitorische\s+\S+|abgrenzung)?\b[\s:,-]*/i, '').trim() || t;

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Buchungen eines Kontos klassieren (Vorjahr / laufendes Jahr / unterjährig) */
export function classifyAccrualPostings(la: LedgerAccount, period: { from: string | null; to: string | null }): { cls: AccrualClass; why: string }[] {
  const ps = la.postings;
  const opening = la.opening ?? 0;
  const running: number[] = [];
  let bal = opening;
  for (const p of ps) { bal += p.amount; running.push(bal); }
  const zero = (i: number) => Math.abs(running[i]!) <= 1;
  const firstZero = opening === 0 ? -1 : running.findIndex((_, i) => zero(i));
  let lastZero = -1;
  for (let i = running.length - 1; i >= 0; i--) if (zero(i)) { lastZero = i; break; }
  const out: { cls: AccrualClass; why: string }[] = [];
  if (opening !== 0 && firstZero < 0) {
    // kein Nullstand: Vorjahr = Gegenbuchungen der ersten drei Monate, laufendes Jahr = Buchungen der letzten zwei Monate in Saldorichtung
    const start = period.from ?? ps[0]?.date ?? '';
    const end = period.to ?? ps[ps.length - 1]?.date ?? '';
    const sign = Math.sign(opening);
    for (const p of ps) {
      if (start && p.date < addDays(start, 92) && Math.sign(p.amount) === -sign) out.push({ cls: 'vorjahr', why: 'Gegenbuchung in den ersten drei Monaten (Auflösung) – Konto steht nie auf null, bitte prüfen' });
      else if (end && p.date > addDays(end, -61) && Math.sign(p.amount) === Math.sign(la.closing ?? opening)) out.push({ cls: 'laufend', why: 'Buchung in den letzten zwei Monaten (Bildung) – Konto steht nie auf null, bitte prüfen' });
      else out.push({ cls: 'unterjaehrig', why: 'unterjährige Buchung' });
    }
    return out;
  }
  ps.forEach((_, i) => {
    if (i <= firstZero) out.push({ cls: 'vorjahr', why: 'Auflösung des Saldovortrags (bis das Konto auf null steht)' });
    else if (i > lastZero) out.push({ cls: 'laufend', why: 'Bildung Ende Jahr (nach dem letzten Nullstand)' });
    else out.push({ cls: 'unterjaehrig', why: 'unterjährige Buchung (zwischen Auflösung und Bildung)' });
  });
  return out;
}

type ResLike = {
  accounts: { accountNumber: string; accountName: string; groupCode: string | null; category?: string; balanceCurrentYear: number }[];
  ledger?: Ledger | null;
};

export function accrualsFor(res: ResLike, p: AccrualsParams = {}): AccrualsResult {
  const ledgerBy = new Map((res.ledger?.accounts ?? []).map(a => [norm(a.accountNumber), a]));
  const candidates = res.accounts
    .filter(a => a.groupCode === 'A15' || a.groupCode === 'P13' || (RAP_NAME.test(a.accountName) && /^(aktiven|passiven)$/.test(a.category ?? '')))
    .map(a => {
      const side: 'aktiv' | 'passiv' = a.groupCode === 'A15' || a.category === 'aktiven' ? 'aktiv' : 'passiv';
      const suggested = a.groupCode === 'A15' || (side === 'passiv' && !PROVISION.test(a.accountName) && (a.groupCode !== 'P13' || RAP_NAME.test(a.accountName) || !/rückst|rueckst/i.test(a.accountName)));
      return { accountNumber: a.accountNumber, accountName: a.accountName, balance: a.balanceCurrentYear, side, suggested, inLedger: ledgerBy.has(norm(a.accountNumber)) };
    });
  const empty = { aktiv: { cy: 0, py: 0 }, passiv: { cy: 0, py: 0 } };
  if (!res.ledger?.accounts.length) {
    return { available: false, candidates, accounts: [], totals: empty, suggestions: [],
      reason: 'Für den Vorjahresvergleich der Rechnungsabgrenzungen werden die Kontoblätter benötigt (bei „Neue Prüfung“, Schritt 4).' };
  }
  const period = res.ledger.period;
  const selected = p.accounts?.length ? p.accounts : candidates.filter(c => c.suggested && c.inLedger).map(c => c.accountNumber);
  const accounts: AccrualAccount[] = [];
  for (const num of selected) {
    const la = ledgerBy.get(norm(num));
    const c = candidates.find(x => x.accountNumber === num);
    const tb = res.accounts.find(a => a.accountNumber === num);
    if (!la) continue;
    const side = c?.side ?? (tb?.category === 'passiven' ? 'passiv' : 'aktiv');
    const s = side === 'aktiv' ? 1 : -1;
    const auto = classifyAccrualPostings(la, period);
    const postings: AccrualPosting[] = la.postings.map((x, i) => {
      const key = `${num}|${x.page}|${x.lineNo}`;
      return { ...x, key, auto: auto[i]!.cls, cls: p.classes?.[key] ?? auto[i]!.cls, why: auto[i]!.why };
    });
    // Positionen je Jahr: gleiche Gegenkonto/Text-Kombination zusammenfassen
    type Item = { text: string; contra: string | null; amount: Cents; keys: string[] };
    const collect = (cls: AccrualClass, sign: number) => {
      const m = new Map<string, Item>();
      for (const x of postings.filter(y => y.cls === cls)) {
        const k = `${x.contra ?? ''}|${positionText(x.text)}`;
        const it = m.get(k) ?? { text: x.text, contra: x.contra, amount: 0, keys: [] };
        it.amount += sign * s * x.amount;
        it.keys.push(x.key);
        m.set(k, it);
      }
      return [...m.values()].filter(x => x.amount !== 0 || x.keys.length);
    };
    const prev = collect('vorjahr', -1); // Auflösung: Gegenbuchung → Vorjahresbetrag positiv
    const cur = collect('laufend', 1);
    // Zuordnen: zuerst gleiches Gegenkonto + ähnlicher Text, dann nur ähnlicher Text
    const used = new Set<Item>();
    const positions: AccrualPosition[] = [];
    const pick = (it: Item, sameContra: boolean) => prev
      .filter(q => !used.has(q) && (!sameContra || (q.contra ?? '') === (it.contra ?? '')))
      .map(q => ({ q, sim: similarity(q.text, it.text) }))
      .filter(x => x.sim >= (sameContra && it.contra ? 0.5 : 0.75) || (sameContra && it.contra && positionText(x.q.text) === positionText(it.text)))
      .sort((x, y) => y.sim - x.sim)[0]?.q;
    for (const it of cur) {
      const q = pick(it, true) ?? pick(it, false);
      if (q) used.add(q);
      const py = q?.amount ?? 0;
      positions.push({ key: it.keys[0]!, label: cleanLabel(it.text), contra: it.contra ?? q?.contra ?? null, cy: it.amount, py, diff: it.amount - py, status: q ? 'beide' : 'neu', postings: [...it.keys, ...(q?.keys ?? [])] });
    }
    for (const q of prev.filter(x => !used.has(x))) positions.push({ key: q.keys[0]!, label: cleanLabel(q.text), contra: q.contra, cy: 0, py: q.amount, diff: -q.amount, status: 'entfallen', postings: q.keys });
    positions.sort((x, y) => y.cy - x.cy || y.py - x.py);
    const totals = { cy: positions.reduce((a, x) => a + x.cy, 0), py: positions.reduce((a, x) => a + x.py, 0), diff: 0 };
    totals.diff = totals.cy - totals.py;
    const opening = s * (la.opening ?? 0);
    const closing = s * (la.closing ?? 0);
    const tbBalance = tb ? s * tb.balanceCurrentYear : null;
    const unexplained = { py: opening - totals.py, cy: closing - totals.cy };
    const flags: string[] = [];
    if (Math.abs(unexplained.py) > 1) flags.push(`Vorjahr: Summe der Auflösungen CHF ${fmt(totals.py)} ≠ Saldovortrag CHF ${fmt(opening)} (Differenz ${fmt(unexplained.py)}) – Klassierung der Buchungen prüfen.`);
    if (Math.abs(unexplained.cy) > 1) flags.push(`Laufendes Jahr: Summe der Abgrenzungen CHF ${fmt(totals.cy)} ≠ Schlusssaldo CHF ${fmt(closing)} (Differenz ${fmt(unexplained.cy)}) – Klassierung der Buchungen prüfen.`);
    if (tbBalance !== null && Math.abs(tbBalance - closing) > 1) flags.push(`Schlusssaldo Kontoblatt CHF ${fmt(closing)} ≠ Saldobilanz CHF ${fmt(tbBalance)}.`);
    if (!la.consistent) flags.push('Kontoblatt: Saldovortrag + Buchungen ≠ Schlusssaldo.');
    if (postings.some(x => /nie auf null/.test(x.why) && x.cls === x.auto)) flags.push('Konto steht im Jahr nie auf null – Auflösung und Bildung nach Datum angenommen, bitte prüfen.');
    const intraYear = postings.filter(x => x.cls === 'unterjaehrig').length;
    accounts.push({ accountNumber: num, accountName: tb?.accountName ?? la.accountName, side, opening, closing, tbBalance, positions, totals, unexplained, intraYear, postings, flags });
  }
  const tot = (side: 'aktiv' | 'passiv') => ({ cy: accounts.filter(a => a.side === side).reduce((x, a) => x + a.totals.cy, 0), py: accounts.filter(a => a.side === side).reduce((x, a) => x + a.totals.py, 0) });
  const suggestions: string[] = [];
  const news = accounts.flatMap(a => a.positions.filter(x => x.status === 'neu' && Math.abs(x.cy) >= 1_000_00).map(x => `${x.label} (CHF ${fmt(x.cy)})`));
  if (news.length) suggestions.push(`Neue Abgrenzungen belegen: ${news.slice(0, 5).join('; ')}${news.length > 5 ? ' …' : ''}.`);
  const gone = accounts.flatMap(a => a.positions.filter(x => x.status === 'entfallen' && Math.abs(x.py) >= 1_000_00).map(x => `${x.label} (VJ CHF ${fmt(x.py)})`));
  if (gone.length) suggestions.push(`Im Vorjahr abgegrenzt, im laufenden Jahr nicht mehr – Vollständigkeit prüfen: ${gone.slice(0, 5).join('; ')}${gone.length > 5 ? ' …' : ''}.`);
  const big = accounts.flatMap(a => a.positions.filter(x => x.status === 'beide' && x.py && Math.abs(x.diff) >= 1_000_00 && Math.abs(x.diff / x.py) >= 0.25).map(x => x.label));
  if (big.length) suggestions.push(`Grosse Veränderungen gegenüber Vorjahr begründen: ${big.slice(0, 5).join('; ')}${big.length > 5 ? ' …' : ''}.`);
  for (const a of accounts) for (const f of a.flags) suggestions.push(`${a.accountNumber}: ${f}`);
  return { available: true, candidates, accounts, totals: { aktiv: tot('aktiv'), passiv: tot('passiv') }, suggestions };
}
