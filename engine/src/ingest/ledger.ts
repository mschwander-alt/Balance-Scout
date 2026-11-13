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
  /** Lage der Zeile auf der Seite (PDF/Scan) – für die Markierung in der Vorschau */
  bbox?: EvidenceLine['bbox'];
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
  /** Datei des Kontoblatts (absoluter Pfad) – für die Vorschau */
  sourcePath?: string;
  /** Kontokopf (Anfang des Kontos im Kontoblatt) */
  head?: { page: number; lineNo: number; bbox?: EvidenceLine['bbox'] };
}

export interface Ledger {
  accounts: LedgerAccount[];
  period: { from: string | null; to: string | null };
  baseCurrency: string;
  warnings: string[];
  /** Herkunft (Dateien) */
  sources?: string[];
  /** Je Datei: erkannte Konten/Buchungen (Diagnose, z. B. „0 Konten“ bei unbekanntem Aufbau) */
  files?: LedgerFileInfo[];
}
export interface LedgerFileInfo {
  filename: string; pages: number; readStatus: string; accounts: number; consistent: number; postings: number;
  from: string | null; to: string | null;
  /** Nur wenn keine Konten erkannt: Aufbau der ersten Zeilen ohne Inhalte (für den anonymen Diagnosebericht) */
  shape?: string[];
}

