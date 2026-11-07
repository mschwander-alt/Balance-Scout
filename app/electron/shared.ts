/** Gemeinsame Typen Hauptprozess <-> Oberfläche (über window.bsb). */

export type FileMode = 'copy' | 'move' | 'none';
export type SignConvention = 'signed' | 'unsigned';

export interface ColumnMapping {
  accountNumber: number;
  accountName: number;
  balanceCurrentYear: number;
  balancePreviousYear?: number;
  balanceForeignCurrency?: number;
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
  trialBalancePath: string;
  trialBalanceMapping?: { headerRowIndex: number; mapping: ColumnMapping };
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

export interface TbPreview {
  detected: { headerRowIndex: number; mapping: ColumnMapping } | null;
  head: string[][];
  accounts: { accountNumber: string; accountName: string; balance: number; category: string }[];
  validation: {
    ok: boolean;
    accountCount: number;
    checks: { name: string; passed: boolean; difference: number; message: string }[];
    issues: { rowIndex: number; severity: 'error' | 'warning'; code: string; message: string }[];
  } | null;
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
}

export interface AppSettings {
  defaultTargetBase: string; // z. B. OneDrive-Ordner "Intern"
  fileMode: FileMode;
  toleranceChf: string;
  signConvention: SignConvention;
  notifications: boolean;
  autoStart: boolean;
}

export interface BsbBridge {
  pick: {
    trialBalance(): Promise<PickedPath | null>;
    evidence(kind: 'files' | 'folders'): Promise<PickedPath[]>;
    targetDir(defaultPath?: string): Promise<string | null>;
    /** Pfad zu per Drag & Drop abgelegter Datei/Ordner */
    pathOf(file: File): Promise<PickedPath | null>;
  };
  engine: {
    previewTrialBalance(path: string, signConvention: SignConvention, mapping?: TbPreview['detected']): Promise<TbPreview>;
    run(input: JobInput): Promise<unknown>;
    cancel(): Promise<void>;
    /** Vorschau einer Belegseite (nur Belege der geöffneten Prüfung) */
    filePreview(path: string, page: number): Promise<FilePreview>;
    onProgress(cb: (p: Progress) => void): () => void;
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
