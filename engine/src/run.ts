import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Cents } from './domain/amount.js';
import { classifyRows, validateTrialBalance, type ClassifiedAccount, type SignConvention, type ValidationReport } from './domain/trialBalance/validate.js';
import { parseTrialBalance, readGrid, type ColumnMapping } from './domain/trialBalance/parser.js';
import { extractAmounts, type AmountCandidate } from './domain/matching/extractAmounts.js';
import { runMatching, type AccountResult, type MatchOutput } from './domain/matching/engine.js';
import { listFiles, readDocument, type EvidenceDocument } from './ingest/readDocument.js';
import { LocalOcr, type OcrOptions } from './ingest/ocr.js';
import { detectBalanceDate, guessDocType } from './ingest/documentFacts.js';
import { placeFiles, planTargetNames, type FileMode, type PlacementResult } from './organize/placeFiles.js';

export interface RunInput {
  mandate: string;
  client?: string;
  /** Bilanzstichtag ISO (YYYY-MM-DD) */
  closingDate: string | null;
  trialBalancePath: string;
  trialBalanceMapping?: { headerRowIndex: number; mapping: ColumnMapping };
  signConvention?: SignConvention;
  /** Ein oder mehrere Ordner (inkl. Unterordner) und/oder einzelne Dateien */
  evidencePaths: string[];
  /** Zielordner für 01_Zugeordnet / 02_Nicht_zugeordnet und das Excel; null = nichts ablegen */
  targetDir: string | null;
  fileMode?: FileMode;
  absoluteToleranceCents?: Cents;
  scope?: 'balance_sheet' | 'all';
  ocr?: OcrOptions;
  onProgress?: (p: Progress) => void;
}

export interface Progress {
  phase: 'saldobilanz' | 'suchen' | 'lesen' | 'abgleich' | 'ablage' | 'bericht' | 'fertig';
  message: string;
  current?: number;
  total?: number;
}

export interface DocumentSummary {
  doc: EvidenceDocument;
  docType: string;
  balanceDate: string | null;
  balanceDateEvidence: string | null;
  amountCount: number;
  assignedAccounts: string[]; // Kontonummern
  assigned: boolean;
  targetName: string;
  placement: PlacementResult | null;
}

export interface RunResult {
  input: Omit<RunInput, 'onProgress'>;
  startedAt: Date;
  finishedAt: Date;
  accounts: ClassifiedAccount[];
  validation: ValidationReport;
  match: MatchOutput;
  documents: DocumentSummary[];
  byAccount: Map<string, AccountResult>;
}

