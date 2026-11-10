/**
 * Kontoblätter (Sachkontenblätter) lesen: Abacus, Navision/Business Central und ähnliche – PDF mit Textebene
 * oder Excel. Je Konto: Nummer, Bezeichnung, Währung, Saldovortrag, Buchungen, Schlusssaldo, Kontrolle.
 * Kontoblätter sind interne Buchhaltung, KEIN Nachweis – sie dienen der Fremdwährung, dem Anlagespiegel usw.
 */
import type { EvidenceLine } from './readDocument.js';

export type Cents = number;

export interface LedgerPosting {
  date: string; // ISO
  text: string;
  /** Gegenkonto, falls im Kontoblatt angegeben (Abacus) */
  contra: string | null;
  docNo: string | null;
  /** Bewegung in Kontowährung: + Soll, − Haben */
  amount: Cents;
  balance: Cents | null;
  page: number;
  lineNo: number;
}

export interface LedgerAccount {
  accountNumber: string;
  accountName: string;
  /** Kontowährung (CHF oder Fremdwährung laut Kontoblatt) */
  currency: string;
  opening: Cents | null;
  closing: Cents | null;
  debitTotal: Cents;
  creditTotal: Cents;
  postings: LedgerPosting[];
  /** Saldovortrag + Buchungen = Schlusssaldo? */
  consistent: boolean;
  pages: number[];
  source: string;
}

export interface Ledger {
  accounts: LedgerAccount[];
  period: { from: string | null; to: string | null };
  baseCurrency: string;
  warnings: string[];
  /** Herkunft (Dateien) */
  sources?: string[];
}

