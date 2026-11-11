import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  detectMapping, inferMapping, digitCount, ocrTrialBalanceIssue, parseTrialBalance, readGridParts,
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
  /** Spalten angenommen (ohne erkennbare Kopfzeile) */
  guessed?: boolean;
  /** ignoriert = keine Kontenliste erkannt (z. B. Deckblatt) */
  status: 'ok' | 'ignoriert' | 'zuordnen';
  /** Grund, falls ignoriert (z. B. gleiche Konten wie ein anderes Blatt) */
  reason?: string;
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
  /** Vom Prüfer: Teile (Datei/Blatt-IDs), die nicht bzw. trotz Doppel verwendet werden sollen */
  skipParts?: string[];
  forceParts?: string[];
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
  // Blätter ohne erkannte Kopfzeile (z. B. Erfolgsrechnung mit anderem Kopf): Aufbau eines anderen Blatts
  // derselben Datei übernehmen, sonst aus den Daten ableiten – nur wenn sich so Konten ergeben
  const accountRows = (grid: Grid, m: ExplicitMapping) => parseTrialBalance(grid, m).rows.length;
  for (const p of parts) {
    if (p.info.used) continue;
    const sibling = parts.find(o => o !== p && o.info.path === p.info.path && o.info.detected);
    const viaSibling = sibling?.info.detected && accountRows(p.grid, { ...sibling.info.detected, headerRowIndex: Math.max(0, findHeaderLike(p.grid, sibling.info.detected)) }) >= 3
      ? { ...sibling.info.detected, headerRowIndex: Math.max(0, findHeaderLike(p.grid, sibling.info.detected)) } : null;
    const inferred = viaSibling ?? inferMapping(p.grid);
    if (inferred && accountRows(p.grid, inferred) >= 3) {
      p.info.used = inferred;
      p.info.guessed = true;
    }
  }
  const multi = parts.length > 1;
  const rows: TrialBalanceRow[] = [];
  const excluded: ExcludedRow[] = [];
  const issues: RowIssue[] = [];
  const digitStats: Record<number, number> = {};
  const anyDetected = parts.some(p => p.info.used);
  // Mehrere Blätter/Dateien mit (weitgehend) denselben Konten: nur das vollständigste verwenden, sonst würden Konten
  // doppelt eingelesen (z. B. Blatt „Saldobilanz“ und Blatt „Bilanz“ als Auszug, oder Blätter je Jahr)
  const numsOf = new Map<TbPartInfo, Set<string>>();
  for (const { info, grid } of parts) if (info.used) numsOf.set(info, new Set(parseTrialBalance(grid, info.used, { accountDigits: opts.accountDigits }).rows.map(r => r.accountNumber)));
  const ordered = [...numsOf.keys()].sort((a, b) => numsOf.get(b)!.size - numsOf.get(a)!.size);
  const kept: TbPartInfo[] = [];
  for (const info of ordered) {
    const mine = numsOf.get(info)!;
    if (opts.skipParts?.includes(info.id)) { info.status = 'ignoriert'; info.reason = 'vom Prüfer abgewählt'; continue; }
    const dup = kept.find(k => { const o = numsOf.get(k)!; let n = 0; for (const x of mine) if (o.has(x)) n++; return mine.size > 0 && n / mine.size >= 0.5; });
    if (dup && !opts.forceParts?.includes(info.id)) {
      info.status = 'ignoriert';
      info.reason = `enthält dieselben Konten wie „${dup.label}“`;
      issues.push({ rowIndex: 0, source: info.label, severity: 'warning', code: 'PART_DUPLICATE', message: `${info.label}: enthält überwiegend dieselben Konten wie „${dup.label}“ – nicht berücksichtigt, damit keine Konten doppelt gezählt werden (bei Bedarf in der Vorschau wieder einschliessen).` });
      continue;
    }
    kept.push(info);
  }
  const seen = new Map<string, { label: string; rowIndex: number; balance: number }>();
  for (const { info, grid } of parts) {
    if (info.used && info.status === 'ignoriert') continue;
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
    if (info.guessed) issues.push({ rowIndex: 0, source: info.label, severity: 'warning', code: 'PART_GUESSED', message: `${info.label}: Kopfzeile nicht erkannt – Spalten angenommen (erste Betragsspalte = aktuelles Jahr). Bitte mit „Konten anzeigen“ kontrollieren.` });
    // Gleiches Konto mehrfach (wiederholte Seiten, Teilblätter): nur einmal übernehmen und nachvollziehbar ausweisen
    for (const r of parsed.rows) {
      const prev = seen.get(r.accountNumber);
      if (prev) {
        const same = prev.balance === r.balanceCurrentYear;
        excluded.push({ rowIndex: r.rowIndex, source: src, accountNumber: r.accountNumber, accountName: r.accountName, balance: r.balanceCurrentYear, reason: `doppelt – bereits ${prev.label ? `${prev.label}, ` : ''}Zeile ${prev.rowIndex}${same ? ' (gleicher Saldo)' : ' (anderer Saldo – prüfen!)'}` });
        if (!same) issues.push({ rowIndex: r.rowIndex, source: src, severity: 'warning', code: 'DUPLICATE_DIFFERENT', message: `Konto ${r.accountNumber} kommt mehrfach mit unterschiedlichem Saldo vor (übernommen: Zeile ${prev.rowIndex}) – Saldobilanz prüfen.` });
        info.accountCount--;
        continue;
      }
      seen.set(r.accountNumber, { label: src ?? '', rowIndex: r.rowIndex, balance: r.balanceCurrentYear });
      rows.push({ ...r, source: src });
    }
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

/** Zeile vor der ersten Kontozeile (als Kopfzeile für übernommene Spaltenzuordnung) */
function findHeaderLike(grid: Grid, m: ExplicitMapping): number {
  const first = grid.findIndex(r => /^\s*\d{3,8}\s*$/.test(String(r[m.mapping.accountNumber] ?? '')));
  return first > 0 ? first - 1 : 0;
}
