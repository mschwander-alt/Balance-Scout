export type Status = 'BELEGT' | 'PRUEFEN' | 'KEIN_NACHWEIS' | 'NULLSALDO' | 'NICHT_IM_UMFANG';
export type Decision = 'offen' | 'bestaetigt' | 'abweichung' | 'nicht_anwendbar';
export type AiPolicy = 'disabled' | 'local_only' | 'tenant';
export type Task = 'evidence_extraction' | 'match_review';

export interface Me { actor: string; name: string; isAdmin: boolean; microsoftLinked: boolean }

export interface Engagement {
  id: string; name: string; client_name: string | null; closing_date: string | null; currency: string; created_at: string;
  settings?: { aiPolicy?: AiPolicy };
  trialBalances?: { id: string; filename: string; sign_convention: string; is_valid: boolean; created_at: string; created_by: string }[];
}

export interface Check { name: string; passed: boolean; difference: number; message: string }
export interface Issue { rowIndex: number; severity: 'error' | 'warning'; code: string; message: string }
export interface Validation { ok: boolean; accountCount: number; checks: Check[]; issues: Issue[]; signConvention: string }

export interface Account {
  id: string; rowIndex: number; accountNumber: string; accountName: string;
  balanceCurrentYear: number; balancePreviousYear: number | null; groupName: string | null; category: string;
}
export interface TrialBalance { id: string; filename: string; validation: Validation; accounts: Account[]; created_at: string; created_by: string }

export interface Evidence {
  id: string; filename: string; size_bytes: number; extraction_method: string; page_count: number; needs_ocr: boolean;
  warnings: string[]; created_at: string; line_count: number; sharepoint_url: string | null;
  ai: { provider: string; verified: number; rejected: number; balanceDate: string | null } | null;
}

export interface Candidate {
  documentId: string; filename: string; page: number; lineNo: number; source: string; line: string; raw: string;
  evidenceCents: number; differenceCents: number; kind: 'exact' | 'rounded' | 'tolerance'; score: number; flags: string[]; reasons: string[];
}
export interface MatchResult {
  accountId: string; accountNumber: string; accountName: string; balance: number; status: Status;
  best: Candidate | null; candidates: Candidate[]; reasons: string[];
}
export interface Summary {
  engineVersion: string; counts: Record<Status, number>; inScopeAbsTotal: number; confirmedAbsTotal: number; coverage: number;
  params: { absoluteToleranceCents: number; scope: string };
}
export interface Run { id: string; engine_version: string; summary: Summary; created_at: string; created_by: string; results?: MatchResult[] }

export interface Review { decision: Decision; comment: string; version: number; reviewedBy: string; reviewedAt: string; accountId?: string }
export interface Lock { accountId: string; lockedBy: string; lockedByName: string; expiresAt: string }

export interface ProviderInfo {
  id: string; displayName: string; boundary: 'local' | 'tenant' | 'external'; destination: string;
  capabilities: { vision: boolean; requiresUserToken: boolean; sharePointFiles: boolean };
}
export interface AiPreview { allowed: boolean; reason?: string; provider?: string; displayName?: string; destination?: string; boundary?: string; requiresUserLogin?: boolean }
