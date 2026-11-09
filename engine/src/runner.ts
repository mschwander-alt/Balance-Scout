/**
 * Hintergrundprozess für die Windows-App: nimmt Aufträge per Nachricht entgegen und meldet
 * Fortschritt und Ergebnis zurück. Läuft als Electron-utilityProcess oder als Node-Kindprozess.
 */
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { runAudit, writeExcelReport, uniqueReportPath, diagnosticsPathFor, diagnosticReport, loadTrialBalanceFor, type RunInput, type RunResult } from './index.js';
import { classifyRows, validateTrialBalance, type SignConvention } from './domain/trialBalance/validate.js';
import type { ExplicitMapping } from './domain/trialBalance/load.js';
import { KMU_GROUPS, defaultGroupLetters } from './domain/trialBalance/accountGroups.js';
import { finalizeAudit, type ReviewDecisions } from './finalize.js';
import { loadSnapshot, saveSnapshot } from './snapshot.js';
import type { FileMode } from './organize/placeFiles.js';

import { renderPreview } from './preview.js';

export type Request =
  | { id: string; type: 'preview'; absPath: string; page: number }
  | {
      id: string; type: 'previewTrialBalance'; path?: string; paths?: string[]; mapping?: ExplicitMapping; mappings?: Record<string, ExplicitMapping>;
      accountDigits?: { min: number; max: number }; signConvention?: SignConvention; ocr?: { langPath?: string };
    }
  /** Analyse (Lesen + Abgleich). Mit snapshotPath: ohne Ablage/Excel – Abschluss folgt nach der Durchsicht. */
  | { id: string; type: 'run'; input: Omit<RunInput, 'onProgress'>; reportDir: string; snapshotPath?: string }
  | { id: string; type: 'finalize'; snapshotPath: string; decisions: ReviewDecisions; targetDir: string | null; fileMode: FileMode; reportDir: string }
  | { id: string; type: 'groups' };

type Port = { postMessage(m: unknown): void; on(ev: 'message', cb: (m: unknown) => void): void };
const parentPort: Port | undefined = (process as unknown as { parentPort?: Port }).parentPort;
const send = (m: unknown) => (parentPort ? parentPort.postMessage(m) : process.send?.(m));

async function previewTrialBalance(r: Extract<Request, { type: 'previewTrialBalance' }>) {
  const { LocalOcr } = await import('./ingest/ocr.js');
  const ocr = new LocalOcr(r.ocr);
  const paths = r.paths?.length ? r.paths : [r.path!];
  let tb;
  try {
    tb = await (await import('./domain/trialBalance/load.js')).loadTrialBalance(paths, {
      ocr, accountDigits: r.accountDigits,
      mappings: r.mappings ?? (r.mapping ? { [paths[0]!]: r.mapping } : undefined),
    });
  } finally {
    await ocr.close();
  }
  const first = tb.parts[0]!;
  const accounts = classifyRows(tb.rows);
  const validation = tb.rows.length ? validateTrialBalance(accounts, tb.issues, r.signConvention ?? 'signed') : null;
  return {
    // Kompatibilität (ein Teil): erkannte Zuordnung und Kopf des ersten Teils
    detected: tb.rows.length && !tb.parts.some(p => p.status === 'zuordnen') ? first.used : null,
    head: first.head,
    parts: tb.parts,
    accounts: accounts.map(a => ({
      accountNumber: a.accountNumber, accountName: a.accountName, balance: a.balanceCurrentYear, balancePreviousYear: a.balancePreviousYear,
      category: a.category, groupCode: a.groupCode, groupName: a.groupName, groupSource: a.groupSource, source: a.source ?? null,
    })),
    excluded: tb.excluded,
    digitStats: tb.digitStats,
    suggestedDigits: tb.suggestedDigits,
    validation,
  };
}

