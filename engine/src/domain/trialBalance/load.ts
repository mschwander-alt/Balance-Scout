import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  detectMapping, digitCount, ocrTrialBalanceIssue, parseTrialBalance, readGridParts,
  type ColumnMapping, type ExcludedRow, type Grid, type RowIssue, type TrialBalanceRow,
} from './parser.js';

export type ExplicitMapping = { headerRowIndex: number; mapping: ColumnMapping };

/** Ein Teil der Saldobilanz (Datei bzw. Excel-Blatt), z. B. Bilanz und Erfolgsrechnung getrennt */
export interface TbPartInfo {
  id: string; // "<Pfad>" oder "<Pfad>#<Blatt>"
  path: string;
  sheet: string | null;
  label: string;
  detected: ExplicitMapping | null;
  used: ExplicitMapping | null;
  head: string[][];
  accountCount: number;
  ocrPages: number;
  /** ignoriert = keine Kontenliste erkannt (z. B. Deckblatt) */
  status: 'ok' | 'ignoriert' | 'zuordnen';
}

export interface LoadedTrialBalance {
  parts: TbPartInfo[];
  rows: TrialBalanceRow[];
  excluded: ExcludedRow[];
  issues: RowIssue[];
  /** Häufigkeit der Ziffernanzahl aller Kontonummern (vor dem Filter) */
  digitStats: Record<number, number>;
  /** Vorschlag für den Ziffernbereich */
  suggestedDigits: { min: number; max: number } | null;
}

export interface LoadOptions {
  mappings?: Record<string, ExplicitMapping>;
  accountDigits?: { min: number; max: number };
  ocr?: import('../../ingest/ocr.js').LocalOcr;
}

/**
 * Liest eine oder mehrere Dateien (Bilanz und Erfolgsrechnung in einer oder in zwei Dateien,
 * auch auf mehreren Excel-Blättern) und fügt die Konten zusammen.
 */
export async function loadTrialBalance(paths: string[], opts: LoadOptions = {}): Promise<LoadedTrialBalance> {
  const parts: { info: TbPartInfo; grid: Grid }[] = [];
  for (const p of paths) {
    const meta: { ocrPages?: number } = {};
    const gp = await readGridParts(await readFile(p), path.basename(p), { ocr: opts.ocr, meta });
    for (const [gi, g] of gp.entries()) {
      const id = g.sheet && gp.length > 1 ? `${p}#${g.sheet}` : p;
      const label = g.sheet && gp.length > 1 ? `${path.basename(p)} › ${g.sheet}` : path.basename(p);
      const detected = detectMapping(g.grid);
      parts.push({
        grid: g.grid,
        info: {
          id, path: p, sheet: g.sheet, label, detected, used: opts.mappings?.[id] ?? (gi === 0 ? opts.mappings?.[p] : undefined) ?? detected,
          head: g.grid.slice(0, 40).map(r => r.slice(0, 12).map(c => (c === null ? '' : String(c)))),
          accountCount: 0, ocrPages: meta.ocrPages ?? 0, status: 'ok',
        },
      });
    }
  }
  const multi = parts.length > 1;
  const rows: TrialBalanceRow[] = [];
  const excluded: ExcludedRow[] = [];
  const issues: RowIssue[] = [];
  const digitStats: Record<number, number> = {};
  const anyDetected = parts.some(p => p.info.used);
  for (const { info, grid } of parts) {
    if (!info.used) {
      // Ein Blatt ohne Kontenliste (Deckblatt, Notizen) neben anderen Teilen wird ignoriert;
      // ist es der einzige Teil einer Datei bzw. wurde gar nichts erkannt, muss zugeordnet werden.
      const fileHasOther = parts.some(o => o.info.path === info.path && o.info.used);
      info.status = !anyDetected || (!fileHasOther && !info.sheet) ? 'zuordnen' : 'ignoriert';
      if (info.status === 'ignoriert') issues.push({ rowIndex: 0, source: info.label, severity: 'warning', code: 'PART_IGNORED', message: `${info.label}: keine Kontenliste erkannt – nicht berücksichtigt (bei Bedarf „Spalten zuordnen“).` });
      else if (anyDetected) issues.push({ rowIndex: 0, source: info.label, severity: 'error', code: 'PART_UNMAPPED', message: `${info.label}: Spalten nicht erkannt – bitte zuordnen.` });
      continue;
    }
    const unfiltered = parseTrialBalance(grid, info.used);
    for (const r of unfiltered.rows) digitStats[digitCount(r.accountNumber)] = (digitStats[digitCount(r.accountNumber)] ?? 0) + 1;
    const parsed = parseTrialBalance(grid, info.used, { accountDigits: opts.accountDigits });
    const src = multi ? info.label : undefined;
    info.accountCount = parsed.rows.length;
    rows.push(...parsed.rows.map(r => ({ ...r, source: src })));
    excluded.push(...parsed.excluded.map(e => ({ ...e, source: src })));
    issues.push(...ocrTrialBalanceIssue(info.ocrPages).map(i => ({ ...i, source: src, message: src ? `${src}: ${i.message}` : i.message })));
    issues.push(...parsed.issues.map(i => ({ ...i, source: src })));
  }
  return { parts: parts.map(p => p.info), rows, excluded, issues, digitStats, suggestedDigits: suggestDigits(digitStats) };
}

/**
 * Vorschlag: häufigste Ziffernanzahl; benachbarte Längen kommen dazu, wenn sie ebenfalls häufig sind
 * (z. B. 4- und 5-stellige Konten gemischt). Kurze Gruppen-/Klassennummern (1–3 Ziffern) bleiben draussen.
 */
export function suggestDigits(stats: Record<number, number>): { min: number; max: number } | null {
  const entries = Object.entries(stats).map(([k, v]) => [Number(k), v] as const).filter(([k]) => k > 0);
  if (!entries.length) return null;
  const total = entries.reduce((a, [, v]) => a + v, 0);
  const [mode] = entries.reduce((a, b) => (b[1] > a[1] || (b[1] === a[1] && b[0] > a[0]) ? b : a));
  let min = mode;
  let max = mode;
  const share = (k: number) => (stats[k] ?? 0) / total;
  while (share(max + 1) >= 0.1) max++;
  while (min - 1 >= 4 && share(min - 1) >= 0.1) min--;
  return { min, max };
}