/** Gesamter Ablauf ohne Netzwerk: Saldobilanz -> Belege lesen (inkl. OCR) -> Abgleich -> Ablage. */
export async function runAudit(input: RunInput): Promise<RunResult> {
  const startedAt = new Date();
  const progress = input.onProgress ?? (() => undefined);
  const ocr = new LocalOcr(input.ocr);
  try {
    // 1. Saldobilanz
    progress({ phase: 'saldobilanz', message: 'Saldobilanz wird gelesen …' });
    const tbBuf = await readFile(input.trialBalancePath);
    const grid = await readGrid(tbBuf, path.basename(input.trialBalancePath));
    const parsed = parseTrialBalance(grid, input.trialBalanceMapping);
    const accounts = classifyRows(parsed.rows);
    const validation = validateTrialBalance(accounts, parsed.issues, input.signConvention ?? 'signed');

    // 2. Belege finden
    progress({ phase: 'suchen', message: 'Belege werden gesucht …' });
    const exclude = [input.targetDir].filter((x): x is string => !!x).map(x => path.resolve(x));
    const tbAbs = path.resolve(input.trialBalancePath);
    const files: { absPath: string; relPath: string }[] = [];
    const multi = input.evidencePaths.length > 1;
    for (const p of input.evidencePaths) {
      const abs = path.resolve(p);
      const isDir = (await import('node:fs/promises')).stat(abs).then(s => s.isDirectory());
      if (await isDir) {
        const label = path.basename(abs);
        for (const f of await listFiles(abs, { excludeDirs: exclude })) {
          files.push({ absPath: f.absPath, relPath: multi ? `${label}/${f.relPath}` : f.relPath });
        }
      } else {
        files.push({ absPath: abs, relPath: path.basename(abs) });
      }
    }
    const evidenceFiles = files.filter(f => path.resolve(f.absPath) !== tbAbs);

    // 3. Lesen (inkl. Texterkennung)
    const docs: EvidenceDocument[] = [];
    for (const [i, f] of evidenceFiles.entries()) {
      progress({ phase: 'lesen', message: f.relPath, current: i + 1, total: evidenceFiles.length });
      docs.push(await readDocument(f.absPath, f.relPath, { ocr, onProgress: m => progress({ phase: 'lesen', message: m, current: i + 1, total: evidenceFiles.length }) }));
    }

    // 4. Abgleich
    progress({ phase: 'abgleich', message: 'Salden werden abgeglichen …' });
    const facts = new Map(docs.map(d => [d.id, detectBalanceDate(d, input.closingDate)]));
    const amounts: AmountCandidate[] = [];
    const amountCount = new Map<string, number>();
    for (const d of docs) {
      const a = extractAmounts(d.id, d.lines);
      amountCount.set(d.id, a.length);
      amounts.push(...a);
    }
    const match = runMatching(
      accounts.map(a => ({ id: `${a.accountNumber}#${a.rowIndex}`, accountNumber: a.accountNumber, accountName: a.accountName, balance: a.balanceCurrentYear, category: a.category })),
      docs.map(d => ({ id: d.id, filename: d.filename, insight: { balanceDate: facts.get(d.id)?.date ?? null, verifiedBalances: [] } })),
      amounts,
      {
        absoluteToleranceCents: input.absoluteToleranceCents,
        scope: input.scope,
        signConvention: input.signConvention ?? 'signed',
        closingDate: input.closingDate,
      },
    );

    // Zuordnung Datei -> Konten (massgebende Fundstelle, Status Belegt oder Prüfen)
    const assigned = new Map<string, string[]>();
    for (const r of match.results) {
      if ((r.status === 'BELEGT' || r.status === 'PRUEFEN') && r.best) {
        assigned.set(r.best.documentId, [...(assigned.get(r.best.documentId) ?? []), r.accountNumber]);
      }
    }
    const names = planTargetNames(docs.map(d => ({ docId: d.id, relPath: d.relPath })));

    // 5. Ablage
    let placements: PlacementResult[] = [];
    if (input.targetDir && (input.fileMode ?? 'copy') !== 'none') {
      progress({ phase: 'ablage', message: 'Belege werden abgelegt …' });
      placements = await placeFiles(
        input.targetDir,
        docs.map(d => ({ docId: d.id, absPath: d.absPath, relPath: d.relPath, sha256: d.sha256, assigned: assigned.has(d.id), targetName: names.get(d.id)! })),
        input.fileMode ?? 'copy',
      );
    }
    const placementBy = new Map(placements.map(p => [p.docId, p]));

    const documents: DocumentSummary[] = docs.map(d => ({
      doc: d,
      docType: guessDocType(d),
      balanceDate: facts.get(d.id)?.date ?? null,
      balanceDateEvidence: facts.get(d.id)?.evidence ?? null,
      amountCount: amountCount.get(d.id) ?? 0,
      assignedAccounts: assigned.get(d.id) ?? [],
      assigned: assigned.has(d.id),
      targetName: names.get(d.id)!,
      placement: placementBy.get(d.id) ?? null,
    }));

    progress({ phase: 'fertig', message: 'Fertig.' });
    const { onProgress: _omit, ...rest } = input;
    return {
      input: rest,
      startedAt,
      finishedAt: new Date(),
      accounts,
      validation,
      match,
      documents,
      byAccount: new Map(match.results.map(r => [r.accountId, r])),
    };
  } finally {
    await ocr.close();
  }
}
