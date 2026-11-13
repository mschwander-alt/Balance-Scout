/**
 * Abschluss einer Prüfung nach der Durchsicht durch die Prüferin / den Prüfer:
 *  - manuell akzeptierte Konten (Prüfen -> Belegt)
 *  - manuell zugeordnete Belege (Datei -> Konto, oder "nicht relevant")
 *  - Notizen je Konto (als Notizseite vor dem PDF bzw. als eigenes Notiz-PDF)
 *  - Registerbuchstaben je Gruppe des KMU-Kontenrahmens: B.1_…, B.2_…
 * Danach Ablage und Excel-Dokumentation.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunResult, DocumentSummary } from './run.js';
import type { AccountResult, AccountStatus, MatchSummary } from './domain/matching/engine.js';
import { placeFiles, type FileMode, type PlacementPlan } from './organize/placeFiles.js';
import { notePdf, prependNote, type NoteEntry } from './report/notePdf.js';
import { KMU_GROUPS, GENERAL_ACCOUNT, GENERAL_GROUP, applyGroupOverrides, type GroupOverrides } from './domain/trialBalance/accountGroups.js';

export const IRRELEVANT_DIR = '03_Nicht_relevant';

export interface ReviewDecisions {
  /** Konto (Nummer) -> manuell als belegt akzeptiert */
  accepted?: Record<string, { at: string; visum: string; comment?: string }>;
  /** Beleg (docId) -> Konto (Nummer) oder null = nicht relevant; accountNumbers = ein Beleg für mehrere Konten */
  assignments?: Record<string, { accountNumber: string | null; accountNumbers?: string[]; at: string; visum: string }>;
  /** Konto (Nummer) -> Notiz */
  notes?: Record<string, { text: string; at: string; visum: string }>;
  /** Gruppe (Code, z. B. "A10") -> Registerbuchstabe (z. B. "B"); leer = ohne Präfix */
  groupLetters?: Record<string, string>;
  /** Konto (Nummer) -> vom Prüfer gewählte Gruppe (Code); Belege und Register folgen dem Konto */
  groupOverrides?: GroupOverrides;
  /** Vertiefte Prüfungen (Prüfgebiete) */
  /** Analyse Erfolgsrechnung: Bemerkungen je Konto (Nummer), Untergruppe (U:…), Gruppe (S:…) oder Ergebnis (R:…) */
  incomeNotes?: Record<string, { text: string; at?: string; visum?: string }>;
  /** Analyse Erfolgsrechnung: Bezugsgrösse der Prozente und Platzierung verschobener Konten */
  incomeBase?: import('./analysis/incomeStatement.js').IncomeBase | null;
  incomePlacements?: import('./analysis/incomeStatement.js').IncomePlacements;
  incomeRowBases?: Record<string, import('./analysis/incomeStatement.js').IncomeBase>;
  analyses?: {
    accruals?: { accounts?: string[]; classes?: Record<string, 'vorjahr' | 'laufend' | 'unterjaehrig'>; notes?: Record<string, { text: string }>; note?: string; visum?: string };
    fixedAssets?: { accounts?: string[]; categories?: Record<string, string>; classes?: Record<string, 'zugang' | 'abgang' | 'abschreibung' | 'umbuchung'>; findings: { text: string; status: 'offen' | 'erledigt' }[]; note?: string; visum?: string };
    receivables?: { docId: string | null; docIds?: string[]; accounts?: string[]; termDays: number; rates: Record<string, number>; findings: { text: string; status: 'offen' | 'erledigt' }[]; visum?: string; note?: string; assigned?: Record<string, string[]> };
  };
}

export interface Review {
  decisions: ReviewDecisions;
  /** docId -> Register, z. B. "B.1" */
  registers: Map<string, string>;
  /** Konto -> manuell (akzeptiert / zugeordnet) */
  manual: Map<string, 'akzeptiert' | 'zugeordnet'>;
  /** docId -> nicht relevant */
  irrelevant: Set<string>;
}

/** Konten einer manuellen Zuordnung (ein oder mehrere) */
export const assignedAccounts = (a: { accountNumber: string | null; accountNumbers?: string[] }) =>
  a.accountNumbers?.length ? a.accountNumbers : a.accountNumber ? [a.accountNumber] : [];

const fmt = (iso: string) => iso.slice(0, 10).split('-').reverse().join('.');

