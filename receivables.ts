/**
 * Vertiefte Prüfung Forderungen aus L+L: Offenposten-Liste lesen und Fälligkeitsanalyse per Bilanzstichtag.
 * Formatunabhängig (Abacus, Navision/Business Central, Excel-Exporte): erkennt Kundenblöcke, Posten,
 * Kundentotale und Gesamttotale und gleicht diese gegeneinander ab.
 */
import type { EvidenceLine } from '../ingest/readDocument.js';

export type Cents = number;

export interface OpItem {
  customerNo: string;
  customerName: string;
  docNo: string;
  docType: string;
  /** Beleg-/Buchungsdatum (ISO) – Basis der Fälligkeit, falls keine Fälligkeit angegeben */
  date: string | null;
  /** Fälligkeitsdatum (ISO), falls in der Liste vorhanden */
  dueDate: string | null;
  currency: string;
  /** Offener Betrag in Belegwährung (Gutschriften/Zahlungen negativ) */
  amount: Cents;
  dunningLevel: number | null;
  page: number;
  lineNo: number;
  line: string;
  bbox?: EvidenceLine['bbox'];
}

export interface OpCustomerTotal { customerNo: string; customerName: string; currency: string | null; amount: Cents | null; page: number; lineNo: number; line: string }

export interface OpList {
  items: OpItem[];
  customerTotals: OpCustomerTotal[];
  /** Gesamttotal(e) laut Liste je Währung */
  grandTotals: { currency: string; amount: Cents; line: string }[];
  /** "Saldo per …" laut Liste */
  listDate: string | null;
  baseCurrency: string;
  /** Zeilen, die wie Posten aussehen, aber nicht gelesen werden konnten */
  unreadable: { page: number; lineNo: number; line: string }[];
}

