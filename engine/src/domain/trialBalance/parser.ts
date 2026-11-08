import Papa from 'papaparse';
import { parseAmount, type Cents } from '../amount.js';

export type Cell = string | number | null;
export type Grid = Cell[][];

export interface ColumnMapping {
  accountNumber: number;
  accountName: number;
  /** Saldo-Spalte; fehlt sie, wird der Saldo aus Soll − Haben berechnet */
  balanceCurrentYear?: number;
  balancePreviousYear?: number;
  balanceForeignCurrency?: number;
  balanceDebit?: number;
  balanceCredit?: number;
}

export interface TrialBalanceRow {
  rowIndex: number; // 1-basiert, wie in Excel
  accountNumber: string;
  accountName: string;
  balanceCurrentYear: Cents;
  balancePreviousYear: Cents | null;
  balanceForeignCurrency: Cents | null;
  /** Herkunft bei mehreren Dateien/Blättern, z. B. "Erfolgsrechnung.pdf" oder "SaBi.xlsx › ER" */
  source?: string;
}

export interface RowIssue {
  rowIndex: number;
  source?: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface ExcludedRow {
  rowIndex: number;
  source?: string;
  accountNumber: string;
  accountName: string;
  balance: Cents | null;
  reason: string;
}

export interface ParseOptions {
  /** Nur Kontonummern mit min..max Ziffern gelten als Konto; übrige Zeilen (Gruppen, Zwischensummen) werden ausgeblendet */
  accountDigits?: { min: number; max: number };
}

export interface ParseResult {
  headerRowIndex: number;
  mapping: ColumnMapping;
  headers: string[];
  rows: TrialBalanceRow[];
  issues: RowIssue[];
  skippedRows: number;
  /** Zeilen mit Nummer, die nicht als Konto gelten (Ziffernbereich, Totalzeilen) */
  excluded: ExcludedRow[];
}

/** Liest XLSX, XLS, CSV oder PDF (Text oder Scan) in ein zweidimensionales Raster. */
export async function readGrid(
  buffer: Buffer,
  filename: string,
  ctx: { ocr?: import('../../ingest/ocr.js').LocalOcr; meta?: { ocrPages?: number } } = {},
): Promise<Grid> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) {
    const { pdfToGrid } = await import('./pdfGrid.js');
    const r = await pdfToGrid(buffer, ctx.ocr);
    if (ctx.meta) ctx.meta.ocrPages = r.ocrPages;
    return r.grid;
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return readXls(buffer);
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return readCsv(buffer);
  if (lower.endsWith('.xls')) return readXls(buffer);
  throw new UnsupportedFormatError(`Dateiformat nicht unterstützt: ${filename}. Erlaubt: .xlsx, .xlsm, .xls, .csv, .pdf`);
}

export class UnsupportedFormatError extends Error {}

/** Ein Teil der Saldobilanz: eine Datei bzw. ein Excel-Blatt */
export interface GridPart {
  file: string;
  sheet: string | null;
  grid: Grid;
}

/** Wie readGrid, aber jedes nicht leere Excel-Blatt als eigener Teil (Bilanz und Erfolgsrechnung auf getrennten Blättern). */
export async function readGridParts(
  buffer: Buffer,
  filename: string,
  ctx: { ocr?: import('../../ingest/ocr.js').LocalOcr; meta?: { ocrPages?: number } } = {},
): Promise<GridPart[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls')) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const parts: GridPart[] = [];
    for (const name of wb.SheetNames) {
      const sh = wb.Sheets[name];
      if (!sh || (wb.Workbook?.Sheets?.find(x => x.name === name)?.Hidden ?? 0) > 0) continue;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sh, { header: 1, raw: true, blankrows: true, defval: null });
      const grid = rows.map(r => r.map(c => (c === null || c === undefined ? null : typeof c === 'number' ? c : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))));
      if (grid.some(r => r.some(c => c !== null && c !== ''))) parts.push({ file: filename, sheet: name, grid });
    }
    return parts.length ? parts : [{ file: filename, sheet: null, grid: [] }];
  }
  return [{ file: filename, sheet: null, grid: await readGrid(buffer, filename, ctx) }];
}

async function readXls(buffer: Buffer): Promise<Grid> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const name = wb.SheetNames.find(n => (XLSX.utils.sheet_to_json(wb.Sheets[n]!, { header: 1 }) as unknown[]).length > 0) ?? wb.SheetNames[0];
  if (!name) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw: true, blankrows: true, defval: null });
  return rows.map(r => r.map(c => (c === null || c === undefined ? null : typeof c === 'number' ? c : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))));
}

