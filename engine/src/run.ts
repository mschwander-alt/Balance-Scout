import path from 'node:path';
import type { Cents } from './domain/amount.js';
import { classifyRows, validateTrialBalance, type ClassifiedAccount, type SignConvention, type ValidationReport } from './domain/trialBalance/validate.js';
import { type ColumnMapping } from './domain/trialBalance/parser.js';
import { loadTrialBalance, type ExplicitMapping, type LoadedTrialBalance } from './domain/trialBalance/load.js';
import { extractAmounts, type AmountCandidate } from './domain/matching/extractAmounts.js';
import { runMatching, type AccountResult, type MatchOutput } from './domain/matching/engine.js';
import { listFiles, readDocument, type EvidenceDocument } from './ingest/readDocument.js';
import { LocalOcr, type OcrOptions } from './ingest/ocr.js';
import { detectBalanceDate, findDates, guessDocType } from './ingest/documentFacts.js';
import { placeFiles, planTargetNames, type FileMode, type PlacementResult } from './organize/placeFiles.js';

export interface RunInput {
  mandate: string;
  client?: string;
  /** Bilanzstichtag ISO (YYYY-MM-DD) */
  closingDate: string | null;
  /** Erste/einzige Datei der Saldobilanz */
  trialBalancePath: string;
  /** Alle Dateien (z. B. Bilanz und Erfolgsrechnung getrennt); Standard: [trialBalancePath] */
  trialBalancePaths?: string[];
  /** Spaltenzuordnung für den ersten Teil (Kompatibilität) */
  trialBalanceMapping?: { headerRowIndex: number; mapping: ColumnMapping };
  /** Spaltenzuordnung je Teil (Datei bzw. "Datei#Blatt") */
  trialBalanceMappings?: Record<string, ExplicitMapping>;
  /** Kontonummern haben min..max Ziffern; andere Zeilen (Gruppen, Zwischensummen) werden ausgeblendet */
  accountDigits?: { min: number; max: number };
  signConvention?: SignConvention;
  /** Ein oder mehrere Ordner (inkl. Unterordner) und/oder einzelne Dateien */
  evidencePaths: string[];
  /** Zielordner für 01_Zugeordnet / 02_Nicht_zugeordnet und das Excel; null = nichts ablegen */
  targetDir: string | null;
  fileMode?: FileMode;
  absoluteToleranceCents?: Cents;
  /** Kontoblätter (PDF mit Textebene oder Excel) – für Fremdwährungskonten, Anlagespiegel usw.; kein Nachweis */
  ledgerPaths?: string[];
  /** Fremdwährungskurse per Stichtag (CHF je Einheit), z. B. aus der ESTV-Kursliste */
  fxRates?: { date: string | null; rates: Record<string, number>; source: string };
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
  /** Für das Belegverzeichnis: massgebender Betrag (Saldo/Total, sonst grösster Betrag) mit Lage */
  keyAmount?: { cents: number; page: number; lineNo: number; line: string; bbox?: { x0: number; y0: number; x1: number; y1: number } } | null;
  /** Erkanntes Datum (Stichtag laut Beleg, sonst erstes Datum) */
  keyDate?: string | null;
  /** Alle Beträge im Beleg (|Rappen|, eindeutig) – für Vorschläge beim Zuordnen */
  amountSet?: number[];
  /** Textauszug (klein geschrieben) für die Suche im Belegverzeichnis */
  searchText?: string;
  /** Separates Notiz-PDF (bei Excel/Word/Bild) */
  notePlacement?: PlacementResult | null;
}

export interface AccountLedgerInfo {
  currency: string;
  /** Saldo laut Kontoblatt in Kontowährung */
  closing: Cents | null;
  opening: Cents | null;
  consistent: boolean;
  /** Fremdwährung: Kurs, CHF-Wert zum Kurs, Bewertungsdifferenz (Buchwert CHF − CHF zum Kurs) */
  rate: number | null;
  rateSource: string | null;
  chfAtRate: Cents | null;
  valuationDiff: Cents | null;
  /** CHF-Konto: Saldo Kontoblatt − Saldo Saldobilanz */
  tbDiff: Cents | null;
}

export interface RunResult {
  input: Omit<RunInput, 'onProgress'>;
  startedAt: Date;
  finishedAt: Date;
  accounts: ClassifiedAccount[];
  validation: ValidationReport;
  trialBalance: Pick<LoadedTrialBalance, 'parts' | 'excluded' | 'digitStats' | 'suggestedDigits'>;
  /** Kontoblätter (zusammengeführt) */
  ledger: import('./ingest/ledger.js').Ledger | null;
  /** Fremdwährung und Abstimmung Kontoblatt je Konto (Kontonummer -> Angaben) */
  accountLedger: Record<string, AccountLedgerInfo>;
  match: MatchOutput;
  documents: DocumentSummary[];
  byAccount: Map<string, AccountResult>;
  /** Entscheide der Prüferin / des Prüfers (nach applyReview) */
  review?: import('./finalize.js').Review;
  /** Abgelegte Analysen der vertieften Prüfung */
  analysisFiles?: { kind: string; name: string; path: string; relPath: string | null }[];
}

