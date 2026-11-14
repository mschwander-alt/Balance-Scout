/** Gemeinsame Typen Hauptprozess <-> Oberfläche (über window.bsb). */

export type FileMode = 'copy' | 'move' | 'none';
export type SignConvention = 'signed' | 'unsigned';

export interface ColumnMapping {
  accountNumber: number;
  accountName: number;
  balanceCurrentYear?: number;
  balancePreviousYear?: number;
  balanceForeignCurrency?: number;
  balanceDebit?: number;
  balanceCredit?: number;
  balancePrevDebit?: number;
  balancePrevCredit?: number;
}

/** Synchronisierter Cloud-Ordner (OneDrive / SharePoint) auf diesem PC */
export interface CloudLocation {
  label: string;
  path: string;
  kind: 'onedrive' | 'sharepoint';
}

export interface PickedPath {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface JobInput {
  mandate: string;
  client?: string;
  closingDate: string | null; // ISO
  /** Erste Datei der Saldobilanz */
  trialBalancePath: string;
  /** Alle Dateien: Bilanz und Erfolgsrechnung in einer oder mehreren Dateien */
  trialBalancePaths?: string[];
  trialBalanceMapping?: { headerRowIndex: number; mapping: ColumnMapping };
  /** Spaltenzuordnung je Teil (Datei bzw. "Datei#Blatt") */
  trialBalanceMappings?: Record<string, { headerRowIndex: number; mapping: ColumnMapping }>;
  /** Kontonummern haben von–bis Ziffern; Gruppen und Zwischensummen werden ausgeblendet */
  accountDigits?: { min: number; max: number };
  /** Konten mit Saldo null nicht importieren (beide Jahre null bzw. laufendes Jahr null ohne Vorjahr) */
  skipZeroBalances?: boolean;
  /** Verwendung je Saldobilanz-Teil (Datei/Blatt-ID) */
  partRoles?: Record<string, PartRole>;
  signConvention: SignConvention;
  evidencePaths: string[];
  targetDir: string | null;
  fileMode: FileMode;
  absoluteToleranceCents: number;
  /** Kontoblätter (optional): Fremdwährungskonten, später Anlagespiegel */
  ledgerPaths?: string[];
  /** Kurse per Stichtag (CHF je Einheit) */
  fxRates?: FxRateList;
}

export interface FxRateList { date: string | null; rates: Record<string, number>; source: string; importedAt?: string }

export interface Progress {
  phase: string;
  message: string;
  current?: number;
  total?: number;
}

export type ExplicitMapping = { headerRowIndex: number; mapping: ColumnMapping };
export interface TbPreviewOptions {
  mapping?: ExplicitMapping | null;
  mappings?: Record<string, ExplicitMapping>;
  accountDigits?: { min: number; max: number } | null;
  skipZeroBalances?: boolean;
  partRoles?: Record<string, PartRole>;
}
/** Verwendung eines Blatts: automatisch, nur Bilanz, nur Erfolgsrechnung, beides, nicht verwenden */
export type PartRole = 'auto' | 'bilanz' | 'erfolg' | 'beide' | 'aus';
export interface TbPart {
  id: string; path: string; sheet: string | null; label: string; detected: ExplicitMapping | null; used: ExplicitMapping | null;
  head: string[][]; accountCount: number; ocrPages: number; status: 'ok' | 'ignoriert' | 'zuordnen';
  /** Grund, falls ignoriert; gewählte Verwendung */
  reason?: string; role?: PartRole;
}
export interface TbAccount {
  accountNumber: string; accountName: string; balance: number; balancePreviousYear?: number | null; category: string;
  groupCode?: string | null; groupName?: string | null; groupSource?: 'nummer' | 'bezeichnung' | null; source?: string | null;
}
export interface ExcludedRow { rowIndex: number; source?: string; accountNumber: string; accountName: string; balance: number | null; reason: string }
export interface TbPreview {
  detected: ExplicitMapping | null;
  head: string[][];
  parts?: TbPart[];
  excluded?: ExcludedRow[];
  digitStats?: Record<number, number>;
  suggestedDigits?: { min: number; max: number } | null;
  accounts: TbAccount[];
  validation: {
    ok: boolean;
    accountCount: number;
    checks: { name: string; passed: boolean; difference: number; message: string }[];
    issues: { rowIndex: number; source?: string; severity: 'error' | 'warning'; code: string; message: string }[];
  } | null;
}

/** Entscheide der Prüferin / des Prüfers (Durchsicht vor dem Abschluss) */
export interface ReviewDecisions {
  accepted?: Record<string, { at: string; visum: string; comment?: string }>;
  /** docId -> Konto oder null = nicht relevant */
  assignments?: Record<string, { accountNumber: string | null; accountNumbers?: string[]; at: string; visum: string }>;
  notes?: Record<string, { text: string; at: string; visum: string }>;
  groupLetters?: Record<string, string>;
  /** Analyse Erfolgsrechnung: Bemerkungen je Konto (Nummer), Untergruppe (U:…), Gruppe (S:…) oder Ergebnis (R:…) */
  incomeNotes?: Record<string, { text: string; at: string; visum: string }>;
  /** Analyse Erfolgsrechnung: Bezugsgrösse der Relationszahlen (ohne Angabe: Betriebsertrag) und per Drag & Drop verschobene Konten */
  incomeBase?: IncomeBase | null;
  incomePlacements?: Record<string, { section: string; sub?: string }>;
  /** Analyse Erfolgsrechnung: Bezugsgrösse je Zeile (Kontonummer bzw. R:/S:/U:…), z. B. AHV in % des Lohnaufwands */
  incomeRowBases?: Record<string, IncomeBase>;
  /** Fokus-Modus: Beilagen zur vertieften Prüfung je Gruppe (abgelegt als <Buchstabe>.100.n) und Feststellungen je Gruppe */
  groupAttachments?: Record<string, { id: string; name: string; path: string; account?: string | null }[]>;
  groupFindings?: Record<string, { text: string; status: 'offen' | 'erledigt'; at?: string; visum?: string }[]>;
  /** Status je Prüfgebiet (Gruppencode, „ER“ = Erfolgsrechnung) mit Visum */
  areaStatus?: Record<string, { status: AreaState; at: string; visum: string }>;
  procedures?: Record<string, AreaProcedures>;
  /** Konto (Nummer) -> vom Prüfer gewählte Gruppe (Code); zugeordnete Belege und Register folgen dem Konto */
  groupOverrides?: Record<string, { groupCode: string; at: string; visum: string }>;
  analyses?: { receivables?: ReceivablesDecision; fixedAssets?: FixedAssetsDecision; accruals?: AccrualsDecision };
}
export type MoveClass = 'zugang' | 'abgang' | 'abschreibung' | 'umbuchung';
export interface FixedAssetsDecision { manual?: Record<string, { id: string; date: string; text: string; amount: number; cls: MoveClass }[]>; accounts?: string[]; categories?: Record<string, string>; classes?: Record<string, MoveClass>; findings: { text: string; status: 'offen' | 'erledigt' }[]; note?: string; visum?: string }
export interface FixedAssetsResult {
  available: boolean; reason?: string;
  candidates: { accountNumber: string; accountName: string; balance: number; suggested: boolean; inLedger: boolean; wbFor?: string | null }[];
  rows: {
    accountNumber: string; accountName: string; opening: number; additions: number; disposals: number; depreciation: number; transfers: number; closing: number;
    /** indirekte Methode: Wertberichtigungskonto; Anschaffungswerte (aw…) und kumulierte Abschreibungen (kum…) */
    wbAccount: string | null; awOpening: number; awAdditions: number; awDisposals: number; awTransfers: number; awClosing: number;
    kumOpening: number; kumDisposals: number; kumOther: number; kumClosing: number; linearRate: number | null;
    tbBalance: number | null; tbDiff: number | null; category: string | null; categoryLabel: string | null; estvRate: number | null; effectiveRate: number | null;
    flags: string[]; consistent: boolean;
    postings: { key: string; date: string; text: string; contra: string | null; amount: number; cls: MoveClass; auto: MoveClass; why: string; page: number; lineNo: number; manual?: boolean }[];
  }[];
  totals: { opening: number; additions: number; disposals: number; depreciation: number; transfers: number; closing: number; tbBalance: number };
  categories: { key: string; label: string; rate: number }[];
  suggestions: string[];
  /** Abstimmung Abschreibungen ↔ Aufwand laut Saldobilanz */
  expense: { accounts: { accountNumber: string; accountName: string; balance: number }[]; total: number; diff: number } | null;
  /** Zugangsliste (Summe = Zugänge im Anlagespiegel) */
  additionsList: FixedAddition[];
}
export interface FixedAddition {
  assetAccount: string; assetName: string; account: string; date: string; docNo: string | null; text: string; contra: string | null;
  amount: number; manual: boolean; key: string; page: number; lineNo: number;
}
export interface ReceivablesDecision { docId: string | null; docIds?: string[]; accounts?: string[]; assigned?: Record<string, string[]>; termDays: number; rates: Record<string, number>; findings: { text: string; status: 'offen' | 'erledigt' }[]; visum?: string; note?: string }
export interface AgingItem {
  customerNo: string; customerName: string; docNo: string; docType: string; date: string | null; due: string | null; daysOverdue: number | null;
  bucket: number; currency: string; amount: number; amountChf: number | null; dunningLevel: number | null; page: number; lineNo: number; line: string; sourceDocId?: string;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}
export interface ReceivablesResult {
  candidates: { docId: string; filename: string; relPath: string; accounts: string[]; looksLikeOpList: boolean }[];
  docIds: string[]; docId: string | null; filename: string | null; listDate: string | null; currencies: string[];
  lists: { docId: string; filename: string; items: number; listDate: string | null }[];
  /** Alle Konten für die Abstimmung; `suggested` = Forderungen L+L (ohne Delkredere) */
  accountOptions: { accountNumber: string; accountName: string; balance: number; groupCode: string | null; suggested: boolean }[];
  balanceChf: number | null; balanceAccounts: string; suggestions: string[];
  aging: {
    items: AgingItem[];
    customers: { customerNo: string; customerName: string; totalChf: number; buckets: number[]; credits: number; maxDaysOverdue: number; items: number; dunningLevel: number | null }[];
    buckets: number[]; totalChf: number; credits: number; grossChf: number;
    kpis: { overdue90: number; overdue90Share: number; overdueCustomers: number; customers: number; largestOverdue: { customer: string; amount: number } | null; avgDaysOverdue: number };
    checks: { name: string; passed: boolean; message: string }[]; missingRates: string[];
  } | null;
}
export interface GroupsInfo {
  groups: { code: string; name: string; category: string; subcategory: string }[];
  letters: Record<string, string>;
  /** Allgemeine Prüfungen (Belege ohne Konto) */
  general?: { code: string; name: string; account: string };
  /** Empfohlene Prüfungshandlungen je Prüfgebiet (Gruppencode, „ER“) und allgemeine für übrige Bilanzpositionen */
  procedures?: Record<string, ProcedureDef[]>;
  genericProcedures?: ProcedureDef[];
}
export type ProcedureAuto = 'belege' | 'vorjahr' | 'op-abstimmung' | 'op-alter' | 'anlagespiegel' | 'abgrenzungen' | 'er-analyse';
export interface ProcedureDef { id: string; text: string; auto?: ProcedureAuto }
export interface ProcedureState { done: boolean; note: string; ref?: string; visum?: string; at?: string; auto?: boolean }
export interface AreaProcedures { items?: Record<string, ProcedureState>; custom?: { id: string; text: string }[]; removed?: string[] }

export type FilePreview =
  | { kind: 'image'; dataUrl: string; width: number; height: number; page: number; pageCount: number; pageLabel?: string }
  | { kind: 'table'; rows: string[][]; page: number; pageCount: number; pageLabel?: string; truncated: boolean }
  | { kind: 'text'; lines: string[]; page: number; pageCount: number }
  | { kind: 'unsupported'; message: string; page: number; pageCount: number };

export interface HistoryEntry {
  id: string;
  at: string;
  mandate: string;
  closingDate: string | null;
  excelPath: string;
  targetDir: string | null;
  counts: Record<string, number>;
  coverage: number;
  documents: number;
  /** false = analysiert, Durchsicht/Abschluss offen */
  finalized?: boolean;
}

export interface AppSettings {
  defaultTargetBase: string; // z. B. OneDrive-Ordner "Intern"
  fileMode: FileMode;
  toleranceChf: string;
  signConvention: SignConvention;
  notifications: boolean;
  autoStart: boolean;
  /** Kürzel der Prüferin / des Prüfers */
  visum: string;
  /** Registerbuchstaben je Gruppe (null = Vorschlag) */
  groupLetters: Record<string, string> | null;
  /** Zuletzt verwendeter Ziffernbereich der Kontonummern */
  accountDigits: { min: number; max: number } | null;
  /** Geladene Kurslisten (ESTV per 31.12.) je Stichtag */
  fxRateLists: Record<string, FxRateList>;
}

export interface BsbBridge {
  pick: {
    trialBalance(defaultPath?: string): Promise<PickedPath | null>;
    evidence(kind: 'files' | 'folders', defaultPath?: string): Promise<PickedPath[]>;
    /** Synchronisierte OneDrive-/SharePoint-Ordner */
    cloudLocations(): Promise<CloudLocation[]>;
    targetDir(defaultPath?: string): Promise<string | null>;
    /** Pfad zu per Drag & Drop abgelegter Datei/Ordner */
    pathOf(file: File): Promise<PickedPath | null>;
  };
  engine: {
    previewTrialBalance(paths: string | string[], signConvention: SignConvention, opts?: TbPreviewOptions | TbPreview['detected']): Promise<TbPreview>;
    run(input: JobInput): Promise<unknown>;
    cancel(): Promise<void>;
    /** Vorschau einer Belegseite (nur Belege der geöffneten Prüfung) */
    filePreview(path: string, page: number): Promise<FilePreview>;
    onProgress(cb: (p: Progress) => void): () => void;
  };
  review: {
    save(id: string, d: ReviewDecisions): Promise<boolean>;
    finalize(id: string, d: ReviewDecisions): Promise<unknown>;
    groups(): Promise<GroupsInfo>;
    fixedAssets(id: string, p: Partial<FixedAssetsDecision> & { groupOverrides?: ReviewDecisions['groupOverrides'] }): Promise<FixedAssetsResult>;
    /** Analyse Erfolgsrechnung bzw. Rechnungsabgrenzungen berechnen; exportAnalysis speichert sie als Excel */
    analysis<K extends keyof AnalysisResults>(id: string, type: K, p: Record<string, unknown>): Promise<AnalysisResults[K]>;
    exportAnalysis(id: string, type: keyof AnalysisResults, p: Record<string, unknown>, suggestedName: string): Promise<string | null>;
    exportFixedAssets(id: string, p: Partial<FixedAssetsDecision> & { groupOverrides?: ReviewDecisions['groupOverrides'] }, suggestedName: string): Promise<string | null>;
    /** ESTV-Kursliste (PDF) wählen, lesen und speichern; liefert alle gespeicherten Listen */
    importRates(): Promise<Record<string, FxRateList> | null>;
    receivables(id: string, p: Partial<ReceivablesDecision> & { groupOverrides?: ReviewDecisions['groupOverrides'] }): Promise<ReceivablesResult>;
    /** Kontoblatt eines Kontos (Datei, Kontokopf, Kennzahlen, Buchungen) */
    ledgerAccount(id: string, accountNumber: string): Promise<LedgerAccountView>;
    /** Vom Prüfer hochgeladener Nachweis: gelesen und in die Prüfung aufgenommen (Zuordnung folgt als Entscheid) */
    addDocument(id: string, path: string): Promise<UploadedDoc>;
    exportReceivables(id: string, p: Partial<ReceivablesDecision> & { groupOverrides?: ReviewDecisions['groupOverrides'] }, suggestedName: string, format: 'xlsx' | 'pptx'): Promise<string | null>;
  };
  app: {
    openPath(p: string): Promise<string>;
    showInFolder(p: string): Promise<void>;
    copyText(t: string): Promise<void>;
    history(): Promise<HistoryEntry[]>;
    removeHistory(id: string): Promise<HistoryEntry[]>;
    settings(): Promise<AppSettings>;
    saveSettings(s: Partial<AppSettings>): Promise<AppSettings>;
    version(): Promise<string>;
  };
}

// ---------------------------------------------------------------- Analyse der Erfolgsrechnung
export interface IncomeAmounts { cy: number; py: number | null; diff: number | null; diffPct: number | null; pctCy: number | null; pctPy: number | null; pctBase?: { key: string; label: string } }
export interface IncomeAccount extends IncomeAmounts { key: string; accountNumber: string; accountName: string; big: boolean }
export interface IncomeSub extends IncomeAmounts { key: string; id: string; label: string; accounts: IncomeAccount[] }
export interface IncomeSection extends IncomeAmounts { kind: 'section'; key: string; id: string; label: string; subs: IncomeSub[]; accounts: IncomeAccount[] }
export interface IncomeResultRow extends IncomeAmounts { kind: 'result'; key: string; id: string; label: string }
export interface IncomeAnalysis { rows: (IncomeSection | IncomeResultRow)[]; hasPreviousYear: boolean; base: { cy: number; py: number | null; label: string; key: string }; signFlipped: boolean; check: { total: number; accounts: number } }
/** Bezugsgrösse der Relationszahlen: Zeile der Staffel (R:/S:/U:…) oder Einzelkonten */
export type IncomeBase = { kind: 'line'; key: string } | { kind: 'accounts'; accounts: string[] };
export interface AnalysisResults { income: IncomeAnalysis; accruals: AccrualsResult }
// ---------------------------------------------------------------- Rechnungsabgrenzungen (engine/src/analysis/accruals.ts)
export type AccrualClass = 'vorjahr' | 'laufend' | 'unterjaehrig';
export interface AccrualPosting { key: string; date: string; text: string; contra: string | null; docNo: string | null; amount: number; cls: AccrualClass; auto: AccrualClass; why: string }
export interface AccrualPosition { key: string; label: string; contra: string | null; cy: number; py: number; diff: number; status: 'beide' | 'neu' | 'entfallen' | 'manuell'; edited?: boolean; postings: string[] }
export interface AccrualAccount {
  accountNumber: string; accountName: string; side: 'aktiv' | 'passiv'; opening: number; closing: number; tbBalance: number | null;
  positions: AccrualPosition[]; totals: { cy: number; py: number; diff: number }; unexplained: { cy: number; py: number }; intraYear: number; postings: AccrualPosting[]; flags: string[];
}
export interface AccrualsResult {
  available: boolean; reason?: string;
  candidates: { accountNumber: string; accountName: string; balance: number; side: 'aktiv' | 'passiv'; suggested: boolean; inLedger: boolean }[];
  accounts: AccrualAccount[]; totals: { aktiv: { cy: number; py: number }; passiv: { cy: number; py: number } }; suggestions: string[];
}
export interface AccrualsDecision {
  accounts?: string[]; classes?: Record<string, AccrualClass>; notes?: Record<string, { text: string }>; note?: string; visum?: string;
  /** zusätzliche Positionen des Prüfers je Konto (Rappen, positiv = in Richtung des Kontos) */
  manual?: Record<string, { id: string; label: string; contra?: string | null; cy: number; py: number }[]>;
  /** Korrekturen bestehender Positionen (Schlüssel `${konto}|${position}`) */
  edits?: Record<string, { label?: string; cy?: number; py?: number }>;
  /** angehängte Dateien (je Konto bzw. Position) – beim Abschluss <Buchstabe>.100.1, .100.2 … */
  attachments?: AccrualAttachment[];
}
export interface AccrualAttachment { id: string; name: string; path: string; account: string; position?: string | null }

// ---------------------------------------------------------------- Kontoblatt eines Kontos (Reiter „Kontoblatt“)
export interface LedgerAccountView {
  available: boolean; reason?: string; sourcePath?: string | null; source?: string;
  accountNumber: string; accountName: string; currency: string;
  opening: number | null; closing: number | null; debitTotal: number; creditTotal: number; consistent: boolean;
  tbBalance: number | null; pages: number[];
  head: { page: number; lineNo: number; bbox?: { x0: number; y0: number; x1: number; y1: number } };
  postings: { date: string; text: string; contra: string | null; docNo: string | null; amount: number; balance: number | null; page: number; lineNo: number; bbox?: { x0: number; y0: number; x1: number; y1: number } }[];
}

/** Vom Prüfer hochgeladener Nachweis (Felder wie ein Beleg im Belegverzeichnis) */
export interface UploadedDoc { id: string; filename: string; relPath: string; absPath: string; uploaded?: boolean; [k: string]: unknown }

export type AreaState = 'offen' | 'in_arbeit' | 'erledigt';