function readCsv(buffer: Buffer): Grid {
  let text = buffer.toString('utf8');
  if (text.includes('\uFFFD')) text = buffer.toString('latin1'); // Fallback für Windows-1252-Exporte
  text = text.replace(/^\uFEFF/, '');
  const res = Papa.parse<string[]>(text, { delimiter: '', skipEmptyLines: false });
  return res.data.map(r => r.map(c => (c === '' ? null : c)));
}

const HEADER_ALIASES: Record<keyof ColumnMapping, RegExp[]> = {
  accountNumber: [/^konto(-?nr\.?|nummer)?$/i, /^kto\.?(-?nr\.?)?$/i, /^account( (no|number))?$/i, /^nr\.?$/i],
  accountName: [/^(konto)?bezeichnung$/i, /^(konto)?name$/i, /^text$/i, /^beschreibung$/i, /^description$/i, /^account name$/i],
  balanceCurrentYear: [/^saldo( (aktuell|lfd\.? ?jahr|laufendes jahr|cy))?$/i, /^(aktuelles|laufendes) jahr$/i, /^current( year)?$/i, /^balance$/i, /^saldo chf$/i, /^cy$/i],
  balancePreviousYear: [/^(saldo )?vorjahr$/i, /^vj$/i, /^saldo vj$/i, /^previous( year)?$/i, /^py$/i],
  balanceForeignCurrency: [/^(saldo )?fw$/i, /^fremdw(ä|ae)hrung$/i, /^saldo fremdw(ä|ae)hrung$/i, /^foreign( currency)?$/i],
  balanceDebit: [/^soll( chf)?$/i, /^debit$/i, /^saldo soll$/i, /^soll-?saldo$/i],
  balanceCredit: [/^haben( chf)?$/i, /^credit$/i, /^saldo haben$/i, /^haben-?saldo$/i],
};

/** Sucht in den ersten 30 Zeilen die Kopfzeile und ordnet Spalten zu. */
export function detectMapping(grid: Grid): { headerRowIndex: number; mapping: ColumnMapping } | null {
  const limit = Math.min(grid.length, 30);
  for (let r = 0; r < limit; r++) {
    const row = grid[r] ?? [];
    const found: Partial<ColumnMapping> = {};
    row.forEach((cell, c) => {
      const h = String(cell ?? '').trim().replace(/\s+/g, ' ');
      if (!h) return;
      for (const key of Object.keys(HEADER_ALIASES) as (keyof ColumnMapping)[]) {
        if (found[key] === undefined && HEADER_ALIASES[key].some(rx => rx.test(h))) {
          found[key] = c;
          break;
        }
      }
    });
    // Ohne explizite VJ-Spalte: zwei Jahreszahlen als Kopf -> grösseres Jahr = aktuell
    if (found.balanceCurrentYear === undefined) {
      const years = row
        .map((cell, c) => ({ c, y: /^(?:saldo )?((?:19|20)\d{2})$/i.exec(String(cell ?? '').trim())?.[1] }))
        .filter((x): x is { c: number; y: string } => !!x.y)
        .sort((a, b) => Number(b.y) - Number(a.y));
      if (years[0]) found.balanceCurrentYear = years[0].c;
      if (years[1] && found.balancePreviousYear === undefined) found.balancePreviousYear = years[1].c;
    }
    const hasBalance = found.balanceCurrentYear !== undefined || (found.balanceDebit !== undefined && found.balanceCredit !== undefined);
    if (found.accountNumber !== undefined && found.accountName !== undefined && hasBalance) {
      return { headerRowIndex: r, mapping: found as ColumnMapping };
    }
  }
  return null;
}

export class MappingError extends Error {}

/** Anzahl Ziffern einer Kontonummer (Trennzeichen zählen nicht). */
export const digitCount = (accountNumber: string) => accountNumber.replace(/\D/g, '').length;

