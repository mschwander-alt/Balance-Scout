export type Status = 'BELEGT' | 'PRUEFEN' | 'KEIN_NACHWEIS' | 'NULLSALDO' | 'NICHT_IM_UMFANG';

export interface Best {
  documentId: string; filename: string; page: number; lineNo: number; source: string; line: string; raw: string;
  evidenceCents: number; differenceCents: number; kind: string; score: number; flags: string[]; reasons: string[];
  relPath: string | null; absPath: string | null; newPath: string | null; pageLabel: string | null;
}
export interface AccountRow {
  accountNumber: string; accountName: string; groupName: string | null; category: string;
  balance: number; balancePreviousYear: number | null; status: Status; reasons: string[];
  best: Best | null; candidates: { filename: string; page: number; line: string; score: number; evidenceCents: number; flags: string[] }[];
}
export interface DocRow {
  id: string; filename: string; relPath: string; absPath: string; ext: string; size: number; status: string; method: string;
  pageCount: number; ocrPages: number; ocrConfidence: number | null; warnings: string[]; docType: string; balanceDate: string | null;
  amountCount: number; assigned: boolean; assignedAccounts: string[]; targetName: string;
  placement: { status: string; newPath: string | null; message: string | null } | null;
}
export interface AuditResult {
  historyId?: string;
  excelPath: string; diagnostics: string; startedAt: string; finishedAt: string;
  summary: { engineVersion: string; counts: Record<Status, number>; inScopeAbsTotal: number; confirmedAbsTotal: number; coverage: number };
  validation: { ok: boolean; checks: { name: string; passed: boolean; message: string }[]; issues: { rowIndex: number; severity: string; message: string }[] };
  accounts: AccountRow[];
  documents: DocRow[];
}
