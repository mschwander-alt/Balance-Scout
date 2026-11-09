import type { JobInput, ReviewDecisions } from '../electron/shared';

export type Status = 'BELEGT' | 'PRUEFEN' | 'KEIN_NACHWEIS' | 'NULLSALDO' | 'NICHT_IM_UMFANG';

export interface BBox { x0: number; y0: number; x1: number; y1: number }
export interface Best {
  documentId: string; filename: string; page: number; lineNo: number; source: string; line: string; raw: string;
  evidenceCents: number; differenceCents: number; kind: string; score: number; flags: string[]; reasons: string[];
  relPath: string | null; absPath: string | null; newPath: string | null; pageLabel: string | null; ext: string | null; bbox?: BBox;
}
export interface AccountRow {
  accountNumber: string; accountName: string; groupName: string | null; groupCode?: string | null; groupSource?: 'nummer' | 'bezeichnung' | null;
  source?: string | null; category: string;
  balance: number; balancePreviousYear: number | null; status: Status; reasons: string[];
  best: Best | null; candidates: Best[];
}
export interface DocRow {
  id: string; filename: string; relPath: string; absPath: string; ext: string; size: number; status: string; method: string;
  pageCount: number; ocrPages: number; ocrConfidence: number | null; warnings: string[]; docType: string; balanceDate: string | null;
  amountCount: number; assigned: boolean; assignedAccounts: string[]; targetName: string;
  placement: { status: string; newPath: string | null; message: string | null } | null;
  keyAmount?: { cents: number; page: number; lineNo: number; line: string; bbox?: BBox } | null;
  keyDate?: string | null;
  amountSet?: number[];
  searchText?: string;
}
export interface Filed { placement: DocRow['placement']; notePath: string | null; register: string | null; irrelevant: boolean }
export interface AuditResult {
  historyId?: string;
  excelPath: string; diagnostics: string; startedAt: string; finishedAt: string;
  summary: { engineVersion: string; counts: Record<Status, number>; inScopeAbsTotal: number; confirmedAbsTotal: number; coverage: number };
  validation: { ok: boolean; checks: { name: string; passed: boolean; message: string }[]; issues: { rowIndex: number; source?: string; severity: string; message: string }[] };
  accounts: AccountRow[];
  documents: DocRow[];
  trialBalance?: { parts: { id: string; label: string; accountCount: number; status: string }[]; excluded: { rowIndex: number; source?: string; accountNumber: string; accountName: string; balance: number | null; reason: string }[] } | null;
  input?: JobInput;
  decisions?: ReviewDecisions;
  finalized?: boolean;
  finalizedAt?: string;
  filed?: Record<string, Filed>;
}
