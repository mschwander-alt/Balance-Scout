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
  signConvention: SignConvention;
  evidencePaths: string[];
  targetDir: string | null;
  fileMode: FileMode;
  absoluteToleranceCents: number;
}

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
}
export interface TbPart {
  id: string; path: string; sheet: string | null; label: string; detected: ExplicitMapping | null; used: ExplicitMapping | null;
  head: string[][]; accountCount: number; ocrPages: number; status: 'ok' | 'ignoriert' | 'zuordnen';
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
  assignments?: Record<string, { accountNumber: string | null; at: string; visum: string }>;
  notes?: Record<string, { text: string; at: string; visum: string }>;
  groupLetters?: Record<string, string>;
  analyses?: { receivables?: ReceivablesDecision };
}
export interface ReceivablesDecision { docId: string | null; termDays: number; rates: Record<string, number>; findings: { text: string; status: 'offen' | 'erledigt' }[]; visum?: string }
export interface AgingItem {
  customerNo: string; customerName: string; docNo: string; docType: string; date: string | null; due: string | null; daysOverdue: number | null;
  bucket: number; currency: string; amount: number; amountChf: number | null; dunningLevel: number | null; page: number; lineNo: number; line: string;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}
export interface ReceivablesResult {
  candidates: { docId: string; filename: string; relPath: string }[];
  docId: string | null; filename: string | null; listDate: string | null; currencies: string[];
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
    receivables(id: string, p: Partial<ReceivablesDecision>): Promise<ReceivablesResult>;
    exportReceivables(id: string, p: Partial<ReceivablesDecision>, suggestedName: string): Promise<string | null>;
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