const CURRENCIES = 'CHF|EUR|USD|GBP|JPY|CAD|AUD|SEK|NOK|DKK|PLN|CZK|HUF|CNY|HKD|SGD|NZD|TRY|ZAR|BRL|MXN|INR';
const DATE_AT_START = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/;
const DATE_ANY = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?!\d)/g;
// Beträge mit 2 Dezimalen; in Excel-Zeilen auch ganze Zahlen als eigene Zelle
const AMT = /(?<![\d.'’])-?\d{1,3}(?:['’\u00a0\u202f]\d{3})*\.\d{2}-?(?![\d.])|(?<![\d.'’])-?\d+\.\d{2}-?(?![\d.])/g;

const iso = (d: string, m: string, y: string) => `${y.length === 2 ? `20${y}` : y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
function cents(raw: string): Cents | null {
  const neg = /^-|-$/.test(raw.trim());
  const n = Number(raw.trim().replace(/^-|-$/g, '').replace(/['’\u00a0\u202f ]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) * (neg ? -1 : 1) : null;
}
/** Beträge einer Zeile – bei Excel (" | ") auch Zellen mit ganzen Zahlen; Datumsangaben ausgeblendet */
function amounts(t: string, cells: boolean): Cents[] {
  if (cells) {
    return t.split(' | ').map(c => c.trim()).filter(c => /^-?\d+(?:\.\d{1,2})?$/.test(c))
      .map(c => cents(/\.\d$/.test(c) ? `${c}0` : c)).filter((x): x is Cents => x !== null);
  }
  return [...t.replace(DATE_ANY, m => ' '.repeat(m.length)).matchAll(AMT)].map(m => cents(m[0])).filter((x): x is Cents => x !== null);
}

/** Buchungstext ohne Zahlenkolonnen und Datum */
const postingText = (x: string) => x.split(' | ').filter(c => !/^[-\d'’.±]+$/.test(c.trim()) && !/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(c.trim())).join(' ').replace(/\s[\d'’.\-]+(\s[\d'’.\-]+)*\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 120);

/** Bewegung finden, die zum vorherigen Saldo passt: Soll|Haben|Saldo oder Betrag|Saldo */
function matchMove(am: Cents[], prev: Cents): { amount: Cents; balance: Cents } | null {
  const near = (x: number, y: number) => Math.abs(x - y) <= 1;
  for (let i = 0; i + 2 < am.length; i++) if (near(am[i + 2]!, prev + am[i]! - am[i + 1]!) && (am[i] !== 0 || am[i + 1] !== 0)) return { amount: am[i]! - am[i + 1]!, balance: am[i + 2]! };
  for (let i = 0; i + 1 < am.length; i++) {
    if (am[i] === 0) continue;
    if (near(am[i + 1]!, prev + am[i]!)) return { amount: am[i]!, balance: am[i + 1]! };
    if (near(am[i + 1]!, prev - am[i]!)) return { amount: -am[i]!, balance: am[i + 1]! };
  }
  return null;
}

const OPENING = /\b(saldovortrag|jahresvortrag|anfangssaldo|anfangsbestand|eröffnungssaldo|eroeffnungssaldo|saldo vortrag|vortrag)\b/i;
const CLOSING = /\b(saldo buchungsjahr|endsaldo( periode)?|schlusssaldo|saldo per|endbestand|schlussbestand)\b/i;
const CARRY = /\b(übertrag|uebertrag|transport)\b/i;
/** Summen-/Verkehrszahlenzeilen – keine Buchungen */
const TOTALS = /^(saldo\b|summe|total|verkehrszahlen)|\bvkz\b|\bperiode\b|^\S+(?: \| | )vkz/i;

/** Sieht das Dokument wie ein Kontoblatt aus? */
export function looksLikeLedger(lines: EvidenceLine[]): boolean {
  const head = lines.slice(0, 120).map(l => l.text).join(' ').toLowerCase();
  if (/(sachkontenblatt|kontoblatt|kontenblatt|detail nach belegdatum)/.test(head)) return true;
  // Mehrere verschiedene Kontoköpfe ("Konto 10020 …" bzw. "10300 Bank … Jahresvortrag") – ein Bankauszug hat das nicht
  const heads = new Set<string>();
  for (const l of lines.slice(0, 5000)) {
    const m = /^konto\s+(\d{4,8})\s+\S/i.exec(l.text) ?? /^(\d{4,8})(?: \| | ).+\b(?:jahresvortrag|saldovortrag)\b/i.exec(l.text);
    if (m) heads.add(m[1]!);
  }
  if (heads.size >= 3) return true;
  // Excel mit einem Blatt je Konto: mehrfach Saldovortrag UND Schlusssaldo ("Saldo Buchungsjahr", "Endsaldo")
  const opening = lines.filter(l => /^(saldovortrag|jahresvortrag)\b/i.test(l.text.trim())).length;
  const closing = lines.filter(l => /^(saldo buchungsjahr|endsaldo)/i.test(l.text.trim())).length;
  return opening >= 3 && closing >= 3;
}

export function parseLedger(lines: EvidenceLine[], opts: { pageLabels?: Record<number, string>; source?: string } = {}): Ledger {
  const accounts = new Map<string, LedgerAccount>();
  const warnings: string[] = [];
  let cur: LedgerAccount | null = null;
  let pageCurrency: string | null = null;
  let lastPage = -1;
  let baseCurrency = 'CHF';
  let from: string | null = null;
  let to: string | null = null;

  // Navision/Business Central druckt einen Saldo von 0.00 nicht; Abacus druckt bei Buchungen ohne Betrag in
  // Fremdwährung den unveränderten Saldo. Ein einzelner Betrag = bisheriger Saldo bedeutet daher je nach System Verschiedenes.
  const hidesZeroBalance = lines.slice(0, 3000).some(l => /endsaldo periode|sachkontenblatt|jahresvortrag/i.test(l.text));
  const open = (no: string, name: string, page: number) => {
    const k = no;
    let a = accounts.get(k);
    if (!a) {
      a = { accountNumber: no, accountName: name.trim(), currency: pageCurrency ?? baseCurrency, opening: null, closing: null, debitTotal: 0, creditTotal: 0, postings: [], consistent: false, pages: [], source: opts.source ?? '' };
      accounts.set(k, a);
    }
    if (pageCurrency) a.currency = pageCurrency;
    if (!a.pages.includes(page)) a.pages.push(page);
    cur = a;
  };

  for (const ln of lines) {
    const t = ln.text.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const cells = t.includes(' | ');
    if (ln.page !== lastPage) {
      lastPage = ln.page;
      pageCurrency = null;
      // Excel: ein Blatt je Konto, Blattname z. B. "_10020_Kasse_EUR"
      const label = opts.pageLabels?.[ln.page] ?? '';
      const lm = /(?:^|[_ '])(\d{4,6})[_ ]([^']+)/.exec(label.replace(/^Blatt\s*'?/, ''));
      if (lm) open(lm[1]!, lm[2]!.replace(/_/g, ' ').replace(/'$/, ''), ln.page);
    }
    // Berichtswährung / Zeitraum
    const bw = new RegExp(`berichtswährung:?\\s*(${CURRENCIES})`, 'i').exec(t);
    if (bw) baseCurrency = bw[1]!.toUpperCase();
    const per = /(?:startdatum:?\s*|\()(\d{1,2}\.\d{1,2}\.\d{4})\s*(?:enddatum:?|-)\s*(\d{1,2}\.\d{1,2}\.\d{4})/i.exec(t);
    if (per && !from) {
      const [a, b] = [per[1]!, per[2]!].map(x => x.split('.'));
      from = iso(a![0]!, a![1]!, a![2]!);
      to = iso(b![0]!, b![1]!, b![2]!);
    }
    // Währung des Kontos: "Währung EUR" (Abacus Kopf) bzw. Spalten "EUR Soll / EUR Saldo"
    const wm = new RegExp(`\\bwährung\\s+(${CURRENCIES})\\b`, 'i').exec(t) ?? new RegExp(`\\b(${CURRENCIES})\\s+(soll|haben|saldo)\\b`, 'i').exec(t);
    if (wm && !/berichtswährung/i.test(t)) {
      pageCurrency = wm[1]!.toUpperCase();
      if (cur) (cur as LedgerAccount).currency = pageCurrency;
    }
    // Kontokopf: "Konto 10020 Kasse EUR" (Abacus) bzw. "10300 AEK Bank 1826 Jahresvortrag 363’268.59" (Navision)
    const km = /^konto\s+(\d{3,8})\s+(.+)$/i.exec(t);
    if (km) { open(km[1]!, km[2]!.split(' | ')[0]!, ln.page); continue; }
    const nm = /^(\d{4,8})(?: \| | )(.+?)(?: \| | )(jahresvortrag|saldovortrag|anfangssaldo)\b/i.exec(t);
    if (nm) open(nm[1]!, nm[2]!.replace(/ \| /g, ' '), ln.page);
    if (!cur) continue;
    const a = cur as LedgerAccount;
    if (CARRY.test(t)) continue;
    if (TOTALS.test(t) && !OPENING.test(t) && !CLOSING.test(t) && !DATE_AT_START.test(t)) continue;
    const am = amounts(t, cells);
    // Saldovortrag / Schlusssaldo: erster Betrag nach dem Stichwort
    const after = (rx: RegExp) => { const m = rx.exec(t); return m ? amounts(t.slice(m.index + m[0].length), cells) : []; };
    if (OPENING.test(t) && !DATE_AT_START.test(t)) {
      const v = after(OPENING);
      if (a.opening === null) a.opening = v.length ? v[0]! : /\b0\b/.test(t) ? 0 : null;
      continue;
    }
    if (CLOSING.test(t) && !DATE_AT_START.test(t)) {
      const v = after(CLOSING);
      if (v.length) a.closing = v[0]!;
      continue;
    }
    // Buchung: beginnt mit Datum, mind. Betrag + Saldo (bei Excel-Zellen ggf. nur Betrag)
    const dm = DATE_AT_START.exec(t);
    // Laufender Saldo (auch wenn im Kontoblatt nicht gedruckt)
    const prev = a.postings.length ? a.postings[a.postings.length - 1]!.balance : a.opening;
    let strict = prev !== null && prev !== undefined ? matchMove(am, prev) : null;
    // Navision druckt einen Saldo von 0.00 nicht: einzelner Betrag, der den Saldo genau auf null bringt
    if (!strict && !cells && dm && prev !== null && prev !== undefined && am.length === 1 && am[0] !== 0 && (hidesZeroBalance || Math.abs(am[0]! - prev) > 1)) {
      if (Math.abs(prev + am[0]!) <= 1) strict = { amount: am[0]!, balance: 0 };
      else if (Math.abs(prev - am[0]!) <= 1) strict = { amount: -am[0]!, balance: 0 };
    }
    // Folgezeile ohne Datum, die den Saldo verändert (z. B. MWST-Aufteilung bei Abacus): nur bei exakt passender Saldokette
    if (!dm && strict && strict.amount !== 0 && a.postings.length && !OPENING.test(t) && !CLOSING.test(t)) {
      const last = a.postings[a.postings.length - 1]!;
      a.postings.push({ ...last, text: postingText(t) || last.text, contra: null, amount: strict.amount, balance: strict.balance, lineNo: ln.lineNo, page: ln.page });
      continue;
    }
    if (dm && am.length >= 1) {
      let amount: Cents | null = strict?.amount ?? null;
      let balance: Cents | null = strict?.balance ?? null;
      // nur der unveränderte Saldo (z. B. Kursdifferenz ohne Betrag in Fremdwährung)
      if (amount === null && prev !== null && prev !== undefined && am.some(x => Math.abs(x - prev) <= 1) && am.length <= 2) { amount = 0; balance = prev; }
      // Excel: Wiedereinstieg, wenn die Zeile den vorherigen Saldo selbst enthält (Navision: Soll|Haben|Saldo|…|Vorsaldo)
      if (amount === null && cells) {
        for (let i = 0; i + 2 < am.length && amount === null; i++) {
          const before = am[i + 2]! - am[i]! + am[i + 1]!;
          if ((am[i] !== 0 || am[i + 1] !== 0) && am.some((x, j) => j > i + 2 && Math.abs(x - before) <= 1)) { amount = am[i]! - am[i + 1]!; balance = am[i + 2]!; }
        }
        if (amount === null) continue; // ohne passende Saldokette keine Buchung (Zellen enthalten auch Konto-/Belegnummern)
      }
      if (amount === null) {
        balance = am.length >= 2 ? am[am.length - 1]! : null;
        amount = am.length >= 2 ? am[am.length - 2]! : am[0]!;
        if (prev !== null && prev !== undefined && balance !== null) amount = balance - prev;
      }
      if (amount === 0) continue;
      const contra = /\b(\d{4,6})(?: \| | )(?:F|CF|d\+?|k\+?|[A-Z]{1,2}\+?)\b/.exec(t.slice(10))?.[1] ?? null;
      const docNo = /\b(?:F|CF|d\+?|k\+?)(?: \| | )(\d{1,8})\b/.exec(t)?.[1] ?? null;
      // ohne gedruckten Saldo: laufenden Saldo fortschreiben
      if (balance === null && prev !== null && prev !== undefined) balance = prev + amount;
      a.postings.push({ date: iso(dm[1]!, dm[2]!, dm[3]!), text: postingText(t.slice(dm[0].length)), contra, docNo, amount, balance, page: ln.page, lineNo: ln.lineNo });
      if (!a.pages.includes(ln.page)) a.pages.push(ln.page);
    }
  }

  for (const a of accounts.values()) {
    a.debitTotal = a.postings.filter(p => p.amount > 0).reduce((s, p) => s + p.amount, 0);
    a.creditTotal = -a.postings.filter(p => p.amount < 0).reduce((s, p) => s + p.amount, 0);
    const calc = (a.opening ?? 0) + a.debitTotal - a.creditTotal;
    if (a.closing === null) a.closing = a.postings.length ? a.postings[a.postings.length - 1]!.balance ?? calc : a.opening;
    a.consistent = a.closing !== null && Math.abs(calc - a.closing) <= 1;
  }
  const list = [...accounts.values()].sort((x, y) => x.accountNumber.localeCompare(y.accountNumber, 'de', { numeric: true }));
  const bad = list.filter(a => !a.consistent);
  if (bad.length) warnings.push(`${bad.length} von ${list.length} Konten: Saldovortrag + Buchungen ergeben nicht den Schlusssaldo (z. B. ${bad.slice(0, 3).map(b => b.accountNumber).join(', ')}).`);
  return { accounts: list, period: { from, to }, baseCurrency, warnings };
}