/** Wendet die Entscheide auf eine Kopie des Ergebnisses an (Status, Zuordnung, Kennzahlen). */
export function applyReview(res: RunResult, d: ReviewDecisions): RunResult & { review: Review } {
  // Vom Prüfer verschobene Konten: neue Gruppe für Register, Excel und Prüfgebiete
  res = { ...res, accounts: applyGroupOverrides(res.accounts, d.groupOverrides) };
  const results: AccountResult[] = res.match.results.map(r => ({ ...r, reasons: [...r.reasons], candidates: [...r.candidates] }));
  const byNumber = new Map(results.map(r => [r.accountNumber, r]));
  const manual = new Map<string, 'akzeptiert' | 'zugeordnet'>();
  const docsAssigned = new Map<string, string[]>(res.documents.map(x => [x.doc.id, [...x.assignedAccounts]]));
  const irrelevant = new Set<string>();

  // Manuelle Zuordnung Beleg -> Konto
  for (const [docId, a] of Object.entries(d.assignments ?? {})) {
    const doc = res.documents.find(x => x.doc.id === docId);
    if (!doc) continue;
    const targets = assignedAccounts(a);
    // Bisherige automatische Zuordnung dieses Belegs aufheben (der Prüfer entscheidet)
    for (const r of results) if (r.best?.documentId === docId && !targets.includes(r.accountNumber) && r.status === 'PRUEFEN') {
      r.status = 'KEIN_NACHWEIS';
      r.reasons.unshift(`Beleg vom Prüfer einem anderen Konto zugeordnet (${a.visum}, ${fmt(a.at)}).`);
      r.best = null;
    }
    if (a.accountNumber === null && !a.accountNumbers?.length) {
      irrelevant.add(docId);
      docsAssigned.set(docId, []);
      continue;
    }
    if (targets.length === 1 && targets[0] === GENERAL_ACCOUNT) {
      // Allgemeine Prüfungen (Register A): zugeordnet, aber zu keinem Konto
      docsAssigned.set(docId, [GENERAL_ACCOUNT]);
      continue;
    }
    docsAssigned.set(docId, targets.filter(n => n === GENERAL_ACCOUNT || byNumber.has(n)));
    for (const num of targets) {
      const r = byNumber.get(num);
      if (!r) continue;
      if (r.status === 'BELEGT' && r.best && r.best.documentId !== docId) {
        r.reasons.push(`Weiterer Beleg manuell zugeordnet: ${doc.doc.filename} (${a.visum}, ${fmt(a.at)}).`);
        continue;
      }
      const existing = [r.best, ...r.candidates].find(c => c?.documentId === docId) ?? null;
      r.best = existing ?? {
        documentId: docId, filename: doc.doc.filename, page: 1, lineNo: 0, source: 'manuell', line: 'manuell zugeordnet', raw: '',
        evidenceCents: Number.NaN, differenceCents: Number.NaN, kind: 'exact', score: 0, flags: [], reasons: ['Vom Prüfer manuell zugeordnet.'],
      } as AccountResult['best'];
      if (r.status !== 'BELEGT') {
        r.status = 'BELEGT';
        r.reasons.unshift(`Beleg ${doc.doc.filename} manuell zugeordnet${targets.length > 1 ? ` (zusammen mit Konto ${targets.filter(t => t !== num).join(', ')})` : ''} (${a.visum}, ${fmt(a.at)}).`);
        manual.set(r.accountNumber, 'zugeordnet');
      }
    }
  }
  // Manuell akzeptiert: Prüfen -> Belegt
  for (const [num, a] of Object.entries(d.accepted ?? {})) {
    const r = byNumber.get(num);
    if (!r || r.status !== 'PRUEFEN') continue;
    r.status = 'BELEGT';
    r.reasons.unshift(`Manuell als belegt akzeptiert (${a.visum}, ${fmt(a.at)})${a.comment ? `: ${a.comment}` : ''}.`);
    manual.set(num, 'akzeptiert');
  }
  // Automatische Zuordnungen (Belegt/Prüfen) ergänzen, sofern kein manueller Entscheid für den Beleg vorliegt
  for (const r of results) {
    if ((r.status === 'BELEGT' || r.status === 'PRUEFEN') && r.best && !d.assignments?.[r.best.documentId]) {
      const cur = docsAssigned.get(r.best.documentId) ?? [];
      if (!cur.includes(r.accountNumber)) docsAssigned.set(r.best.documentId, [...cur, r.accountNumber]);
    }
  }
  // Beleg, der keinem Konto mehr massgebend zugeordnet ist, gilt als nicht zugeordnet
  for (const [docId, accs] of docsAssigned) {
    if (d.assignments?.[docId]) continue;
    docsAssigned.set(docId, accs.filter(n => n === GENERAL_ACCOUNT || byNumber.get(n)?.best?.documentId === docId));
  }

  const summary = recomputeSummary(res.match.summary, results);
  const documents: DocumentSummary[] = res.documents.map(x => {
    const acc = docsAssigned.get(x.doc.id) ?? [];
    return { ...x, assignedAccounts: acc, assigned: acc.length > 0 };
  });
  const registers = assignRegisters(res, documents, d.groupLetters ?? {});
  return {
    ...res,
    match: { summary, results },
    byAccount: new Map(results.map(r => [r.accountId, r])),
    documents,
    review: { decisions: d, registers, manual, irrelevant },
  };
}

