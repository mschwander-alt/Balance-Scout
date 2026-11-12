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
  /** Herkunft bei mehreren Listen */
  sourceDocId?: string;
}

export interface OpCustomerTotal { customerNo: string; customerName: string; currency: string | null; amount: Cents | null; page: number; lineNo: number; line: string; sourceDocId?: string }

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
  /** Tabellen: Zeilen mit Betrag, aber ohne Datum, die nicht als Posten gelesen wurden (z. B. Zwischensummen ohne „Total“) */
  skipped?: { page: number; lineNo: number; line: string }[];
}

const DATE = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?!\d)/g;
const CUR = /\b(CHF|EUR|USD|GBP|JPY|SEK|NOK|DKK|PLN|CZK|CAD|AUD)\b/;
// Betrag mit 2 Dezimalen, Tausender ' ’ . oder Leerzeichen, Minus vorne oder hinten
// (normales Leerzeichen ist kein Tausendertrenner: "Mahnstufe 1  223.95" darf nicht 1'223.95 ergeben)
const AMOUNT = /(?<![\d.,'’])-?\d{1,3}(?:['’\u00a0\u202f]\d{3})*(?:\.\d{2}|,\d{2})-?(?![\d.])|(?<![\d.,'’])-?\d+(?:\.\d{2}|,\d{2})-?(?![\d.])/g;
const TOTAL = /^(total|gesamt|summe|zwischensumme|gesamtsumme|gesamttotal|übertrag|uebertrag)\b|gesamtsumme|beleg\(e\)/i;
const CREDIT = /gutschrift|zahlung|vorauszahlung|anzahlung|erstattung|storno|haben|\bvz\b|\bgs\b/i;
const TYPE = /\b(Rechnung|Gutschrift|Zahlung|Vorauszahlung|Anzahlung|Erstattung|Mahnung|Zinsen|Storno|Belastung)\b/i;

/** Kalenderdatum (ISO) oder null – auch 31.02. oder 31.04. werden abgelehnt (sonst falsche Altersklasse) */
const iso = (d: string, m: string, y: string) => {
  const yy = Number(y.length === 2 ? `20${y}` : y);
  const mm = Number(m), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const t = new Date(Date.UTC(yy, mm - 1, dd));
  if (t.getUTCFullYear() !== yy || t.getUTCMonth() !== mm - 1 || t.getUTCDate() !== dd) return null;
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};
/** Gültiges ISO-Datum (JJJJ-MM-TT)? */
const isIsoDate = (s: string | null | undefined): s is string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  return !!m && iso(m[3]!, m[2]!, m[1]!) === s;
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

/** Datum in einer Tabellenzelle: 15.12.2025, 15.12.25, 15/12/2025, 2025-12-15 (auch mit Uhrzeit) */
export function cellDate(c: string | undefined): string | null {
  const s = (c ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+Z?)?$/.exec(s);
  if (m) return iso(m[3]!, m[2]!, m[1]!);
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})(?:\s+[\d:]+)?$/.exec(s);
  if (m) return iso(m[1]!, m[2]!, m[3]!);
  return null;
}

/**
 * Betrag in einer Tabellenzelle (Rappen). Versteht 1'234.50 · 1’234.50 · 1 234.50 · 1.234,50 · 1,234.50 · 1234,5 ·
 * -500 · 500- · (500.00) · CHF 500 · 500 EUR. Alles andere (Text, Belegnummern, Prozent) → null.
 */