const KEYWORDS = /^(konto|kontonr\.?|kontonummer|bezeichnung|datum|buchungs-?datum|valuta|beleg|belegnr\.?|belegnummer|text|buchungstext|beschreibung|gegenkonto|gegenkonto bez\.?|gk|soll|haben|saldo|betrag|währung|wahrung|kurs|chf|eur|usd|gbp|vortrag|saldovortrag|anfangssaldo|jahresvortrag|endsaldo|schlusssaldo|total|summe|periode|seite|mwst|laufnr\.?|lfd\.? nr\.?|code|f|a|b|d|k)$/i;
/** Zeile ohne Inhalte beschreiben: Datum/Betrag/Nummer/Text, bekannte Spaltenwörter bleiben stehen */
export function lineShape(text: string): string {
  const tok = (w: string): string => {
    const t = w.replace(/[:;,]$/, '');
    if (KEYWORDS.test(t)) return w;
    if (/^\d{1,2}\.\d{1,2}\.\d{2,4}(\.\.\d{1,2}\.\d{1,2}\.\d{2,4})?$/.test(t)) return t.includes('..') ? 'DATUM..DATUM' : 'DATUM';
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return 'DATUM';
    if (/^-?[\d'’]+[.,]\d{2}-?$/.test(t) || /^-\d+$/.test(t)) return 'BETRAG';
    if (/^\d+$/.test(t)) return `NR${t.length}`;
    if (/^[A-Z]{1,4}-?\d+/.test(t) || /^\d+[-/]\d+$/.test(t)) return 'BELEGNR';
    return /\d/.test(t) ? '9' : 'x';
  };
  const cells = text.includes(' | ') ? text.split(' | ') : [text];
  return cells.map(c => {
    const t = c.trim();
    if (!t) return '';
    if (KEYWORDS.test(t)) return t;
    return t.split(/\s+/).map(tok).join(' ').replace(/\bx( x)+\b/g, 'x…');
  }).join(' | ');
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
/** Zelle mit Kontoart/Kürzel (Abacus „F“, „d+“; Business Central „F“/„A“/„B“/„D“/„K“) – kein Buchungstext */
const CODE_CELL = /^(F|CF|[ABDGK]|d\+?|k\+?)$/;
const postingText = (x: string) => stripContra(x.split(' | ').filter(c => !/^[-\d'’.±]+$/.test(c.trim()) && !/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(c.trim()) && !(x.includes(' | ') && CODE_CELL.test(c.trim()))).join(' ').replace(x.includes(' | ') ? /$^/ : /\s[\d'’.\-]+(\s[\d'’.\-]+)*\s*$/, '').replace(/\s+/g, ' ').trim()).slice(0, 120);
// Hinweis: Bei Excel-Zeilen (Zellen) stehen Beträge in eigenen Zellen – Zahlen am Textende (z. B. „07.-12.“) gehören zum Text.
/** Gegenkonto + Code am Ende entfernen ("… 8510 F", "… 11000 d+") */
const stripContra = (x: string) => x.replace(/\s+\d{4,6}\s+(?:F|CF|d\+?|k\+?|[A-Z]{1,2}\+?)(?:\s+\d{1,8})?\s*$/, '').trim();

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
  // Business Central "Fibukonto – Kontoblatt" (Spalten Belegnr. | Text | Gegenkonto | Gegenkonto Bez.)
  let bcLayout = false;

  // Navision/Business Central druckt einen Saldo von 0.00 nicht; Abacus druckt bei Buchungen ohne Betrag in
  // Fremdwährung den unveränderten Saldo. Ein einzelner Betrag = bisheriger Saldo bedeutet daher je nach System Verschiedenes.
  const hidesZeroBalance = lines.slice(0, 3000).some(l => /endsaldo periode|sachkontenblatt|jahresvortrag/i.test(l.text));
  let curLine: EvidenceLine | null = null;
  const open = (no: string, name: string, page: number) => {
    const k = no;
    let a = accounts.get(k);
    if (!a) {
      a = { accountNumber: no, accountName: name.trim(), currency: pageCurrency ?? baseCurrency, opening: null, closing: null, debitTotal: 0, creditTotal: 0, postings: [], consistent: false, pages: [], source: opts.source ?? '',
        head: curLine && curLine.page === page ? { page, lineNo: curLine.lineNo, bbox: curLine.bbox } : { page, lineNo: 1 } };
      accounts.set(k, a);
    }
    if (pageCurrency) a.currency = pageCurrency;
    if (!a.pages.includes(page)) a.pages.push(page);
    cur = a;
  };

  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li]!;
    curLine = ln;
    const t = ln.text.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const cells = t.includes(' | ');
    if (cells && /gegenkonto bez/i.test(t)) bcLayout = true;
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
    const per = /(?:startdatum:?\s*|\(|periode:?\s*|datumsfilter:?\s*)(\d{1,2}\.\d{1,2}\.\d{2,4})\s*(?:enddatum:?|-|\.\.)\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i.exec(t);
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
    // Business Central "Fibukonto – Kontoblatt": Kopf "1020 | Bezeichnung", Anfangssaldo in der nächsten Zeile
    const bm = !nm && !DATE_AT_START.test(t) ? /^(\d{3,8})(?: \| | {2,})(\D.{1,80})$/.exec(t) : null;
    if (bm && lines.slice(li + 1, li + 4).some(x => OPENING.test(x.text))) { bcLayout = true; open(bm[1]!, bm[2]!.replace(/ \| /g, ' '), ln.page); continue; }
    if (!cur) continue;
    const a = cur as LedgerAccount;
    if (CARRY.test(t)) continue;
    if (TOTALS.test(t) && !OPENING.test(t) && !CLOSING.test(t) && !DATE_AT_START.test(t)) continue;
    const am = amounts(t, cells);
    // Saldovortrag / Schlusssaldo: erster Betrag nach dem Stichwort
    const after = (rx: RegExp) => { const m = rx.exec(t); return m ? amounts(t.slice(m.index + m[0].length), cells) : []; };
    if (OPENING.test(t) && !DATE_AT_START.test(t)) {
      const v = after(OPENING);
      // leerer Anfangssaldo = 0 (Business Central druckt 0.00 nicht)
      if (a.opening === null) a.opening = v.length ? v[0]! : 0;
      continue;
    }
    if (CLOSING.test(t) && !DATE_AT_START.test(t)) {
      // Schlusssaldo: der Wert, der zum letzten laufenden Saldo passt; sonst Soll|Haben|Saldo-Muster; sonst der erste Betrag
      const v = after(CLOSING);
      const last = a.postings.length ? a.postings[a.postings.length - 1]!.balance : a.opening;
      const fit = last !== null && last !== undefined ? v.find(x => Math.abs(x - last) <= 1) : undefined;
      const triple = v.length >= 3 && a.opening !== null && Math.abs(v[2]! - (a.opening + v[0]! - v[1]!)) <= 1 ? v[2] : undefined;
      if (fit !== undefined) a.closing = fit;
      else if (triple !== undefined) a.closing = triple;
      else if (v.length) a.closing = v[0]!;
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
      a.postings.push({ ...last, text: postingText(t) || last.text, contra: null, amount: strict.amount, balance: strict.balance, lineNo: ln.lineNo, page: ln.page, bbox: ln.bbox });
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
      // Gegenkonto: Abacus "69250 F", Business Central "F | 6940" (Kürzel vor der Nummer)
      let contra: string | null;
      let docNo: string | null;
      if (bcLayout && cells) {
        // Business Central: "Datum | Belegnr. | Text | F | 6820 | Bezeichnung | Laufnr. | …" – nur Art F (Fibukonto) ist ein Sachkonto;
        // A = Anlage, B = Bankkonto, D/K = Debitor/Kreditor. Zahlen im Text (z. B. Jahreszahlen) sind kein Gegenkonto.
        const parts = t.split(' | ');
        docNo = parts[1] && /^[^\s]{1,20}$/.test(parts[1]) && !DATE_AT_START.test(parts[1]) ? parts[1] : null;
        const ty = / \| ([A-Z]) \| (\d{3,8})(?= \| |$)/.exec(t);
        contra = ty && ty[1] === 'F' ? ty[2]! : null;
      } else {
        contra = /\b(\d{4,6})(?: \| | )(?:F|CF|d\+?|k\+?|[A-Z]{1,2}\+?)\b/.exec(t.slice(10))?.[1] ?? /(?:^| \| )[FBG](?: \| )(\d{4,6})(?: \| |$)/.exec(t)?.[1] ?? null;
        docNo = /\b(?:F|CF|d\+?|k\+?)(?: \| | )(\d{1,8})\b/.exec(t)?.[1] ?? null;
      }
      // ohne gedruckten Saldo: laufenden Saldo fortschreiben
      if (balance === null && prev !== null && prev !== undefined) balance = prev + amount;
      a.postings.push({ date: iso(dm[1]!, dm[2]!, dm[3]!), text: postingText(t.slice(dm[0].length)), contra, docNo, amount, balance, page: ln.page, lineNo: ln.lineNo, bbox: ln.bbox });
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