const DATE = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?!\d)/g;
const CUR = /\b(CHF|EUR|USD|GBP|JPY|SEK|NOK|DKK|PLN|CZK|CAD|AUD)\b/;
// Betrag mit 2 Dezimalen, Tausender ' ’ . oder Leerzeichen, Minus vorne oder hinten
// (normales Leerzeichen ist kein Tausendertrenner: "Mahnstufe 1  223.95" darf nicht 1'223.95 ergeben)
const AMOUNT = /(?<![\d.,'’])-?\d{1,3}(?:['’\u00a0\u202f]\d{3})*(?:\.\d{2}|,\d{2})-?(?![\d.])|(?<![\d.,'’])-?\d+(?:\.\d{2}|,\d{2})-?(?![\d.])/g;
const TOTAL = /^(total|gesamt|summe|zwischensumme|gesamtsumme|gesamttotal|übertrag|uebertrag)\b|gesamtsumme|beleg\(e\)/i;
const CREDIT = /gutschrift|zahlung|vorauszahlung|anzahlung|erstattung|storno|haben|\bvz\b|\bgs\b/i;
const TYPE = /\b(Rechnung|Gutschrift|Zahlung|Vorauszahlung|Anzahlung|Erstattung|Mahnung|Zinsen|Storno|Belastung)\b/i;

const iso = (d: string, m: string, y: string) => {
  const yy = y.length === 2 ? `20${y}` : y;
  const mm = Number(m), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};
export function parseCents(raw: string): Cents | null {
  let s = raw.trim();
  const neg = s.startsWith('-') || s.endsWith('-');
  s = s.replace(/^-|-$/g, '').replace(/['’\u00a0\u202f ]/g, '');
  if (/,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}
/** Datum ausblenden (sonst wird "15.12.25" als Betrag 15.12 gelesen) */
const noDates = (t: string) => t.replace(DATE, m => ' '.repeat(m.length));
const amountsIn = (t: string) => [...noDates(t).matchAll(AMOUNT)].map(m => ({ raw: m[0], index: m.index ?? 0, cents: parseCents(m[0]) })).filter(a => a.cents !== null) as { raw: string; index: number; cents: Cents }[];
const datesIn = (t: string) => [...t.matchAll(DATE)].map(m => iso(m[1]!, m[2]!, m[3]!)).filter((x): x is string => !!x);

/** Kopfzeile der Liste: Betragsspalten und Index der massgebenden (offenen) Spalte */
interface Header { amountCols: string[]; openIndex: number; debitCredit: boolean; dueCol: boolean }
function parseHeader(t: string): Header | null {
  const l = t.toLowerCase();
  if (!/(beleg|rechnung|bel\.|datum|buchung)/.test(l) || !/(betrag|op\b|offen|saldo|soll|haben)/.test(l)) return null;
  const cols = [...l.matchAll(/beleg-op|offen(?:er)? betrag|offen|fälliger betrag|beleg-betrag|betrag|saldo|soll|haben/g)].map(m => m[0]);
  if (!cols.length) return null;
  let openIndex = cols.findIndex(c => c === 'beleg-op' || c.startsWith('offen'));
  if (openIndex < 0) openIndex = cols.findIndex(c => c === 'saldo');
  if (openIndex < 0) openIndex = cols.findIndex(c => c === 'betrag' || c === 'beleg-betrag');
  return { amountCols: cols, openIndex: Math.max(0, openIndex), debitCredit: cols.includes('soll') && cols.includes('haben'), dueCol: /fällig(keit)?\s*(datum|am)|fälligkeit\b|due/.test(l) };
}

/** Zeile mit Kundennummer und Name, ohne Datum und ohne Betrag (z. B. "3004 MUSTER", "D000032 Muster AG") */
function customerHeader(t: string): { no: string; name: string } | null {
  if (datesIn(t).length || amountsIn(t).length) return null;
  const m = /^\s*([A-Z]{0,3}\d{2,10}[A-Z]?)\s+(?:-\s+)?(.{2,80})$/.exec(t);
  if (!m || /^(telefon|tel\.|fax|seite|page|e-?mail)/i.test(m[2]!)) return null;
  // PLZ/Ort am Ende abtrennen ("16864 Muster Bau AG 9000 St. Gallen")
  const name = m[2]!.replace(/\s+\d{4,5}\s+[A-ZÄÖÜ][\p{L} .\-]+$/u, '').trim();
  return { no: m[1]!, name };
}

/**
 * Tabellen (Excel, CSV, Word): Zellen sind mit " | " getrennt. Kopfzeile bestimmt die Spalten; jede Zeile ist ein Posten
 * (Kunde je Zeile). Totalzeilen werden als Gesamt- bzw. Kundentotal gelesen.
 */
function parseOpTable(lines: EvidenceLine[], baseCurrency: string): OpList | null {
  const rows = lines.map(l => ({ l, cells: l.text.split(' | ').map(c => c.trim()) }));
  const COL: Record<string, RegExp> = {
    custNo: /^(debitor(en)?(-?nr\.?|nummer)?|kunden?-?nr\.?|kd\.?-?nr\.?|konto)$/i,
    cust: /^(kunde|kundenname|name|debitor(enname)?|firma|bezeichnung)$/i,
    doc: /^(rechnung(s-?nr\.?|snummer)?|beleg(-?nr\.?|nummer)?|re-?nr\.?|dokument)$/i,
    type: /^(belegart|art|typ)$/i,
    date: /^(datum|rechnungsdatum|belegdatum|buchungsdatum|re-?datum|fibu-datum)$/i,
    due: /^(fällig(keit)?(sdatum)?|fällig am|verfall(datum)?|zahlbar bis)$/i,
    open: /^(offen(er betrag)?|op|beleg-op|saldo|restbetrag|offen chf)$/i,
    amount: /^(betrag|betrag chf|rechnungsbetrag|beleg-betrag|total)$/i,
    cur: /^(währung|whg\.?|mw)$/i,
    dunning: /^(mahnstufe|ms|mahn\.?)$/i,
  };
  let hi = -1;
  const map: Record<string, number> = {};
  for (let i = 0; i < Math.min(rows.length, 40) && hi < 0; i++) {
    const m: Record<string, number> = {};
    rows[i]!.cells.forEach((c, j) => { for (const [k, rx] of Object.entries(COL)) if (m[k] === undefined && rx.test(c)) { m[k] = j; break; } });
    if ((m.cust !== undefined || m.custNo !== undefined) && (m.open !== undefined || m.amount !== undefined) && (m.date !== undefined || m.due !== undefined)) { hi = i; Object.assign(map, m); }
  }
  if (hi < 0) return null;
  const amtCol = map.open ?? map.amount!;
  const num = (c: string | undefined) => {
    if (!c) return null;
    const v = c.replace(/[''’\s]/g, '').replace(/^CHF/i, '');
    if (!/^-?\d+([.,]\d{1,2})?-?$/.test(v)) return null;
    return parseCents(/[.,]\d$/.test(v) ? `${v}0` : /[.,]\d{2}-?$/.test(v) ? v : `${v.replace(/-$/, '')}.00${v.endsWith('-') ? '-' : ''}`);
  };
  const items: OpItem[] = [];
  const grandTotals: OpList['grandTotals'] = [];
  const customerTotals: OpCustomerTotal[] = [];
  let listDate: string | null = null;
  for (const { l } of rows.slice(0, hi)) {
    const m = /(?:per|stichtag|saldo am)\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i.exec(l.text);
    if (m) listDate = datesIn(m[1]!)[0] ?? listDate;
  }
  for (const { l, cells } of rows.slice(hi + 1)) {
    const first = cells.find(Boolean) ?? '';
    if (/^(total|gesamt|summe)/i.test(first)) {
      const v = [...cells].reverse().map(num).find(x => x !== null) ?? null;
      if (v !== null) grandTotals.push({ currency: baseCurrency, amount: v, line: l.text });
      continue;
    }
    const amount = num(cells[amtCol]);
    const date = map.date !== undefined ? datesIn(cells[map.date] ?? '')[0] ?? null : null;
    const due = map.due !== undefined ? datesIn(cells[map.due] ?? '')[0] ?? null : null;
    if (amount === null || (!date && !due)) continue;
    const type = map.type !== undefined ? cells[map.type] ?? '' : '';
    items.push({
      customerNo: map.custNo !== undefined ? cells[map.custNo] ?? '' : '', customerName: map.cust !== undefined ? cells[map.cust] ?? '' : '',
      docNo: map.doc !== undefined ? cells[map.doc] ?? '' : '', docType: type || (amount < 0 ? 'Gutschrift' : 'Rechnung'),
      date, dueDate: due, currency: (map.cur !== undefined && CUR.exec(cells[map.cur] ?? '')?.[1]) || baseCurrency,
      amount: CREDIT.test(type) && amount > 0 ? -amount : amount, dunningLevel: map.dunning !== undefined ? Number(cells[map.dunning]) || null : null,
      page: l.page, lineNo: l.lineNo, line: l.text, bbox: l.bbox,
    });
  }
  return { items, customerTotals, grandTotals, listDate, baseCurrency, unreadable: [] };
}

export function parseOpList(lines: EvidenceLine[], opts: { defaultCurrency?: string } = {}): OpList {
  if (lines.filter(l => l.text.includes(' | ')).length >= Math.max(3, lines.length * 0.5)) {
    const t = parseOpTable(lines, opts.defaultCurrency ?? 'CHF');
    if (t && t.items.length) return t;
  }
  const items: OpItem[] = [];
  const customerTotals: OpCustomerTotal[] = [];
  const grandTotals: OpList['grandTotals'] = [];
  const unreadable: OpList['unreadable'] = [];
  let header: Header | null = null;
  let cust: { no: string; name: string } = { no: '', name: '' };
  let listDate: string | null = null;
  let baseCurrency = opts.defaultCurrency ?? 'CHF';
  let inGrand = false;

  // Seitenkopf/-fuss: Zeilen, die (ohne Zahlen) auf vielen Seiten gleich vorkommen, z. B. "10 - Muster Handels AG"
  const pages = new Set(lines.map(l => l.page)).size;
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
  const onPages = new Map<string, Set<number>>();
  for (const l of lines) onPages.set(norm(l.text), (onPages.get(norm(l.text)) ?? new Set()).add(l.page));
  const furniture = (x: string) => pages >= 3 && (onPages.get(norm(x))?.size ?? 0) >= Math.max(3, pages * 0.5) && !/^\s*\d{1,2}\.\d{1,2}\./.test(x);

  for (const ln of lines) {
    // Texterkennung: "20°471.50" / "20`471.50" = 20'471.50
    const t = ln.text.replace(/(\d)[°`´](\d{3})/g, "$1'$2").replace(/[ \t]+/g, ' ').trim();
    if (!t) continue;
    if (furniture(ln.text) && !parseHeader(t)) {
      if (!listDate) listDate = /(?:per|am)\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i.exec(t) ? datesIn(/(?:per|am)\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i.exec(t)![1]!)[0] ?? null : null;
      continue;
    }
    if (!listDate) {
      const m = /(?:saldo (?:per|am)|per|stichtag)\s*(?:buchungsdatum\s*:?\s*)?(\d{1,2}\.\d{1,2}\.\d{2,4})/i.exec(t);
      if (m && /saldo|offen|rückwirkend|per\b/i.test(t)) listDate = datesIn(m[1]!)[0] ?? null;
    }
    if (/alle beträge in (mw|chf)/i.test(t)) baseCurrency = 'CHF';
    const h = parseHeader(t);
    if (h && !datesIn(t).length) { header = h; continue; }
    const dates = datesIn(t);
    const amts = amountsIn(t);
    const cur = CUR.exec(t)?.[1] ?? null;

    // Gesamttotal(e)
    if (/gesamt(total|summe liste)?\b|^gesamt\b|total liste|gesamttotal/i.test(t) && !/debitor(en)?nr|^total \S+ \S*\s*\d+ beleg/i.test(t) && amts.length && !dates.length) {
      inGrand = true;
      grandTotals.push({ currency: cur ?? baseCurrency, amount: pickTotal(amts, header), line: t });
      continue;
    }
    if (inGrand && /beleg\(e\)/i.test(t) && cur && amts.length) { grandTotals.push({ currency: cur, amount: pickTotal(amts, header), line: t }); continue; }

    // Kundentotal
    if (!dates.length && amts.length && (TOTAL.test(t) || (cust.name && t.toLowerCase().startsWith(cust.name.toLowerCase().slice(0, Math.min(8, cust.name.length)))))) {
      customerTotals.push({ customerNo: cust.no, customerName: cust.name, currency: cur, amount: pickTotal(amts, header), page: ln.page, lineNo: ln.lineNo, line: t });
      continue;
    }
    if (!dates.length && TOTAL.test(t) && !amts.length && /\d/.test(t)) {
      // Totalzeile ohne lesbaren Betrag (z. B. Texterkennung "20°471.50")
      customerTotals.push({ customerNo: cust.no, customerName: cust.name, currency: cur, amount: null, page: ln.page, lineNo: ln.lineNo, line: t });
      continue;
    }

    const ch = customerHeader(t);
    if (ch) { cust = ch; continue; }

    // Posten: Datum + Betrag
    if (dates.length && amts.length && header) {
      let amount: Cents;
      // Beträge rechtsbündig den Betragsspalten zuordnen (fehlende Spalten links)
      const cols = header.amountCols.length;
      const offset = Math.max(0, cols - amts.length);
      const idx = header.openIndex - offset;
      if (header.debitCredit) {
        amount = amts[amts.length - 1]!.cents;
        if (CREDIT.test(t) && amount > 0) amount = -amount;
      } else {
        amount = (amts[idx] ?? amts[amts.length - 1]!).cents;
      }
      if (!header.debitCredit && CREDIT.test(t) && amount > 0 && /gutschrift|zahlung/i.test(t)) amount = -amount;
      const firstDateIdx = t.search(DATE);
      const before = t.slice(0, firstDateIdx).trim().split(' ');
      const after = t.slice(firstDateIdx).split(' ');
      const docNo = before.find(x => /\d{3,}/.test(x)) ?? after.find(x => /^[A-Z]{1,4}\d{3,}[A-Z]?$/.test(x)) ?? '';
      const dunning = /\b(?:nein|ja)\s+(\d)\b/i.exec(t);
      items.push({
        customerNo: cust.no, customerName: cust.name, docNo, docType: TYPE.exec(t)?.[1] ?? (/\bVZ\b/.test(t) ? 'Vorauszahlung' : /\bR\b/.test(t) ? 'Rechnung' : ''),
        date: dates[0]!, dueDate: header.dueCol && dates[1] ? dates[1] : null, currency: cur ?? baseCurrency, amount,
        dunningLevel: dunning ? Number(dunning[1]) : null, page: ln.page, lineNo: ln.lineNo, line: t, bbox: ln.bbox,
      });
      continue;
    }
    if (dates.length && header && /rechnung|gutschrift|\bR\b/i.test(t) && !amts.length) unreadable.push({ page: ln.page, lineNo: ln.lineNo, line: t });
  }
  return { items, customerTotals, grandTotals, listDate, baseCurrency, unreadable };
}

function pickTotal(amts: { cents: Cents }[], header: Header | null): Cents {
  if (header && !header.debitCredit && amts.length >= header.amountCols.length) {
    const offset = amts.length - header.amountCols.length;
    return amts[header.openIndex + offset]!.cents;
  }
  if (header && !header.debitCredit && amts.length > 1) {
    const offset = Math.max(0, header.amountCols.length - amts.length);
    return (amts[header.openIndex - offset] ?? amts[amts.length - 1]!).cents;
  }
  return amts[amts.length - 1]!.cents;
}

/** Wahrscheinlich eine OP-Liste? */
export function looksLikeOpList(lines: EvidenceLine[]): boolean {
  const head = lines.slice(0, 60).map(l => l.text).join(' ').toLowerCase();
  if (/kreditor/.test(head) && !/debitor|kunde/.test(head)) return false;
  return /offene?n? (posten|debitorenposten)|\bop[\s-]?liste|debitor(en)?\s*[-–]?\s*offene|offenpost/.test(head);
}

// ------------------------------------------------------------ Fälligkeitsanalyse
export const BUCKETS = ['Nicht fällig', '1–30 Tage', '31–60 Tage', '61–90 Tage', '> 90 Tage'] as const;
export interface AgingParams {
  closingDate: string; // ISO
  termDays: number;
  /** Kurse je Fremdwährung in CHF (z. B. { EUR: 0.93 }) */
  rates: Record<string, number>;
  baseCurrency?: string;
}
export interface AgedItem extends OpItem { due: string | null; daysOverdue: number | null; bucket: number; amountChf: Cents | null }
export interface AgedCustomer { customerNo: string; customerName: string; totalChf: Cents; buckets: Cents[]; credits: Cents; maxDaysOverdue: number; items: number; dunningLevel: number | null }
export interface Aging {
  params: AgingParams;
  items: AgedItem[];
  customers: AgedCustomer[];
  /** Altersklassen – nur offene Rechnungen/Belastungen (positive Posten) */
  buckets: Cents[];
  /** Total = Summe Altersklassen + Gutschriften/Vorauszahlungen */
  totalChf: Cents;
  /** Gutschriften, Vorauszahlungen, nicht zugeordnete Zahlungen (negative Posten, nicht nach Alter verteilt) */
  credits: Cents;
  /** Brutto offene Rechnungen (Summe Altersklassen) */
  grossChf: Cents;
  kpis: { overdue90: Cents; overdue90Share: number; overdueCustomers: number; customers: number; largestOverdue: { customer: string; amount: Cents } | null; avgDaysOverdue: number };
  checks: { name: string; passed: boolean; message: string }[];
  missingRates: string[];
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const bucketOf = (days: number | null) => (days === null || days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4);
const fmt = (c: Cents) => (c / 100).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/’/g, "'");

export function analyzeAging(list: OpList, p: AgingParams): Aging {
  const base = p.baseCurrency ?? list.baseCurrency ?? 'CHF';
  const missing = new Set<string>();
  const rate = (c: string) => (c === base ? 1 : p.rates[c] ?? null);
  const items: AgedItem[] = list.items.map(i => {
    const due = i.dueDate ?? (i.date ? addDays(i.date, p.termDays) : null);
    const days = due ? dayDiff(p.closingDate, due) : null;
    const r = rate(i.currency);
    if (r === null) missing.add(i.currency);
    return { ...i, due, daysOverdue: days, bucket: bucketOf(days), amountChf: r === null ? null : Math.round(i.amount * r) };
  });
  const byCust = new Map<string, AgedCustomer>();
  for (const i of items) {
    const k = `${i.customerNo}|${i.customerName}`;
    const c = byCust.get(k) ?? { customerNo: i.customerNo, customerName: i.customerName, totalChf: 0, buckets: [0, 0, 0, 0, 0], credits: 0, maxDaysOverdue: 0, items: 0, dunningLevel: null };
    const v = i.amountChf ?? 0;
    c.totalChf += v;
    if (v < 0) c.credits += v;
    else c.buckets[i.bucket]! += v;
    c.items++;
    if (v > 0 && (i.daysOverdue ?? 0) > c.maxDaysOverdue) c.maxDaysOverdue = i.daysOverdue ?? 0;
    if (i.dunningLevel !== null) c.dunningLevel = Math.max(c.dunningLevel ?? 0, i.dunningLevel);
    byCust.set(k, c);
  }
  const customers = [...byCust.values()].sort((a, b) => b.totalChf - a.totalChf);
  const buckets = [0, 0, 0, 0, 0];
  for (const i of items) if ((i.amountChf ?? 0) > 0) buckets[i.bucket]! += i.amountChf!;
  const grossChf = buckets.reduce((a, b) => a + b, 0);
  const credits = items.filter(i => (i.amountChf ?? 0) < 0).reduce((a, i) => a + (i.amountChf ?? 0), 0);
  const totalChf = grossChf + credits;
  const overdueItems = items.filter(i => (i.daysOverdue ?? 0) > 0 && i.amount > 0);
  const overdueCusts = customers.filter(c => c.buckets.slice(1).reduce((a, b) => a + b, 0) > 0);
  const largest = [...overdueCusts].sort((a, b) => b.buckets.slice(1).reduce((x, y) => x + y, 0) - a.buckets.slice(1).reduce((x, y) => x + y, 0))[0];
  const wsum = overdueItems.reduce((a, i) => a + (i.amountChf ?? 0), 0);
  const avg = wsum ? overdueItems.reduce((a, i) => a + (i.amountChf ?? 0) * (i.daysOverdue ?? 0), 0) / wsum : 0;

  // Kontrollen: Kundensummen gegen Kundentotale, Summe gegen Gesamttotal, Stichtag der Liste
  const checks: Aging['checks'] = [];
  const sumBy = new Map<string, Cents>();
  for (const i of list.items) sumBy.set(`${i.customerNo}|${i.customerName}`, (sumBy.get(`${i.customerNo}|${i.customerName}`) ?? 0) + i.amount);
  const bad = list.customerTotals.filter(t => t.amount === null || Math.abs((sumBy.get(`${t.customerNo}|${t.customerName}`) ?? 0) - t.amount) > 1);
  if (list.customerTotals.length) checks.push({
    name: 'Kundentotale', passed: bad.length === 0,
    message: bad.length ? `${bad.length} von ${list.customerTotals.length} Kundentotalen weichen von der Summe der Posten ab bzw. sind nicht lesbar (z. B. ${bad.slice(0, 3).map(b => `${b.customerName || b.customerNo}, S. ${b.page}`).join('; ')}).` : `Alle ${list.customerTotals.length} Kundentotale stimmen mit der Summe der Posten überein.`,
  });
  for (const g of list.grandTotals) {
    const s = list.items.filter(i => i.currency === g.currency).reduce((a, i) => a + i.amount, 0);
    checks.push({ name: `Gesamttotal ${g.currency}`, passed: Math.abs(s - g.amount) <= 1, message: `Summe der Posten ${g.currency} ${fmt(s)} · laut Liste ${fmt(g.amount)}${Math.abs(s - g.amount) > 1 ? ` · Differenz ${fmt(s - g.amount)}` : ''}` });
  }
  if (list.listDate) checks.push({ name: 'Stichtag der Liste', passed: list.listDate === p.closingDate, message: list.listDate === p.closingDate ? `OP-Liste per ${fmtD(list.listDate)} = Bilanzstichtag.` : `OP-Liste per ${fmtD(list.listDate)}, Bilanzstichtag ${fmtD(p.closingDate)} – Liste per Bilanzstichtag einholen.` });
  if (list.unreadable.length) checks.push({ name: 'Lesbarkeit', passed: false, message: `${list.unreadable.length} Postenzeile(n) ohne lesbaren Betrag (S. ${[...new Set(list.unreadable.map(u => u.page))].join(', ')}).` });
  if (missing.size) checks.push({ name: 'Fremdwährungskurse', passed: false, message: `Kurs per Stichtag fehlt für ${[...missing].join(', ')} – diese Posten sind in den CHF-Summen nicht enthalten.` });

  return {
    params: p, items, customers, buckets, totalChf, credits, grossChf,
    kpis: {
      overdue90: buckets[4]!, overdue90Share: grossChf ? buckets[4]! / grossChf : 0, overdueCustomers: overdueCusts.length, customers: customers.length,
      largestOverdue: largest ? { customer: largest.customerName || largest.customerNo, amount: largest.buckets.slice(1).reduce((a, b) => a + b, 0) } : null,
      avgDaysOverdue: Math.round(avg),
    },
    checks, missingRates: [...missing],
  };
}
const fmtD = (iso: string) => iso.split('-').reverse().join('.');

/** Vorgeschlagene Feststellungen / nächste Schritte */
export function suggestFindings(a: Aging, balanceChf: Cents | null): string[] {
  const out: string[] = [];
  if (balanceChf !== null) {
    const diff = a.totalChf - balanceChf;
    if (Math.abs(diff) > 100) out.push(`Differenz OP-Liste zu Saldo Forderungen L+L klären (CHF ${fmt(diff)}).`);
  }
  if (a.kpis.overdueCustomers) out.push(`Saldenbestätigungen bzw. Zahlungseingänge nach Stichtag für überfällige Debitoren prüfen (${a.kpis.overdueCustomers} Debitoren).`);
  if (a.buckets[4]) out.push(`Werthaltigkeit der über 90 Tage überfälligen Forderungen beurteilen (CHF ${fmt(a.buckets[4])}, ${(a.kpis.overdue90Share * 100).toFixed(1)} %) – Delkredere angemessen?`);
  if (a.credits) out.push(`Kreditorische Debitoren / Gutschriften prüfen (CHF ${fmt(a.credits)}) – ggf. umgliedern.`);
  for (const c of a.checks.filter(x => !x.passed)) out.push(`${c.name}: ${c.message}`);
  return out;
}

// ------------------------------------------------------------ Einbindung in die Prüfung
export interface ReceivablesParams { docId?: string | null; termDays?: number; rates?: Record<string, number> }
export interface ReceivablesResult {
  candidates: { docId: string; filename: string; relPath: string }[];
  docId: string | null;
  filename: string | null;
  listDate: string | null;
  currencies: string[];
  aging: Aging | null;
  balanceChf: Cents | null;
  balanceAccounts: string;
  suggestions: string[];
}

/** Fälligkeitsanalyse für eine Prüfung: OP-Liste finden (oder gewählte verwenden), analysieren, mit Saldo abstimmen. */
export function receivablesFor(
  res: { documents: { doc: { id: string; filename: string; relPath: string; lines: EvidenceLine[] } }[]; accounts: { accountNumber: string; accountName: string; groupCode: string | null; balanceCurrentYear: number }[]; input: { closingDate: string | null } },
  p: ReceivablesParams,
): ReceivablesResult {
  const candidates = res.documents.filter(d => looksLikeOpList(d.doc.lines)).map(d => ({ docId: d.doc.id, filename: d.doc.filename, relPath: d.doc.relPath }));
  const docId = p.docId ?? candidates[0]?.docId ?? null;
  const doc = res.documents.find(d => d.doc.id === docId);
  // Saldo Forderungen L+L: Konten der Gruppe ohne Delkredere/Wertberichtigung
  const accs = res.accounts.filter(a => a.groupCode === 'A12' && !/delkredere|wertberichtigung|\bwb\b/i.test(a.accountName));
  const balanceChf = accs.length ? accs.reduce((s, a) => s + a.balanceCurrentYear, 0) : null;
  const base = { candidates, docId, filename: doc?.doc.filename ?? null, balanceChf, balanceAccounts: accs.map(a => a.accountNumber).join(', ') };
  if (!doc || !res.input.closingDate) return { ...base, listDate: null, currencies: [], aging: null, suggestions: [] };
  const list = parseOpList(doc.doc.lines);
  const aging = analyzeAging(list, { closingDate: res.input.closingDate, termDays: p.termDays ?? 30, rates: p.rates ?? {} });
  return { ...base, listDate: list.listDate, currencies: [...new Set(list.items.map(i => i.currency))], aging, suggestions: suggestFindings(aging, balanceChf) };
}
