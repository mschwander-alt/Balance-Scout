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
  /** Konto (Nummer) -> vom Prüfer gewählte Gruppe (Code); zugeordnete Belege und Register folgen dem Konto */
  groupOverrides?: Record<string, { groupCode: string; at: string; visum: string }>;
  analyses?: { receivables?: ReceivablesDecision; fixedAssets?: FixedAssetsDecision };
}
export type MoveClass = 'zugang' | 'abgang' | 'abschreibung' | 'umbuchung';
export interface FixedAssetsDecision { accounts?: string[]; categories?: Record<string, string>; classes?: Record<string, MoveClass>; findings: { text: string; status: 'offen' | 'erledigt' }[]; note?: string; visum?: string }
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
    postings: { key: string; date: string; text: string; contra: string | null; amount: number; cls: MoveClass; auto: MoveClass; why: string; page: number; lineNo: number }[];
  }[];
  totals: { opening: number; additions: number; disposals: number; depreciation: number; transfers: number; closing: number; tbBalance: number };
  categories: { key: string; label: string; rate: number }[];
  suggestions: string[];
  /** Abstimmung Abschreibungen ↔ Aufwand laut Saldobilanz */
  expense: { accounts: { accountNumber: string; accountName: string; balance: number }[]; total: number; diff: number } | null;
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
}

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
    exportFixedAssets(id: string, p: Partial<FixedAssetsDecision> & { groupOverrides?: ReviewDecisions['groupOverrides'] }, suggestedName: string): Promise<string | null>;
    /** ESTV-Kursliste (PDF) wählen, lesen und speichern; liefert alle gespeicherten Listen */
    importRates(): Promise<Record<string, FxRateList> | null>;
    receivables(id: string, p: Partial<ReceivablesDecision> & { groupOverrides?: ReviewDecisions['groupOverrides'] }): Promise<ReceivablesResult>;
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