export const tbPaths = (input: Pick<RunInput, 'trialBalancePath' | 'trialBalancePaths'>) =>
  input.trialBalancePaths?.length ? input.trialBalancePaths : [input.trialBalancePath];

/** Saldobilanz aus allen Dateien laden; die alte Einzel-Zuordnung gilt für den ersten Teil. */
export async function loadTrialBalanceFor(
  input: Pick<RunInput, 'trialBalancePath' | 'trialBalancePaths' | 'trialBalanceMapping' | 'trialBalanceMappings' | 'accountDigits'>,
  ocr?: LocalOcr,
): Promise<LoadedTrialBalance> {
  const paths = tbPaths(input);
  // Alte Einzel-Zuordnung: gilt für den ersten Teil der ersten Datei (Schlüssel = Pfad)
  const mappings = input.trialBalanceMappings ?? (input.trialBalanceMapping ? { [paths[0]!]: input.trialBalanceMapping } : undefined);
  const tb = await loadTrialBalance(paths, { mappings, accountDigits: input.accountDigits, ocr });
  const err = tb.parts.find(p => p.status === 'zuordnen');
  if (err && !tb.rows.length) {
    const { MappingError } = await import('./domain/trialBalance/parser.js');
    throw new MappingError(`Kopfzeile nicht erkannt (${err.label}). Erwartet werden Spalten für Kontonummer, Bezeichnung und Saldo. Bitte Spalten zuordnen.`);
  }
  return tb;
}