export function cellAmount(c: string | undefined): Cents | null {
  let s = (c ?? '').replace(/[\s  ]/g, '').replace(/^(CHF|EUR|USD|GBP|JPY|SEK|NOK|DKK|PLN|CZK|CAD|AUD)|(CHF|EUR|USD|GBP|JPY|SEK|NOK|DKK|PLN|CZK|CAD|AUD)$/gi, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.+\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^[-−–]/.test(s)) { neg = !neg; s = s.slice(1); } else if (/[-−–]$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
  s = s.replace(/['’]/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const v = Math.round(Number(s) * 100);
  return neg ? -v : v;
}

/**
 * Tabellen (Excel, CSV): Kopfzeile bestimmt die Spalten, jede Zeile mit Betrag ist ein Posten.
 * Spalten werden über `cells` (Position je Spalte, leere Zellen erhalten) zugeordnet; ohne `cells` (ältere Stände)
 * über den Text " | ".
 * - Kunde nur in der ersten Zeile eines Blocks → gilt für die folgenden Zeilen
 * - Liste ohne Datumsspalte → Posten ohne Datum (Fälligkeit muss der Prüfer erfassen)
 * - Totalzeilen nach weiteren Posten bzw. mit dem Namen des Kunden → Kundentotal, übrige am Ende → Gesamttotal
 */
function parseOpTable(lines: EvidenceLine[], baseCurrency: string): OpList | null {
  const rows = lines.map(l => ({ l, cells: (l.cells ?? l.text.split(' | ')).map(c => c.trim()) }));
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
  const headerOf = (cells: string[]) => {
    const m: Record<string, number> = {};
    cells.forEach((c, j) => { for (const [k, rx] of Object.entries(COL)) if (m[k] === undefined && rx.test(c)) { m[k] = j; break; } });
    return (m.cust !== undefined || m.custNo !== undefined) && (m.open !== undefined || m.amount !== undefined) ? m : null;
  };
  // Kopfzeile: Kunde + Betrag; mit Datum/Fälligkeit bevorzugt (sonst Liste ohne Datum)
  let hi = -1;
  let map: Record<string, number> = {};
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const m = headerOf(rows[i]!.cells);
    if (!m) continue;
    const dated = m.date !== undefined || m.due !== undefined;
    if (hi < 0 || dated) { hi = i; map = m; }
    if (dated) break;
  }
  if (hi < 0) return null;
  const hasDates = map.date !== undefined || map.due !== undefined;
  const amtCol = map.open ?? map.amount!;
  const cell = (cells: string[], k: string) => (map[k] !== undefined ? cells[map[k]!] ?? '' : '');
  const items: OpItem[] = [];
  const grandTotals: OpList['grandTotals'] = [];
  const customerTotals: OpCustomerTotal[] = [];
  const unreadable: OpList['unreadable'] = [];
  const skipped: NonNullable<OpList['skipped']> = [];
  const totals: { l: EvidenceLine; amount: Cents; currency: string | null; itemsBefore: number }[] = [];
  let listDate: string | null = null;
  for (const { l } of rows.slice(0, hi)) {
    const m = /(?:per|stichtag|saldo am)\s*(\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2})/i.exec(l.text);
    if (m) listDate = cellDate(m[1]) ?? listDate;
  }
  let cust = { no: '', name: '' };
  for (const { l, cells } of rows.slice(hi + 1)) {
    const first = cells.find(Boolean) ?? '';
    if (/^(übertrag|uebertrag|vortrag)\b/i.test(first)) continue; // Seitenübertrag: weder Posten noch Total
    if (/^(total|gesamt|summe|zwischensumme)/i.test(first)) {
      const v = cellAmount(cells[amtCol]) ?? [...cells].reverse().map(cellAmount).find(x => x !== null) ?? null;
      if (v !== null) totals.push({ l, amount: v, currency: CUR.exec(l.text)?.[1] ?? null, itemsBefore: items.length });
      continue;
    }
    if (headerOf(cells)) continue; // wiederholte Kopfzeile (z. B. je Blatt)
    // Kunde: fehlt er in der Zeile, gilt der Kunde der Zeile davor (gruppierte Exporte)
    const no = cell(cells, 'custNo'), name = cell(cells, 'cust');
    if (no || name) cust = { no, name };
    const rawAmt = cells[amtCol] ?? '';
    const amount = cellAmount(rawAmt);
    const date = cellDate(cell(cells, 'date'));
    const due = cellDate(cell(cells, 'due'));
    if (amount === null) {
      // Zeile mit Datum, aber unlesbarem Betrag → melden statt stillschweigend weglassen
      if ((date || due) && rawAmt) unreadable.push({ page: l.page, lineNo: l.lineNo, line: l.text });
      continue;
    }
    if (amount === 0) continue; // ausgeglichener Posten
    if (hasDates && !date && !due) { skipped.push({ page: l.page, lineNo: l.lineNo, line: l.text }); continue; }
    const type = cell(cells, 'type');
    const curCell = cell(cells, 'cur');
    const dunning = Number(cell(cells, 'dunning'));
    items.push({
      customerNo: cust.no, customerName: cust.name,
      docNo: cell(cells, 'doc'), docType: type || (amount < 0 ? 'Gutschrift' : 'Rechnung'),
      date, dueDate: due, currency: CUR.exec(curCell)?.[1] ?? CUR.exec(rawAmt)?.[1] ?? baseCurrency,
      amount: CREDIT.test(type) && amount > 0 ? -amount : amount, dunningLevel: Number.isFinite(dunning) && dunning > 0 ? dunning : null,
      page: l.page, lineNo: l.lineNo, line: l.text, bbox: l.bbox,
    });
  }
  // Totalzeilen einordnen: vor weiteren Posten bzw. mit Name/Nummer des Kunden davor → Kundentotal, sonst Gesamttotal
  const mentions = (t: string, i: OpItem | undefined) => {
    if (!i) return false;
    const s = t.toLowerCase();
    return (!!i.customerNo && new RegExp(`(^|\\D)${i.customerNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\D|$)`).test(s)) || (!!i.customerName && s.includes(i.customerName.toLowerCase()));
  };
  for (const t of totals) {
    const prev = items[t.itemsBefore - 1];
    if (prev && (t.itemsBefore < items.length || mentions(t.l.text, prev))) {
      customerTotals.push({ customerNo: prev.customerNo, customerName: prev.customerName, currency: t.currency, amount: t.amount, page: t.l.page, lineNo: t.l.lineNo, line: t.l.text });
    } else grandTotals.push({ currency: t.currency ?? baseCurrency, amount: t.amount, line: t.l.text });
  }
  return { items, customerTotals, grandTotals, listDate, baseCurrency, unreadable, skipped };
}

export function parseOpList(lines: EvidenceLine[], opts: { defaultCurrency?: string } = {}): OpList {
  if (lines.filter(l => l.cells || l.text.includes(' | ')).length >= Math.max(3, lines.length * 0.5)) {
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
  /** Hilfe durch den Prüfer: wie die Fälligkeit bestimmt wird (Standard: Fälligkeit laut Liste, sonst Belegdatum + Frist) */
  dueMode?: DueMode;
  /** Zahlungsfrist je Kunde (Schlüssel Kundennummer oder Name) */
  customerTerms?: Record<string, number>;
  /** Korrekturen je Posten (Schlüssel siehe itemKey) */
  corrections?: Record<string, ItemCorrection>;
  /** Stichtag der Liste, falls nicht oder falsch erkannt */
  listDate?: string | null;
}
/** auto = Fälligkeit laut Liste, sonst Belegdatum + Frist · term = immer Belegdatum + Frist · lastDate = letztes Datum der Zeile ist die Fälligkeit */
export type DueMode = 'auto' | 'term' | 'lastDate';
export interface ItemCorrection { due?: string | null; date?: string | null; amount?: Cents; exclude?: boolean; customerName?: string; comment?: string }
export const itemKey = (i: Pick<OpItem, 'sourceDocId' | 'page' | 'lineNo'>) => `${i.sourceDocId ?? ''}|${i.page}|${i.lineNo}`;
export interface AgedItem extends OpItem {
  due: string | null; daysOverdue: number | null; bucket: number; amountChf: Cents | null;
  key: string;
  /** Herleitung der Fälligkeit, z. B. „Fälligkeit laut Liste“, „Belegdatum + 30 Tage“, „manuell“ */
  dueWhy: string;
  /** vom Prüfer korrigiert */
  corrected: boolean;
  comment?: string;
}
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
  /** vom Prüfer ausgeschlossene Posten (nicht in den Summen) */
  excluded: AgedItem[];
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const bucketOf = (days: number | null) => (days === null || days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4);
const fmt = (c: Cents) => (c / 100).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/’/g, "'");

export function analyzeAging(list: OpList, p: AgingParams): Aging {
  const base = p.baseCurrency ?? list.baseCurrency ?? 'CHF';
  const missing = new Set<string>();
  const rate = (c: string) => (c === base ? 1 : p.rates[c] ?? null);
  const mode = p.dueMode ?? 'auto';
  const all: AgedItem[] = list.items.map(i0 => {
    const key = itemKey(i0);
    const c = p.corrections?.[key];
    const i = { ...i0, ...(c?.customerName ? { customerName: c.customerName } : {}), ...(c?.amount !== undefined ? { amount: c.amount } : {}), ...(c?.date !== undefined ? { date: c.date } : {}) };
    const term = p.customerTerms?.[i.customerNo] ?? p.customerTerms?.[i.customerName] ?? p.termDays;
    const lineDates = [...i.line.matchAll(DATE)].map(m => iso(m[1]!, m[2]!, m[3]!)).filter((x): x is string => !!x);
    let due: string | null; let dueWhy: string;
    if (c?.due !== undefined) { due = isIsoDate(c.due) ? c.due : null; dueWhy = due ? 'manuell erfasst' : 'manuell erfasste Fälligkeit ungültig – bitte erfassen'; }
    else if (mode === 'lastDate' && lineDates.length >= 2) { due = lineDates[lineDates.length - 1]!; dueWhy = 'letztes Datum der Zeile (Vorgabe Prüfer)'; }
    else if (mode !== 'term' && i.dueDate) { due = i.dueDate; dueWhy = 'Fälligkeit laut Liste'; }
    else if (isIsoDate(i.date)) { due = addDays(i.date, term); dueWhy = `Belegdatum + ${term} Tage${term !== p.termDays ? ' (Frist des Kunden)' : ''}`; }
    else { due = null; dueWhy = 'kein Datum – bitte erfassen'; }
    const days = due ? dayDiff(p.closingDate, due) : null;
    const r = rate(i.currency);
    if (r === null && !c?.exclude) missing.add(i.currency);
    return { ...i, key, due, dueWhy, corrected: !!c, comment: c?.comment, daysOverdue: days, bucket: bucketOf(days), amountChf: r === null ? null : Math.round(i.amount * r) };
  });
  const excludedItems = all.filter(i => p.corrections?.[i.key]?.exclude);
  const items = all.filter(i => !p.corrections?.[i.key]?.exclude);
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
  // je Liste: derselbe Kunde kann in mehreren Listen (z. B. Inland/Ausland) mit je eigenem Kundentotal stehen
  const custKey = (x: { sourceDocId?: string; customerNo: string; customerName: string }) => `${x.sourceDocId ?? ''}|${x.customerNo}|${x.customerName}`;
  const sumBy = new Map<string, Cents>();
  for (const i of list.items) sumBy.set(custKey(i), (sumBy.get(custKey(i)) ?? 0) + i.amount);
  const bad = list.customerTotals.filter(t => t.amount === null || Math.abs((sumBy.get(custKey(t)) ?? 0) - t.amount) > 1);
  if (list.customerTotals.length) checks.push({
    name: 'Kundentotale', passed: bad.length === 0,
    message: bad.length ? `${bad.length} von ${list.customerTotals.length} Kundentotalen weichen von der Summe der Posten ab bzw. sind nicht lesbar (z. B. ${bad.slice(0, 3).map(b => `${b.customerName || b.customerNo}, S. ${b.page}`).join('; ')}).` : `Alle ${list.customerTotals.length} Kundentotale stimmen mit der Summe der Posten überein.`,
  });
  for (const g of list.grandTotals) {
    const s = list.items.filter(i => i.currency === g.currency).reduce((a, i) => a + i.amount, 0);
    checks.push({ name: `Gesamttotal ${g.currency}`, passed: Math.abs(s - g.amount) <= 1, message: `Summe der Posten ${g.currency} ${fmt(s)} · laut Liste ${fmt(g.amount)}${Math.abs(s - g.amount) > 1 ? ` · Differenz ${fmt(s - g.amount)}` : ''}` });
  }
  const ld = p.listDate ?? list.listDate;
  if (ld) checks.push({ name: 'Stichtag der Liste', passed: ld === p.closingDate, message: (ld === p.closingDate ? `OP-Liste per ${fmtD(ld)} = Bilanzstichtag.` : `OP-Liste per ${fmtD(ld)}, Bilanzstichtag ${fmtD(p.closingDate)} – Liste per Bilanzstichtag einholen.`) + (p.listDate ? ' (Stichtag vom Prüfer erfasst)' : '') });
  else checks.push({ name: 'Stichtag der Liste', passed: false, message: 'Stichtag der OP-Liste nicht erkannt – bitte unter „Hilfe zur Liste“ erfassen.' });
  const noDue = items.filter(i => !i.due && i.amount > 0);
  if (noDue.length) checks.push({ name: 'Fälligkeit', passed: false, message: `${noDue.length} Posten ohne Datum – Fälligkeit je Posten erfassen (Einzelposten).` });
  const corr = all.filter(i => i.corrected);
  if (corr.length) checks.push({ name: 'Korrekturen Prüfer', passed: true, message: `${corr.length} Posten vom Prüfer korrigiert${excludedItems.length ? `, davon ${excludedItems.length} ausgeschlossen (CHF ${fmt(excludedItems.reduce((a, i) => a + (i.amountChf ?? 0), 0))})` : ''} – in der Dokumentation ausgewiesen.` });
  // Plausibilität: Fälligkeit vor Belegdatum bzw. sehr lange Frist deutet auf vertauschte Spalten hin
  const odd = items.filter(i => i.date && i.due && (i.due < i.date || dayDiff(i.due, i.date) > 180));
  if (odd.length) checks.push({ name: 'Plausibilität Fälligkeit', passed: false, message: `${odd.length} Posten mit Fälligkeit vor dem Belegdatum oder mehr als 180 Tage danach – Datumsspalten prüfen (Hilfe zur Liste: „Fälligkeit bestimmen“).` });
  if (list.skipped?.length) {
    // Stimmt das Gesamttotal, sind es Zwischensummen; sonst fehlen evtl. Posten
    const totalOk = list.grandTotals.length > 0 && checks.filter(c => c.name.startsWith('Gesamttotal')).every(c => c.passed);
    checks.push({ name: 'Zeilen ohne Datum', passed: totalOk, message: `${list.skipped.length} Zeile(n) mit Betrag, aber ohne Datum nicht als Posten gelesen (z. B. Zeile ${list.skipped.slice(0, 3).map(s => s.lineNo).join(', ')})${totalOk ? ' – Gesamttotal stimmt, vermutlich Zwischensummen.' : ' – prüfen, ob Posten fehlen.'}` });
  }
  if (list.unreadable.length) checks.push({ name: 'Lesbarkeit', passed: false, message: `${list.unreadable.length} Postenzeile(n) ohne lesbaren Betrag (S. ${[...new Set(list.unreadable.map(u => u.page))].join(', ')}).` });
  if (missing.size) checks.push({ name: 'Fremdwährungskurse', passed: false, message: `Kurs per Stichtag fehlt für ${[...missing].join(', ')} – diese Posten sind in den CHF-Summen nicht enthalten.` });

  return {
    params: p, items, customers, buckets, totalChf, credits, grossChf,
    kpis: {
      overdue90: buckets[4]!, overdue90Share: grossChf ? buckets[4]! / grossChf : 0, overdueCustomers: overdueCusts.length, customers: customers.length,
      largestOverdue: largest ? { customer: largest.customerName || largest.customerNo, amount: largest.buckets.slice(1).reduce((a, b) => a + b, 0) } : null,
      avgDaysOverdue: Math.round(avg),
    },
    checks, missingRates: [...missing], excluded: excludedItems,
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
export interface ReceivablesParams {
  /** Gewählte OP-Liste(n); ohne Angabe: alle Belege, die Konten der Forderungen L+L zugeordnet sind */
  docIds?: string[] | null;
  /** @deprecated einzelne Liste */
  docId?: string | null;
  /** Konten für die Abstimmung; ohne Angabe: Konten, denen die Listen zugeordnet sind (ohne Delkredere) */
  accounts?: string[] | null;
  termDays?: number;
  rates?: Record<string, number>;
  dueMode?: DueMode;
  customerTerms?: Record<string, number>;
  corrections?: Record<string, ItemCorrection>;
  listDate?: string | null;
}
export interface ReceivablesResult {
  /** Belege, die Konten der Forderungen L+L zugeordnet sind */
  candidates: { docId: string; filename: string; relPath: string; accounts: string[]; looksLikeOpList: boolean }[];
  docIds: string[];
  /** @deprecated */
  docId: string | null;
  filename: string | null;
  lists: { docId: string; filename: string; items: number; listDate: string | null }[];
  listDate: string | null;
  currencies: string[];
  aging: Aging | null;
  balanceChf: Cents | null;
  balanceAccounts: string;
  accountOptions: { accountNumber: string; accountName: string; balance: Cents }[];
  suggestions: string[];
}

type ResLike = {
  documents: { doc: { id: string; filename: string; relPath: string; lines: EvidenceLine[] }; assignedAccounts?: string[] }[];
  accounts: { accountNumber: string; accountName: string; groupCode: string | null; balanceCurrentYear: number }[];
  input: { closingDate: string | null };
};

/** Fälligkeitsanalyse: nur Belege, die (nach der Durchsicht) Konten der Forderungen L+L zugeordnet sind. */
export function receivablesFor(res: ResLike, p: ReceivablesParams, assignedOverride?: Record<string, string[]>): ReceivablesResult {
  const group = res.accounts.filter(a => a.groupCode === 'A12');
  const groupNums = new Set(group.map(a => a.accountNumber));
  const assignedOf = (d: ResLike['documents'][number]) => assignedOverride?.[d.doc.id] ?? d.assignedAccounts ?? [];
  const candidates = res.documents
    .map(d => ({ d, accounts: assignedOf(d).filter(n => groupNums.has(n)) }))
    .filter(x => x.accounts.length)
    .map(x => ({ docId: x.d.doc.id, filename: x.d.doc.filename, relPath: x.d.doc.relPath, accounts: x.accounts, looksLikeOpList: looksLikeOpList(x.d.doc.lines) }));
  const docIds = p.docIds?.length ? p.docIds : p.docId ? [p.docId] : candidates.filter(c => c.looksLikeOpList).map(c => c.docId);
  const docs = docIds.map(id => res.documents.find(d => d.doc.id === id)).filter((d): d is ResLike['documents'][number] => !!d);
  const isWb = (name: string) => /delkredere|wertberichtigung|\bwb\b/i.test(name);
  // Abstimmung: gewählte Konten, sonst die Konten, denen die Listen zugeordnet sind, sonst alle Konten der Gruppe
  const fromDocs = [...new Set(docs.flatMap(d => assignedOf(d).filter(n => groupNums.has(n))))];
  const accNums = p.accounts?.length ? p.accounts : fromDocs.length ? fromDocs : group.map(a => a.accountNumber);
  const accs = group.filter(a => accNums.includes(a.accountNumber) && !isWb(a.accountName));
  const balanceChf = accs.length ? accs.reduce((s, a) => s + a.balanceCurrentYear, 0) : null;
  const base = {
    candidates, docIds: docs.map(d => d.doc.id), docId: docs[0]?.doc.id ?? null, filename: docs.map(d => d.doc.filename).join(', ') || null,
    balanceChf, balanceAccounts: accs.map(a => a.accountNumber).join(', '),
    accountOptions: group.filter(a => !isWb(a.accountName)).map(a => ({ accountNumber: a.accountNumber, accountName: a.accountName, balance: a.balanceCurrentYear })),
  };
  if (!docs.length || !res.input.closingDate) return { ...base, lists: [], listDate: null, currencies: [], aging: null, suggestions: [] };
  // Mehrere Listen (z. B. Inland/Ausland) werden zusammengeführt; Kontrollen je Liste bleiben erhalten
  const parsed = docs.map(d => ({ d, list: parseOpList(d.doc.lines) }));
  const merged: OpList = {
    items: parsed.flatMap(x => x.list.items.map(i => ({ ...i, sourceDocId: x.d.doc.id }))),
    customerTotals: parsed.flatMap(x => x.list.customerTotals.map(t => ({ ...t, sourceDocId: x.d.doc.id }))),
    grandTotals: parsed.length === 1 ? parsed[0]!.list.grandTotals : [],
    listDate: parsed.map(x => x.list.listDate).find(Boolean) ?? null,
    baseCurrency: parsed[0]!.list.baseCurrency,
    unreadable: parsed.flatMap(x => x.list.unreadable),
    skipped: parsed.flatMap(x => x.list.skipped ?? []),
  };
  const aging = analyzeAging(merged, { closingDate: res.input.closingDate, termDays: p.termDays ?? 30, rates: p.rates ?? {}, dueMode: p.dueMode, customerTerms: p.customerTerms, corrections: p.corrections, listDate: p.listDate || null });
  if (parsed.length > 1) {
    for (const x of parsed) for (const g of x.list.grandTotals) {
      const s = x.list.items.filter(i => i.currency === g.currency).reduce((a, i) => a + i.amount, 0);
      aging.checks.push({ name: `Gesamttotal ${x.d.doc.filename} ${g.currency}`, passed: Math.abs(s - g.amount) <= 1, message: `Summe der Posten ${g.currency} ${fmt(s)} · laut Liste ${fmt(g.amount)}` });
    }
  }
  for (const x of parsed) if (!x.list.items.length) aging.checks.push({ name: `Liste ${x.d.doc.filename}`, passed: false, message: `${x.d.doc.filename}: keine offenen Posten erkannt – ist das eine OP-Liste?` });
  return {
    ...base, lists: parsed.map(x => ({ docId: x.d.doc.id, filename: x.d.doc.filename, items: x.list.items.length, listDate: x.list.listDate })),
    listDate: p.listDate || merged.listDate, currencies: [...new Set(merged.items.map(i => i.currency))], aging, suggestions: suggestFindings(aging, balanceChf),
  };
}
