/**
 * Hintergrundprozess für die Windows-App: nimmt Aufträge per Nachricht entgegen und meldet
 * Fortschritt und Ergebnis zurück. Läuft als Electron-utilityProcess oder als Node-Kindprozess.
 */
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { runAudit, writeExcelReport, uniqueReportPath, diagnosticsPathFor, diagnosticReport, loadTrialBalanceFor, type RunInput, type RunResult } from './index.js';
import { classifyRows, validateTrialBalance, type SignConvention } from './domain/trialBalance/validate.js';
import type { ExplicitMapping } from './domain/trialBalance/load.js';
import { KMU_GROUPS, defaultGroupLetters, applyGroupOverrides, type GroupOverrides } from './domain/trialBalance/accountGroups.js';
import { finalizeAudit, type ReviewDecisions } from './finalize.js';
import { loadSnapshot, saveSnapshot } from './snapshot.js';
import type { FileMode } from './organize/placeFiles.js';

import { renderPreview } from './preview.js';

export type Request =
  | { id: string; type: 'preview'; absPath: string; page: number }
  | {
      id: string; type: 'previewTrialBalance'; path?: string; paths?: string[]; mapping?: ExplicitMapping; mappings?: Record<string, ExplicitMapping>;
      accountDigits?: { min: number; max: number }; signConvention?: SignConvention; ocr?: { langPath?: string }; skipParts?: string[]; forceParts?: string[]; skipZeroBalances?: boolean; partRoles?: Record<string, import('./domain/trialBalance/load.js').PartRole>;
    }
  /** Analyse (Lesen + Abgleich). Mit snapshotPath: ohne Ablage/Excel – Abschluss folgt nach der Durchsicht. */
  | { id: string; type: 'run'; input: Omit<RunInput, 'onProgress'>; reportDir: string; snapshotPath?: string }
  | { id: string; type: 'finalize'; snapshotPath: string; decisions: ReviewDecisions; targetDir: string | null; fileMode: FileMode; reportDir: string }
  | { id: string; type: 'groups' }
  /** Vertiefte Prüfung Sachanlagen: Anlagespiegel (optional als Excel speichern) */
  | { id: string; type: 'addDocument'; snapshotPath: string; path: string; ocr?: { langPath?: string } }
  | { id: string; type: 'ledgerAccount'; snapshotPath: string; accountNumber: string }
  | { id: string; type: 'accruals'; snapshotPath: string; groupOverrides?: GroupOverrides; manual?: Record<string, import('./analysis/accruals.js').ManualAccrual[]>; edits?: Record<string, { label?: string; cy?: number; py?: number }>; attachments?: { id: string; name: string; path: string; account: string; position?: string | null }[]; accounts?: string[]; classes?: Record<string, 'vorjahr' | 'laufend' | 'unterjaehrig'>; notes?: Record<string, { text: string }>; note?: string; visum?: string; exportPath?: string }
  | { id: string; type: 'income'; snapshotPath: string; groupOverrides?: GroupOverrides; base?: import('./analysis/incomeStatement.js').IncomeBase | null; placements?: import('./analysis/incomeStatement.js').IncomePlacements; rowBases?: Record<string, import('./analysis/incomeStatement.js').IncomeBase>; notes?: Record<string, { text: string; at?: string; visum?: string }>; exportPath?: string; visum?: string }
  | { id: string; type: 'fixedAssets'; snapshotPath: string; groupOverrides?: GroupOverrides; manual?: Record<string, import('./analysis/fixedAssets.js').ManualFixedPosting[]>; accounts?: string[]; categories?: Record<string, string>; classes?: Record<string, 'zugang' | 'abgang' | 'abschreibung' | 'umbuchung'>; exportPath?: string; findings?: { text: string; status: 'offen' | 'erledigt' }[]; note?: string; visum?: string }
  /** ESTV-Kursliste (PDF) lesen */
  | { id: string; type: 'rates'; path: string }
  /** Vertiefte Prüfung Forderungen: Fälligkeitsanalyse (optional als Excel speichern) */
  | { id: string; type: 'receivables'; snapshotPath: string; groupOverrides?: GroupOverrides; docId?: string | null; docIds?: string[]; accounts?: string[]; assigned?: Record<string, string[]>; termDays?: number; rates?: Record<string, number>; dueMode?: 'auto' | 'term' | 'lastDate'; customerTerms?: Record<string, number>; corrections?: Record<string, { due?: string | null; date?: string | null; amount?: number; exclude?: boolean; customerName?: string; comment?: string }>; listDate?: string | null; exportPath?: string; exportFormat?: 'xlsx' | 'pptx'; findings?: { text: string; status: 'offen' | 'erledigt' }[]; visum?: string; note?: string };

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
      ocr, accountDigits: r.accountDigits, skipParts: r.skipParts, forceParts: r.forceParts, skipZeroBalances: r.skipZeroBalances, partRoles: r.partRoles,
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
        autoGroup: a.autoGroup ?? null, source: a.source ?? null, category: a.category, manual: res.review?.manual.get(a.accountNumber) ?? null,
        fx: res.accountLedger?.[a.accountNumber] ?? null,
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
    analysisFiles: res.analysisFiles ?? [],
    ledger: res.ledger ? { accounts: res.ledger.accounts.length, fxAccounts: res.ledger.accounts.filter(a => a.currency !== 'CHF').length, consistent: res.ledger.accounts.filter(a => a.consistent).length, warnings: res.ledger.warnings, sources: (res.ledger as { sources?: string[] }).sources ?? [] } : null,
    fxRates: res.input.fxRates ?? null,
  };
}
export type SerializedResult = ReturnType<typeof serializeResult>;