/** Gesamter Ablauf ohne Netzwerk: Saldobilanz -> Belege lesen (inkl. OCR) -> Abgleich -> Ablage. */
export async function runAudit(input: RunInput): Promise<RunResult> {
  const startedAt = new Date();
  const progress = input.onProgress ?? (() => undefined);
  const ocr = new LocalOcr(input.ocr);
  try {
    // 1. Saldobilanz
    progress({ phase: 'saldobilanz', message: 'Saldobilanz wird gelesen …' });
    const tb = await loadTrialBalanceFor(input, ocr);
    const accounts = classifyRows(tb.rows);
    const validation = validateTrialBalance(accounts, tb.issues, input.signConvention ?? 'signed');

    // 2. Belege finden
    progress({ phase: 'suchen', message: 'Belege werden gesucht …' });
    const exclude = [input.targetDir].filter((x): x is string => !!x).map(x => path.resolve(x));
    const tbAbs = new Set(tbPaths(input).map(p => path.resolve(p)));
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
    const evidenceFiles = files.filter(f => !tbAbs.has(path.resolve(f.absPath)));

    // 3. Lesen (inkl. Texterkennung)
    const docs: EvidenceDocument[] = [];
    for (const [i, f] of evidenceFiles.entries()) {
      progress({ phase: 'lesen', message: f.relPath, current: i + 1, total: evidenceFiles.length });
      docs.push(await readDocument(f.absPath, f.relPath, { ocr, onProgress: m => progress({ phase: 'lesen', message: m, current: i + 1, total: evidenceFiles.length }) }));
    }

    // 3b. Kontoblätter: ausdrücklich angegebene sowie im Kundenordner erkannte – sie sind kein Nachweis
    const { parseLedger, looksLikeLedger } = await import('./ingest/ledger.js');
    const ledgerDocs: EvidenceDocument[] = [];
    for (const [i, lp] of (input.ledgerPaths ?? []).entries()) {
      progress({ phase: 'lesen', message: `Kontoblätter ${path.basename(lp)}`, current: i + 1, total: input.ledgerPaths!.length });
      ledgerDocs.push(await readDocument(lp, path.basename(lp), { ocr, maxOcrPages: 0 })); // ohne Texterkennung (grosse Dateien)
    }
    // Kontoblätter im Kundenordner bleiben im Belegverzeichnis, werden aber nicht für den Abgleich verwendet
    const ledgerIds = new Set<string>();
    for (const d of docs) if (looksLikeLedger(d.lines)) { ledgerIds.add(d.id); ledgerDocs.push(d); }
    const ledgers = ledgerDocs.map(d => parseLedger(d.lines, { pageLabels: d.pageLabels, source: d.filename }));
    const ledger = ledgers.length ? {
      accounts: ledgers.flatMap(l => l.accounts), period: ledgers[0]!.period, baseCurrency: ledgers[0]!.baseCurrency,
      warnings: ledgers.flatMap(l => l.warnings), sources: ledgerDocs.map(d => d.relPath),
    } : null;
    const norm = (n: string) => n.replace(/\D/g, '').replace(/^0+/, '');
    const ledgerBy = new Map((ledger?.accounts ?? []).map(a => [norm(a.accountNumber), a]));
    const accountLedger: Record<string, AccountLedgerInfo> = {};
    for (const a of accounts) {
      const la = ledgerBy.get(norm(a.accountNumber));
      if (!la) continue;
      const fx = la.currency !== 'CHF';
      const rate = fx ? input.fxRates?.rates[la.currency] ?? null : null;
      const chfAtRate = fx && rate !== null && la.closing !== null ? Math.round(la.closing * rate) : null;
      accountLedger[a.accountNumber] = {
        currency: la.currency, closing: la.closing, opening: la.opening, consistent: la.consistent,
        rate, rateSource: rate !== null ? input.fxRates?.source ?? null : null, chfAtRate,
        valuationDiff: chfAtRate !== null ? a.balanceCurrentYear - chfAtRate : null,
        tbDiff: !fx && la.closing !== null ? la.closing - a.balanceCurrentYear : null,
      };
    }

    // Hinweise aus den Kontoblättern in die Saldobilanz-Prüfung übernehmen
    for (const w of ledger?.warnings ?? []) validation.issues.push({ rowIndex: 0, severity: 'warning', code: 'LEDGER_CHECK', message: `Kontoblätter: ${w}` });
    for (const a of accounts) {
      const li = accountLedger[a.accountNumber];
      if (li?.tbDiff) validation.issues.push({ rowIndex: a.rowIndex, source: a.source, severity: 'warning', code: 'LEDGER_TB_DIFF', message: `Konto ${a.accountNumber}: Saldo Kontoblatt weicht von der Saldobilanz ab (Differenz ${(li.tbDiff / 100).toFixed(2)}).` });
      if (li && li.currency !== 'CHF' && li.rate === null) validation.issues.push({ rowIndex: a.rowIndex, source: a.source, severity: 'warning', code: 'FX_RATE_MISSING', message: `Konto ${a.accountNumber} wird in ${li.currency} geführt – Kurs per Stichtag fehlt (Kursliste laden oder Kurs erfassen).` });
    }

    // 4. Abgleich
    progress({ phase: 'abgleich', message: 'Salden werden abgeglichen …' });
    const facts = new Map(docs.map(d => [d.id, detectBalanceDate(d, input.closingDate)]));
    const amounts: AmountCandidate[] = [];
    const amountCount = new Map<string, number>();
    const keyAmount = new Map<string, DocumentSummary['keyAmount']>();
    const amountSet = new Map<string, number[]>();
    for (const d of docs) {
      if (ledgerIds.has(d.id)) { amountCount.set(d.id, 0); amountSet.set(d.id, []); keyAmount.set(d.id, null); continue; }
      const a = extractAmounts(d.id, d.lines);
      amountCount.set(d.id, a.length);
      amounts.push(...a);
      // Massgebender Betrag: letzte Zeile mit Saldo-/Total-Begriff, sonst grösster Betrag
      const kw = a.filter(x => x.context.balanceKeyword);
      const pick = kw.length ? kw[kw.length - 1]! : [...a].sort((x, y) => Math.abs(y.cents) - Math.abs(x.cents))[0];
      keyAmount.set(d.id, pick ? { cents: pick.cents, page: pick.page, lineNo: pick.lineNo, line: pick.line, bbox: pick.bbox } : null);
      amountSet.set(d.id, [...new Set(a.map(x => Math.abs(x.cents)))].slice(0, 400));
    }
    const match = runMatching(
      accounts.map(a => ({
        id: `${a.accountNumber}#${a.rowIndex}`, accountNumber: a.accountNumber, accountName: a.accountName, balance: a.balanceCurrentYear, category: a.category,
        currency: accountLedger[a.accountNumber]?.currency, fxBalance: accountLedger[a.accountNumber]?.currency !== 'CHF' ? accountLedger[a.accountNumber]?.closing ?? null : null,
      })),
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
      docType: ledgerIds.has(d.id) ? 'Kontoblatt (kein Nachweis)' : guessDocType(d),
      balanceDate: facts.get(d.id)?.date ?? null,
      balanceDateEvidence: facts.get(d.id)?.evidence ?? null,
      amountCount: amountCount.get(d.id) ?? 0,
      keyAmount: keyAmount.get(d.id) ?? null,
      keyDate: facts.get(d.id)?.date ?? findDates(d)[0]?.iso ?? null,
      amountSet: amountSet.get(d.id) ?? [],
      searchText: d.lines.map(l => l.text).join(' ').toLowerCase().slice(0, 8000),
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
      trialBalance: { parts: tb.parts, excluded: tb.excluded, digitStats: tb.digitStats, suggestedDigits: tb.suggestedDigits },
      ledger, accountLedger,
      match,
      documents,
      byAccount: new Map(match.results.map(r => [r.accountId, r])),
    };
  } finally {
    await ocr.close();
  }
}
