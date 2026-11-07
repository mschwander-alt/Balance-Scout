/**
 * Hintergrundprozess für die Windows-App: nimmt Aufträge per Nachricht entgegen und meldet
 * Fortschritt und Ergebnis zurück. Läuft als Electron-utilityProcess oder als Node-Kindprozess.
 */
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { runAudit, writeExcelReport, reportFileName, diagnosticReport, type RunInput, type RunResult } from './index.js';
import { readGrid, detectMapping, parseTrialBalance, type ColumnMapping } from './domain/trialBalance/parser.js';
import { classifyRows, validateTrialBalance, type SignConvention } from './domain/trialBalance/validate.js';

export type Request =
  | { id: string; type: 'previewTrialBalance'; path: string; mapping?: { headerRowIndex: number; mapping: ColumnMapping }; signConvention?: SignConvention }
  | { id: string; type: 'run'; input: Omit<RunInput, 'onProgress'>; reportDir: string };

type Port = { postMessage(m: unknown): void; on(ev: 'message', cb: (m: unknown) => void): void };
const parentPort: Port | undefined = (process as unknown as { parentPort?: Port }).parentPort;
const send = (m: unknown) => (parentPort ? parentPort.postMessage(m) : process.send?.(m));

async function previewTrialBalance(r: Extract<Request, { type: 'previewTrialBalance' }>) {
  const grid = await readGrid(await readFile(r.path), path.basename(r.path));
  const detected = detectMapping(grid);
  const head = grid.slice(0, 40).map(row => row.slice(0, 12).map(c => (c === null ? '' : String(c))));
  const mapping = r.mapping ?? detected;
  if (!mapping) return { detected: null, head, accounts: [], validation: null };
  const parsed = parseTrialBalance(grid, mapping);
  const accounts = classifyRows(parsed.rows);
  const validation = validateTrialBalance(accounts, parsed.issues, r.signConvention ?? 'signed');
  return { detected: mapping, head, accounts: accounts.map(a => ({ accountNumber: a.accountNumber, accountName: a.accountName, balance: a.balanceCurrentYear, category: a.category })), validation };
}

export function serializeResult(res: RunResult, excelPath: string, diagnostics: string) {
  const docBy = new Map(res.documents.map(d => [d.doc.id, d]));
  return {
    excelPath,
    diagnostics,
    startedAt: res.startedAt.toISOString(),
    finishedAt: res.finishedAt.toISOString(),
    summary: res.match.summary,
    validation: res.validation,
    accounts: res.accounts.map(a => {
      const m = res.byAccount.get(`${a.accountNumber}#${a.rowIndex}`)!;
      const doc = m.best ? docBy.get(m.best.documentId) : undefined;
      return {
        accountNumber: a.accountNumber, accountName: a.accountName, groupName: a.groupName, category: a.category,
        balance: a.balanceCurrentYear, balancePreviousYear: a.balancePreviousYear, status: m.status, reasons: m.reasons,
        best: m.best ? { ...m.best, relPath: doc?.doc.relPath ?? null, absPath: doc?.doc.absPath ?? null, newPath: doc?.placement?.newPath ?? null, pageLabel: doc?.doc.pageLabels[m.best.page] ?? null } : null,
        candidates: m.candidates.slice(1).map(c => ({ filename: c.filename, page: c.page, line: c.line, score: c.score, evidenceCents: c.evidenceCents, flags: c.flags })),
      };
    }),
    documents: res.documents.map(d => ({
      id: d.doc.id, filename: d.doc.filename, relPath: d.doc.relPath, absPath: d.doc.absPath, ext: d.doc.ext, size: d.doc.size,
      status: d.doc.status, method: d.doc.method, pageCount: d.doc.pageCount, ocrPages: d.doc.ocrPages, ocrConfidence: d.doc.ocrConfidence,
      warnings: d.doc.warnings, docType: d.docType, balanceDate: d.balanceDate, amountCount: d.amountCount,
      assigned: d.assigned, assignedAccounts: d.assignedAccounts, targetName: d.targetName,
      placement: d.placement ? { status: d.placement.status, newPath: d.placement.newPath, message: d.placement.message ?? null } : null,
    })),
  };
}
export type SerializedResult = ReturnType<typeof serializeResult>;

async function handle(req: Request): Promise<unknown> {
  if (req.type === 'previewTrialBalance') return previewTrialBalance(req);
  const res = await runAudit({ ...req.input, onProgress: p => send({ id: req.id, kind: 'progress', progress: p }) });
  const excelPath = path.join(req.reportDir, reportFileName(req.input.mandate, req.input.closingDate));
  send({ id: req.id, kind: 'progress', progress: { phase: 'bericht', message: 'Excel-Dokumentation wird erstellt …' } });
  await writeExcelReport(res, excelPath);
  const diagnostics = diagnosticReport(res);
  await writeFile(excelPath.replace(/\.xlsx$/, '_Diagnose.txt'), diagnostics, 'utf8');
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
