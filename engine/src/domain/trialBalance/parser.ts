import Papa from 'papaparse';
import { parseAmount, type Cents } from '../amount.js';

export type Cell = string | number | null;
export type Grid = Cell[][];

export interface ColumnMapping {
  accountNumber: number;
  accountName: number;
  balanceCurrentYear: number;
  balancePreviousYear?: number;
  balanceForeignCurrency?: number;
}

export interface TrialBalanceRow {
  rowIndex: number; // 1-basiert, wie in Excel
  accountNumber: string;
  accountName: string;
  balanceCurrentYear: Cents;
  balancePreviousYear: Cents | null;
  balanceForeignCurrency: Cents | null;
}

export interface RowIssue {
  rowIndex: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface ParseResult {
  headerRowIndex: number;
  mapping: ColumnMapping;
  headers: string[];
  rows: TrialBalanceRow[];
  issues: RowIssue[];
  skippedRows: number;
}

/** Liest XLSX oder CSV in ein zweidimensionales Raster. */
export async function readGrid(buffer: Buffer, filename: string): Promise<Grid> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return readXls(buffer);
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return readCsv(buffer);
  if (lower.endsWith('.xls')) return readXls(buffer);
  throw new UnsupportedFormatError(`Dateiformat nicht unterstützt: ${filename}. Erlaubt: .xlsx, .xlsm, .xls, .csv`);
}

export class UnsupportedFormatError extends Error {}

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
    if (found.accountNumber !== undefined && found.accountName !== undefined && found.balanceCurrentYear !== undefined) {
      return { headerRowIndex: r, mapping: found as ColumnMapping };
    }
  }
  return null;
}

export class MappingError extends Error {}

export function parseTrialBalance(grid: Grid, explicit?: { headerRowIndex: number; mapping: ColumnMapping }): ParseResult {
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
  let skipped = 0;

  for (let r = headerRowIndex + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const excelRow = r + 1;
    const numRaw = row[mapping.accountNumber];
    const nameRaw = row[mapping.accountName];
    const cyRaw = row[mapping.balanceCurrentYear];

    const accountNumber = normalizeAccountNumber(numRaw);
    const accountName = String(nameRaw ?? '').trim();

    if (!accountNumber && !accountName && (cyRaw === null || cyRaw === undefined || cyRaw === '')) continue; // Leerzeile
    if (!accountNumber) {
      // Zwischentotale / Überschriften ohne Kontonummer werden übersprungen, aber protokolliert
      skipped++;
      if (/total|summe|saldo/i.test(accountName)) {
        issues.push({ rowIndex: excelRow, severity: 'warning', code: 'TOTAL_ROW_SKIPPED', message: `Zeile "${accountName}" ohne Kontonummer übersprungen (Total/Zwischensumme).` });
      }
      continue;
    }
    if (!/^\d[\d.\-/ ]*$/.test(accountNumber)) {
      issues.push({ rowIndex: excelRow, severity: 'warning', code: 'ACCOUNT_NUMBER_FORMAT', message: `Kontonummer "${accountNumber}" ist nicht rein numerisch.` });
    }
    if (!accountName) {
      issues.push({ rowIndex: excelRow, severity: 'warning', code: 'MISSING_NAME', message: `Konto ${accountNumber} ohne Bezeichnung.` });
    }

    const cy = parseCell(cyRaw);
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
  return { headerRowIndex, mapping, headers, rows, issues, skippedRows: skipped };
}

/** undefined = ungültig, null = leer */
function parseCell(v: Cell | undefined): Cents | null | undefined {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const p = parseAmount(v);
  return p ? p.cents : undefined;
}

function normalizeAccountNumber(v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return v.trim();
}