function recomputeSummary(s: MatchSummary, results: AccountResult[]): MatchSummary {
  const counts = { BELEGT: 0, PRUEFEN: 0, KEIN_NACHWEIS: 0, NULLSALDO: 0, NICHT_IM_UMFANG: 0 } as Record<AccountStatus, number>;
  let inScope = 0;
  let ok = 0;
  for (const r of results) {
    counts[r.status]++;
    if (r.status !== 'NICHT_IM_UMFANG') inScope += Math.abs(r.balance);
    if (r.status === 'BELEGT') ok += Math.abs(r.balance);
  }
  return { ...s, counts, inScopeAbsTotal: inScope, confirmedAbsTotal: ok, coverage: inScope ? ok / inScope : 0 };
}

/**
 * Register je Beleg: Buchstabe der Gruppe des (kleinsten) zugeordneten Kontos + laufende Nummer.
 * Reihenfolge innerhalb der Gruppe: Kontonummer, dann Dateiname.
 */
export function assignRegisters(res: RunResult, documents: DocumentSummary[], letters: Record<string, string>): Map<string, string> {
  const groupOf = new Map(res.accounts.map(a => [a.accountNumber, a.groupCode]));
  const items: { docId: string; letter: string; key: string }[] = [];
  for (const d of documents) {
    if (!d.assigned) continue;
    const acc = [...d.assignedAccounts].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }))[0]!;
    const g = acc === GENERAL_ACCOUNT ? GENERAL_GROUP : groupOf.get(acc);
    const letter = (g && letters[g]?.trim()) || '';
    if (!letter) continue;
    items.push({ docId: d.doc.id, letter, key: `${acc.padStart(12, '0')} ${d.doc.filename.toLowerCase()}` });
  }
  const out = new Map<string, string>();
  const byLetter = new Map<string, typeof items>();
  for (const it of items) byLetter.set(it.letter, [...(byLetter.get(it.letter) ?? []), it]);
  for (const [letter, list] of byLetter) {
    list.sort((a, b) => a.key.localeCompare(b.key, 'de'));
    list.forEach((it, i) => out.set(it.docId, `${letter}.${i + 1}`));
  }
  return out;
}

export const groupNameOf = (code: string) => KMU_GROUPS.find(g => g.code === code)?.name ?? code;