export function serializeResult(res: RunResult, excelPath: string, diagnostics: string) {
  const docBy = new Map(res.documents.map(d => [d.doc.id, d]));
  // Fundstelle mit Dateipfaden und Position (für Vorschau und Markierung)
  const withDoc = <T extends { documentId: string; page: number }>(c: T) => {
    const doc = docBy.get(c.documentId);
    return { ...c, relPath: doc?.doc.relPath ?? null, absPath: doc?.doc.absPath ?? null, newPath: doc?.placement?.newPath ?? null, pageLabel: doc?.doc.pageLabels[c.page] ?? null, ext: doc?.doc.ext ?? null };
  };
  return {
    excelPath,
    diagnostics,
    startedAt: res.startedAt.toISOString(),
    finishedAt: res.finishedAt.toISOString(),
    summary: res.match.summary,
    validation: res.validation,
    accounts: res.accounts.map(a => {
      const m = res.byAccount.get(`${a.accountNumber}#${a.rowIndex}`)!;
      return {
        accountNumber: a.accountNumber, accountName: a.accountName, groupName: a.groupName, groupCode: a.groupCode, groupSource: a.groupSource,
        source: a.source ?? null, category: a.category, manual: res.review?.manual.get(a.accountNumber) ?? null,
        balance: a.balanceCurrentYear, balancePreviousYear: a.balancePreviousYear, status: m.status, reasons: m.reasons,
        best: m.best ? withDoc(m.best) : null,
        candidates: m.candidates.slice(1).map(withDoc),
      };
    }),
    documents: res.documents.map(d => ({
      id: d.doc.id, filename: d.doc.filename, relPath: d.doc.relPath, absPath: d.doc.absPath, ext: d.doc.ext, size: d.doc.size,
      status: d.doc.status, method: d.doc.method, pageCount: d.doc.pageCount, ocrPages: d.doc.ocrPages, ocrConfidence: d.doc.ocrConfidence,
      warnings: d.doc.warnings, docType: d.docType, balanceDate: d.balanceDate, amountCount: d.amountCount,
      assigned: d.assigned, assignedAccounts: d.assignedAccounts, targetName: d.targetName,
      placement: d.placement ? { status: d.placement.status, newPath: d.placement.newPath, message: d.placement.message ?? null } : null,
      notePath: d.notePlacement?.newPath ?? null,
      keyAmount: d.keyAmount ?? null, keyDate: d.keyDate ?? null, amountSet: d.amountSet ?? [], searchText: d.searchText ?? '',
      register: res.review?.registers.get(d.doc.id) ?? null,
      irrelevant: res.review?.irrelevant.has(d.doc.id) ?? false,
    })),
    trialBalance: res.trialBalance ? { parts: res.trialBalance.parts.map(p => ({ id: p.id, label: p.label, accountCount: p.accountCount, status: p.status })), excluded: res.trialBalance.excluded } : null,
    finalized: !!excelPath,
  };
}
export type SerializedResult = ReturnType<typeof serializeResult>;

async function handle(req: Request): Promise<unknown> {
  if (req.type === 'previewTrialBalance') return previewTrialBalance(req);
  if (req.type === 'preview') return renderPreview(req.absPath, req.page);
  if (req.type === 'groups') return { groups: KMU_GROUPS.map(g => ({ code: g.code, name: g.name, category: g.category, subcategory: g.subcategory })), letters: defaultGroupLetters(), general: { code: 'ALLG', name: 'Allgemeine Prüfungen (Belege ohne Konto)', account: '@allgemein' } };
  if (req.type === 'finalize') {
    send({ id: req.id, kind: 'progress', progress: { phase: 'ablage', message: 'Belege werden abgelegt …' } });
    const res = await loadSnapshot(req.snapshotPath);
    const out = await finalizeAudit(res, req.decisions, { targetDir: req.targetDir, fileMode: req.fileMode, reportDir: req.reportDir });
    return serializeResult(out.result, out.excelPath, out.diagnostics);
  }
  if (req.snapshotPath) {
    // Nur analysieren: nichts ablegen, kein Excel – das geschieht beim Abschluss
    const res = await runAudit({ ...req.input, fileMode: 'none', onProgress: p => send({ id: req.id, kind: 'progress', progress: p }) });
    await saveSnapshot(res, req.snapshotPath);
    return serializeResult(res, '', diagnosticReport(res));
  }
  const res = await runAudit({ ...req.input, onProgress: p => send({ id: req.id, kind: 'progress', progress: p }) });
  send({ id: req.id, kind: 'progress', progress: { phase: 'bericht', message: 'Excel-Dokumentation wird erstellt …' } });
  const excelPath = await uniqueReportPath(req.reportDir, req.input.mandate, req.input.closingDate);
  await writeExcelReport(res, excelPath);
  const diagnostics = diagnosticReport(res);
  await writeFile(diagnosticsPathFor(excelPath), diagnostics, { encoding: 'utf8', flag: 'wx' });
  return serializeResult(res, excelPath, diagnostics);
}

const onMessage = (m: unknown) => {
  const req = ((m as { data?: unknown }).data ?? m) as Request;
  handle(req).then(
    result => send({ id: req.id, kind: 'result', result }),
    (e: Error) => send({ id: req.id, kind: 'error', error: e.message, name: e.name }),
  );
};
if (parentPort) parentPort.on('message', onMessage);
else process.on('message', onMessage);
send({ kind: 'ready' });