export function parseTrialBalance(grid: Grid, explicit?: { headerRowIndex: number; mapping: ColumnMapping }, opts: ParseOptions = {}): ParseResult {
  const det = explicit ?? detectMapping(grid);
  if (!det) {
    throw new MappingError(
      'Kopfzeile nicht erkannt. Erwartet werden Spalten für Kontonummer, Bezeichnung und Saldo. ' +
        'Bitte Spaltenzuordnung explizit mitgeben (mapping).',
    );
  }
  const { headerRowIndex, mapping } = det;
  const headers = (grid[headerRowIndex] ?? []).map(c => String(c ?? ''));
  const rows: TrialBalanceRow[] = [];
  const issues: RowIssue[] = [];
  const excluded: ExcludedRow[] = [];
  let skipped = 0;

  for (let r = headerRowIndex + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const excelRow = r + 1;
    const numRaw = row[mapping.accountNumber];
    const nameRaw = row[mapping.accountName];
    const cyRaw = mapping.balanceCurrentYear !== undefined ? row[mapping.balanceCurrentYear] : row[mapping.balanceDebit ?? -1] ?? row[mapping.balanceCredit ?? -1];

    const accountNumber = normalizeAccountNumber(numRaw);
    const accountName = String(nameRaw ?? '').trim();

    if (!accountNumber && !accountName && (cyRaw === null || cyRaw === undefined || cyRaw === '')) continue; // Leerzeile
    // Wiederholte Kopfzeile (z. B. auf jeder PDF-Seite)
    if (headers.length && row.every((c, i) => String(c ?? '').trim() === (headers[i] ?? '').trim())) continue;
    // Keine Kontonummer, oder erste Zelle ist keine Zahl (Seitenfuss, Zwischentitel, Kopfzeile)
    if (!accountNumber || !/^\d/.test(accountNumber)) {
      // Zwischentotale / Überschriften ohne Kontonummer werden übersprungen, aber protokolliert
      skipped++;
      if (/total|summe|saldo/i.test(accountName)) {
        issues.push({ rowIndex: excelRow, severity: 'warning', code: 'TOTAL_ROW_SKIPPED', message: `Zeile "${accountName}" ohne Kontonummer übersprungen (Total/Zwischensumme).` });
      }
      continue;
    }
    const nd = digitCount(accountNumber);
    if (opts.accountDigits && (nd < opts.accountDigits.min || nd > opts.accountDigits.max)) {
      skipped++;
      const cyEx = mapping.balanceCurrentYear !== undefined ? parseCell(cyRaw) : null;
      excluded.push({ rowIndex: excelRow, accountNumber, accountName, balance: cyEx ?? null, reason: `${nd} Ziffern – keine Kontonummer (${opts.accountDigits.min === opts.accountDigits.max ? opts.accountDigits.min : `${opts.accountDigits.min}–${opts.accountDigits.max}`} Ziffern verlangt)` });
      continue;
    }
    if (/^(total|summe|zwischentotal|zwischensumme)\b/i.test(accountName)) {
      skipped++;
      excluded.push({ rowIndex: excelRow, accountNumber, accountName, balance: null, reason: 'Total-/Summenzeile' });
      continue;
    }
    if (!/^\d[\d.\-/ ]*$/.test(accountNumber)) {
      issues.push({ rowIndex: excelRow, severity: 'warning', code: 'ACCOUNT_NUMBER_FORMAT', message: `Kontonummer "${accountNumber}" ist nicht rein numerisch.` });
    }
    if (!accountName) {
      issues.push({ rowIndex: excelRow, severity: 'warning', code: 'MISSING_NAME', message: `Konto ${accountNumber} ohne Bezeichnung.` });
    }

    let cy: Cents | null | undefined;
    if (mapping.balanceCurrentYear !== undefined) cy = parseCell(cyRaw);
    else {
      const d = parseCell(row[mapping.balanceDebit!]);
      const h = parseCell(row[mapping.balanceCredit!]);
      cy = d === undefined || h === undefined ? undefined : (d ?? 0) - (h ?? 0);
    }
    if (cy === undefined) {
      issues.push({ rowIndex: excelRow, severity: 'error', code: 'INVALID_AMOUNT', message: `Konto ${accountNumber}: Saldo "${String(cyRaw)}" ist kein gültiger Betrag.` });
      continue;
    }
    const py = mapping.balancePreviousYear !== undefined ? parseCell(row[mapping.balancePreviousYear]) : null;
    if (py === undefined) {
      issues.push({ rowIndex: excelRow, severity: 'warning', code: 'INVALID_AMOUNT_PY', message: `Konto ${accountNumber}: Vorjahressaldo ungültig, wird ignoriert.` });
    }
    const fx = mapping.balanceForeignCurrency !== undefined ? parseCell(row[mapping.balanceForeignCurrency]) : null;

    rows.push({
      rowIndex: excelRow,
      accountNumber,
      accountName,
      balanceCurrentYear: cy ?? 0,
      balancePreviousYear: py ?? null,
      balanceForeignCurrency: fx ?? null,
    });
  }
  return { headerRowIndex, mapping, headers, rows, issues, skippedRows: skipped, excluded };
}

/** undefined = ungültig, null = leer */
function parseCell(v: Cell | undefined): Cents | null | undefined {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const p = parseAmount(v);
  return p ? p.cents : undefined;
}

function normalizeAccountNumber(v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  // Randzeichen entfernen (z. B. aus Texterkennung: "1022, '1022, 1022|)
  return v.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Hinweis, wenn die Saldobilanz (teilweise) per Texterkennung gelesen wurde */
export function ocrTrialBalanceIssue(ocrPages: number | undefined): RowIssue[] {
  return ocrPages
    ? [{ rowIndex: 0, severity: 'warning', code: 'TB_OCR', message: `Saldobilanz ist ein Scan (${ocrPages} Seite(n) per Texterkennung gelesen) – Salden stichprobenweise mit dem Original vergleichen.` }]
    : [];
}