/** Ablage nach der Durchsicht: Register-Präfix, Notizen, Ordner 01/02/03. */
export async function placeReviewed(
  res: RunResult & { review: Review },
  targetDir: string,
  mode: FileMode,
  baseNames: Map<string, string>,
): Promise<RunResult & { review: Review }> {
  if (mode === 'none') return res;
  const { registers, irrelevant, decisions } = res.review;
  const accById = new Map(res.accounts.map(a => [a.accountNumber, a]));
  // Notizen je Beleg sammeln (massgebender Beleg des Kontos)
  const notesByDoc = new Map<string, NoteEntry[]>();
  for (const [num, n] of Object.entries(decisions.notes ?? {})) {
    if (!n.text.trim()) continue;
    const r = res.match.results.find(x => x.accountNumber === num);
    const docId = r?.best?.documentId;
    if (!docId) continue;
    notesByDoc.set(docId, [...(notesByDoc.get(docId) ?? []), { accountNumber: num, accountName: accById.get(num)?.accountName ?? '', text: n.text, visum: n.visum, at: n.at }]);
  }
  const plans: PlacementPlan[] = [];
  for (const d of res.documents) {
    const reg = registers.get(d.doc.id);
    const base = baseNames.get(d.doc.id) ?? d.doc.filename;
    const targetName = reg ? `${reg}_${base}` : base;
    const notes = notesByDoc.get(d.doc.id);
    const header = { mandate: res.input.mandate, closingDate: res.input.closingDate, register: reg ?? null, documentName: d.doc.filename };
    let content: Buffer | undefined;
    if (notes && d.doc.ext === '.pdf') content = (await prependNote(await readFile(d.doc.absPath), header, notes)) ?? undefined;
    plans.push({
      docId: d.doc.id, absPath: d.doc.absPath, relPath: d.doc.relPath, sha256: d.doc.sha256, assigned: d.assigned,
      targetName, subDir: irrelevant.has(d.doc.id) ? IRRELEVANT_DIR : undefined, content,
    });
    // Excel, Word, Bilder (oder nicht veränderbares PDF): separates Notiz-PDF neben dem Beleg
    if (notes && !content) {
      const stem = base.slice(0, base.length - path.extname(base).length);
      plans.push({
        docId: `${d.doc.id}#notiz`, absPath: d.doc.absPath, relPath: d.doc.relPath, sha256: '', assigned: d.assigned,
        targetName: `${reg ? `${reg}_` : ''}Notiz_${stem}.pdf`, content: await notePdf(header, notes), generated: true,
        subDir: irrelevant.has(d.doc.id) ? IRRELEVANT_DIR : undefined,
      });
    }
  }
  // Vertiefte Prüfung Forderungen: Fälligkeitsanalyse als eigener Nachweis (z. B. E.5_Analyse_Fälligkeit.xlsx)
  const rcv = decisions.analyses?.receivables;
  if (rcv) {
    const { receivablesFor } = await import('./analysis/receivables.js');
    const { agingWorkbook } = await import('./report/agingExcel.js');
    // dieselbe Zuordnung wie in der Durchsicht (App), damit Nachweis und Anzeige übereinstimmen
    const r = receivablesFor(res, rcv, rcv.assigned);
    if (r.aging) {
      const { agingPptx } = await import('./report/agingPptx.js');
      const letter = decisions.groupLetters?.A12?.trim() ?? '';
      const used = [...registers.values()].filter(x => letter && x.startsWith(`${letter}.`)).length;
      const stem = `${letter ? `${letter}.${used + 1}_` : ''}Analyse_Fälligkeit`;
      const meta = {
        mandate: res.input.mandate, closingDate: res.input.closingDate!, sourceFile: r.filename ?? '', balanceChf: r.balanceChf,
        balanceAccounts: r.balanceAccounts, findings: rcv.findings, visum: rcv.visum, note: rcv.note, letter: letter || undefined,
      };
      const src = res.documents.find(d => d.doc.id === r.docId)?.doc.absPath ?? '';
      plans.push({ docId: 'analyse:forderungen', absPath: src, relPath: `${stem}.xlsx`, sha256: '', assigned: true, targetName: `${stem}.xlsx`, content: await agingWorkbook(r.aging, meta), generated: true });
      plans.push({ docId: 'analyse:forderungen:pptx', absPath: src, relPath: `${stem}.pptx`, sha256: '', assigned: true, targetName: `${stem}.pptx`, content: await agingPptx(r.aging, meta), generated: true });
    }
  }
  // Vertiefte Prüfung Sachanlagen: Anlagespiegel als Nachweis (Register der Sachanlagen, falls vergeben)
  const fa = decisions.analyses?.fixedAssets;
  if (fa && res.ledger) {
    const { fixedAssetsFor } = await import('./analysis/fixedAssets.js');
    const { fixedAssetsWorkbook } = await import('./report/fixedAssetsExcel.js');
    const r = fixedAssetsFor(res, fa);
    if (r.available && r.rows.length) {
      const letter = (decisions.groupLetters?.A21 || decisions.groupLetters?.A22 || '').trim();
      const used = [...registers.values()].filter(x => letter && x.startsWith(`${letter}.`)).length;
      const name = `${letter ? `${letter}.${used + 1}_` : ''}Analyse_Anlagespiegel.xlsx`;
      plans.push({ docId: 'analyse:anlagen', absPath: '', relPath: name, sha256: '', assigned: true, targetName: name, generated: true,
        content: await fixedAssetsWorkbook(r, { mandate: res.input.mandate, closingDate: res.input.closingDate ?? '', findings: fa.findings, note: fa.note, visum: fa.visum, sources: res.ledger.sources }) });
    }
  }
  // Rechnungsabgrenzungen: Vorjahresvergleich als Nachweis (Register der aktiven Rechnungsabgrenzungen, falls vergeben)
  const acr = decisions.analyses?.accruals;
  if (acr && res.ledger) {
    const { accrualsFor } = await import('./analysis/accruals.js');
    const { accrualsWorkbook } = await import('./report/accrualsExcel.js');
    const r = accrualsFor(res, acr);
    if (r.available && r.accounts.length) {
      const letter = (decisions.groupLetters?.A15 || decisions.groupLetters?.P13 || '').trim();
      const used = [...registers.values()].filter(x => letter && x.startsWith(`${letter}.`)).length;
      const name = `${letter ? `${letter}.${used + 1}_` : ''}Analyse_Rechnungsabgrenzungen.xlsx`;
      plans.push({ docId: 'analyse:abgrenzungen', absPath: '', relPath: name, sha256: '', assigned: true, targetName: name, generated: true,
        content: await accrualsWorkbook(r, { mandate: res.input.mandate, closingDate: res.input.closingDate ?? '', notes: acr.notes, note: acr.note, visum: acr.visum }) });
    }
  }
  // Analyse der Erfolgsrechnung: als Nachweis, sobald Bemerkungen erfasst sind
  const notes = Object.fromEntries(Object.entries(decisions.incomeNotes ?? {}).filter(([, n]) => n.text.trim()));
  if (Object.keys(notes).length) {
    const { analyzeIncomeStatement } = await import('./analysis/incomeStatement.js');
    const { incomeWorkbook } = await import('./report/incomeExcel.js');
    const name = 'Analyse_Erfolgsrechnung.xlsx';
    plans.push({ docId: 'analyse:erfolgsrechnung', absPath: '', relPath: name, sha256: '', assigned: true, targetName: name, generated: true,
      content: await incomeWorkbook(analyzeIncomeStatement(res.accounts, { base: decisions.incomeBase, placements: decisions.incomePlacements, rowBases: decisions.incomeRowBases }), notes, { mandate: res.input.mandate, closingDate: res.input.closingDate ?? '' }) });
  }
  const placed = await placeFiles(targetDir, plans, mode);
  const by = new Map(placed.map(p => [p.docId, p]));
  const analysisFiles = (['analyse:forderungen', 'analyse:forderungen:pptx', 'analyse:anlagen', 'analyse:abgrenzungen', 'analyse:erfolgsrechnung'] as const)
    .map(k => ({ k, x: by.get(k) })).filter(({ x }) => !!x?.newPath)
    .map(({ k, x }) => ({ kind: k === 'analyse:anlagen' ? 'anlagen' : k === 'analyse:erfolgsrechnung' ? 'erfolgsrechnung' : k === 'analyse:abgrenzungen' ? 'abgrenzungen' : 'forderungen', name: path.basename(x!.newPath!), path: x!.newPath!, relPath: x!.newRelPath }));
  return {
    ...res,
    analysisFiles,
    documents: res.documents.map(d => ({
      ...d,
      targetName: plans.find(p => p.docId === d.doc.id)!.targetName,
      placement: by.get(d.doc.id) ?? null,
      notePlacement: by.get(`${d.doc.id}#notiz`) ?? null,
    })),
  };
}