async function handle(req: Request): Promise<unknown> {
  if (req.type === 'previewTrialBalance') return previewTrialBalance(req);
  if (req.type === 'preview') return renderPreview(req.absPath, req.page);
  if (req.type === 'groups') {
    const { DEFAULT_PROCEDURES, GENERIC_PROCEDURES } = await import('./analysis/procedures.js');
    return { procedures: DEFAULT_PROCEDURES, genericProcedures: GENERIC_PROCEDURES, groups: KMU_GROUPS.map(g => ({ code: g.code, name: g.name, category: g.category, subcategory: g.subcategory })), letters: defaultGroupLetters(), general: { code: 'ALLG', name: 'Allgemeine Prüfungen (Belege ohne Konto)', account: '@allgemein' } };
  }
  if (req.type === 'fixedAssets') {
    // vom Prüfer verschobene Konten (Gruppe) gelten auch für die Prüfgebiete
    const snap = await loadSnapshot(req.snapshotPath);
    const res = { ...snap, accounts: applyGroupOverrides(snap.accounts, req.groupOverrides) };
    const { fixedAssetsFor } = await import('./analysis/fixedAssets.js');
    const r = fixedAssetsFor(res, req);
    if (req.exportPath && r.available) {
      const { fixedAssetsWorkbook } = await import('./report/fixedAssetsExcel.js');
      await writeFile(req.exportPath, await fixedAssetsWorkbook(r, { mandate: res.input.mandate, closingDate: res.input.closingDate ?? '', findings: req.findings ?? [], note: req.note, visum: req.visum, sources: res.ledger?.sources }));
    }
    return r;
  }
  if (req.type === 'addDocument') {
    // Vom Prüfer hochgeladener Nachweis: lesen (auch Scan), in die Prüfung aufnehmen; Zuordnung zum Konto folgt als Entscheid
    const snap = await loadSnapshot(req.snapshotPath);
    const { readDocument } = await import('./ingest/readDocument.js');
    const { summarizeUploadedDocument } = await import('./run.js');
    const relBase = `Nachweise Prüfer/${path.basename(req.path)}`;
    let rel = relBase;
    for (let n = 2; snap.documents.some(d => d.doc.relPath === rel); n++) rel = relBase.replace(/(\.[^.]+)?$/, m => ` (${n})${m}`);
    const { LocalOcr } = await import('./ingest/ocr.js');
    const ocr = new LocalOcr(req.ocr);
    let doc;
    try { doc = await readDocument(req.path, rel, { ocr }); } finally { await ocr.close(); }
    const sum = summarizeUploadedDocument(doc, snap.input.closingDate);
    snap.documents.push(sum);
    await saveSnapshot(snap, req.snapshotPath);
    const d = sum;
    return {
      id: d.doc.id, filename: d.doc.filename, relPath: d.doc.relPath, absPath: d.doc.absPath, ext: d.doc.ext, size: d.doc.size,
      status: d.doc.status, method: d.doc.method, pageCount: d.doc.pageCount, ocrPages: d.doc.ocrPages, ocrConfidence: d.doc.ocrConfidence,
      warnings: d.doc.warnings, docType: d.docType, balanceDate: d.balanceDate, amountCount: d.amountCount,
      assigned: false, assignedAccounts: [], targetName: d.targetName, placement: null, notePath: null,
      keyAmount: d.keyAmount ?? null, keyDate: d.keyDate ?? null, amountSet: d.amountSet ?? [], searchText: d.searchText ?? '', register: null, irrelevant: false,
      uploaded: true,
    };
  }
  if (req.type === 'ledgerAccount') {
    // Kontoblatt eines Kontos für die Vorschau (Reiter „Kontoblatt“): Datei, Kontokopf, Kennzahlen, Buchungen
    const snap = await loadSnapshot(req.snapshotPath);
    const norm = (n: string) => n.replace(/\D/g, '').replace(/^0+/, '');
    const la = snap.ledger?.accounts.find(a => norm(a.accountNumber) === norm(req.accountNumber));
    const tb = snap.accounts.find(a => a.accountNumber === req.accountNumber);
    if (!snap.ledger?.accounts.length) return { available: false, reason: 'Keine Kontoblätter in dieser Prüfung – bei „Neue Prüfung“, Schritt 4, hinzufügen.' };
    if (!la) return { available: false, reason: `Konto ${req.accountNumber} kommt in den Kontoblättern nicht vor.` };
    // ältere Prüfungen: Datei über den Namen aus den angegebenen Kontoblättern bzw. den Belegen finden
    const sourcePath = la.sourcePath
      ?? snap.input.ledgerPaths?.find(p => path.basename(p) === la.source)
      ?? snap.documents.find(d => d.doc.filename === la.source)?.doc.absPath ?? null;
    const head = la.head ?? (la.postings[0] ? { page: la.postings[0].page, lineNo: la.postings[0].lineNo, bbox: la.postings[0].bbox } : { page: la.pages[0] ?? 1, lineNo: 1 });
    return {
      available: !!sourcePath, reason: sourcePath ? undefined : `Datei des Kontoblatts „${la.source}“ nicht gefunden.`,
      sourcePath, source: la.source, accountNumber: la.accountNumber, accountName: la.accountName, currency: la.currency,
      opening: la.opening, closing: la.closing, debitTotal: la.debitTotal, creditTotal: la.creditTotal, consistent: la.consistent,
      tbBalance: tb ? tb.balanceCurrentYear : null, head, pages: la.pages,
      postings: la.postings.map(p => ({ date: p.date, text: p.text, contra: p.contra, docNo: p.docNo, amount: p.amount, balance: p.balance, page: p.page, lineNo: p.lineNo, bbox: p.bbox })),
    };
  }
  if (req.type === 'accruals') {
    // Rechnungsabgrenzungen: Vorjahresvergleich aus den Kontoblättern (vom Prüfer verschobene Konten berücksichtigt)
    const snap = await loadSnapshot(req.snapshotPath);
    const res = { ...snap, accounts: applyGroupOverrides(snap.accounts, req.groupOverrides) };
    const { accrualsFor } = await import('./analysis/accruals.js');
    const r = accrualsFor(res, req);
    if (req.exportPath && r.available) {
      const { accrualsWorkbook } = await import('./report/accrualsExcel.js');
      await writeFile(req.exportPath, await accrualsWorkbook(r, { mandate: snap.input.mandate, closingDate: snap.input.closingDate ?? '', notes: req.notes, note: req.note, visum: req.visum,
        // Registernummern (z. B. G.100.1) entstehen erst beim Abschliessen
        attachments: (req.attachments ?? []).map((f, i) => ({ register: `Beilage ${i + 1}`, name: f.name, account: f.account, position: f.position ?? null })) }));
    }
    return r;
  }
  if (req.type === 'income') {
    // Analyse der Erfolgsrechnung: Staffel, Margen, Vorjahr, Bemerkungen (vom Prüfer verschobene Konten berücksichtigt)
    const snap = await loadSnapshot(req.snapshotPath);
    const accounts = applyGroupOverrides(snap.accounts, req.groupOverrides);
    const { analyzeIncomeStatement } = await import('./analysis/incomeStatement.js');
    const r = analyzeIncomeStatement(accounts, { base: req.base, placements: req.placements, rowBases: req.rowBases });
    if (req.exportPath) {
      const { incomeWorkbook } = await import('./report/incomeExcel.js');
      await writeFile(req.exportPath, await incomeWorkbook(r, req.notes ?? {}, { mandate: snap.input.mandate, closingDate: snap.input.closingDate ?? '', visum: req.visum }));
    }
    return r;
  }
  if (req.type === 'rates') {
    const { readDocument } = await import('./ingest/readDocument.js');
    const { parseEstvRates, looksLikeRateList } = await import('./ingest/fxRates.js');
    const { LocalOcr } = await import('./ingest/ocr.js');
    const ocr = new LocalOcr();
    try {
      const d = await readDocument(req.path, path.basename(req.path), { ocr, maxOcrPages: 0 });
      if (!looksLikeRateList(d.lines)) throw new Error('Die Datei sieht nicht wie eine ESTV-Kursliste aus (Devisen – Banknoten).');
      const r = parseEstvRates(d.lines, `ESTV Kursliste ${path.basename(req.path)}`);
      if (!Object.keys(r.rates).length) throw new Error('In der Datei wurden keine Kurse gefunden.');
      return r;
    } finally {
      await ocr.close();
    }
  }
  if (req.type === 'receivables') {
    // vom Prüfer verschobene Konten (Gruppe) gelten auch für die Prüfgebiete
    const snap = await loadSnapshot(req.snapshotPath);
    const res = { ...snap, accounts: applyGroupOverrides(snap.accounts, req.groupOverrides) };
    const { receivablesFor } = await import('./analysis/receivables.js');
    // Zuordnung aus der Durchsicht (inkl. manueller Änderungen) kommt von der App
    const r = receivablesFor(res, req, req.assigned);
    if (req.exportPath && r.aging) {
      const meta = { mandate: res.input.mandate, closingDate: res.input.closingDate!, sourceFile: r.filename ?? '', balanceChf: r.balanceChf, balanceAccounts: r.balanceAccounts, findings: req.findings ?? [], visum: req.visum, note: req.note };
      if (req.exportFormat === 'pptx') {
        const { agingPptx } = await import('./report/agingPptx.js');
        await writeFile(req.exportPath, await agingPptx(r.aging, meta));
      } else {
        const { agingWorkbook } = await import('./report/agingExcel.js');
        await writeFile(req.exportPath, await agingWorkbook(r.aging, meta));
      }
    }
    // Für die Anzeige: Posten mit Lage auf der Seite (Vorschau), ohne Textauszug
    return r;
  }
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