/** Kompletter Abschluss: Entscheide anwenden, ablegen, Excel und Diagnose schreiben. */
export async function finalizeAudit(
  res: RunResult,
  decisions: ReviewDecisions,
  opts: { targetDir: string | null; fileMode: FileMode; reportDir: string },
): Promise<{ result: RunResult & { review: Review }; excelPath: string; diagnostics: string }> {
  const { planTargetNames } = await import('./organize/placeFiles.js');
  const { writeExcelReport, uniqueReportPath, diagnosticsPathFor } = await import('./report/excel.js');
  const { diagnosticReport } = await import('./report/diagnostics.js');
  const { writeFile } = await import('node:fs/promises');
  let reviewed = applyReview(res, decisions);
  reviewed = { ...reviewed, input: { ...reviewed.input, targetDir: opts.targetDir, fileMode: opts.fileMode } };
  if (opts.targetDir && opts.fileMode !== 'none') {
    const names = planTargetNames(reviewed.documents.map(d => ({ docId: d.doc.id, relPath: d.doc.relPath })));
    reviewed = await placeReviewed(reviewed, opts.targetDir, opts.fileMode, names);
  }
  const excelPath = await uniqueReportPath(opts.reportDir, res.input.mandate, res.input.closingDate);
  await writeExcelReport(reviewed, excelPath);
  const diagnostics = diagnosticReport(reviewed);
  await writeFile(diagnosticsPathFor(excelPath), diagnostics, { encoding: 'utf8', flag: 'wx' });
  return { result: reviewed, excelPath, diagnostics };
}
