import { formatChf, type Cents } from '../amount.js';
import type { Category } from '../trialBalance/accountGroups.js';
import type { SignConvention } from '../trialBalance/validate.js';
import type { AmountCandidate } from './extractAmounts.js';

export const ENGINE_VERSION = 'bsb-match/1.2.0';

export interface MatchAccount {
  id: string;
  accountNumber: string;
  accountName: string;
  balance: Cents;
  category: Category;
}

export interface MatchDocument {
  id: string;
  filename: string;
  /** Ergebnis der (verifizierten) KI-Belegauswertung, falls vorhanden */
  insight?: DocumentInsight;
}

export interface DocumentInsight {
  /** Stichtag laut Beleg (ISO) */
  balanceDate: string | null;
  /** Von der KI als Saldo erkannte und gegen den Belegtext verifizierte Fundstellen */
  verifiedBalances: { page: number; lineNo: number; cents: Cents }[];
}

export interface MatchParams {
  /** Absolute Toleranz in Rappen für Status PRUEFEN (BELEGT erfordert immer exakten Treffer) */
  absoluteToleranceCents: Cents;
  /** Relative Toleranz (0.01 = 1 %), es gilt das Maximum aus absolut und relativ */
  relativeTolerance: number;
  /** Mindestpunktzahl für Status BELEGT */
  confirmScore: number;
  /** Welche Konten geprüft werden */
  scope: 'balance_sheet' | 'all';
  signConvention: SignConvention;
  /** Optionale manuelle Zuordnung Konto -> Dokumente; dann wird nur in diesen Dokumenten gesucht */
  assignments?: Record<string, string[]>;
  /** Bilanzstichtag (ISO) für Stichtagsprüfung gegen KI-Auswertung */
  closingDate?: string | null;
}

export const DEFAULT_PARAMS: MatchParams = {
  absoluteToleranceCents: 100,
  relativeTolerance: 0,
  confirmScore: 70,
  scope: 'balance_sheet',
  signConvention: 'signed',
};

export type MatchKind = 'exact' | 'rounded' | 'tolerance';
export type AccountStatus = 'BELEGT' | 'PRUEFEN' | 'KEIN_NACHWEIS' | 'NULLSALDO' | 'NICHT_IM_UMFANG';

export interface ScoredCandidate {
  documentId: string;
  filename: string;
  page: number;
  lineNo: number;
  /** Herkunft der Zeile (text-layer oder ocr:<anbieter>) */
  source: string;
  /** Lage der Zeile auf der Seite (0–1), für die Vorschau */
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  line: string;
  raw: string;
  evidenceCents: Cents;
  differenceCents: Cents; // |Beleg| − |Saldo|
  kind: MatchKind;
  score: number;
  flags: string[];
  reasons: string[];
}

export interface AccountResult {
  accountId: string;
  accountNumber: string;
  accountName: string;
  balance: Cents;
  status: AccountStatus;
  best: ScoredCandidate | null;
  candidates: ScoredCandidate[];
  reasons: string[];
}

export interface MatchSummary {
  engineVersion: string;
  params: MatchParams;
  counts: Record<AccountStatus, number>;
  inScopeAbsTotal: Cents;
  confirmedAbsTotal: Cents;
  /** Anteil der (absoluten) Saldosumme im Prüfumfang, der als BELEGT gilt */
  coverage: number;
}

export interface MatchOutput {
  summary: MatchSummary;
  results: AccountResult[];
}

const MAX_CANDIDATES = 5;

export function runMatching(
  accounts: MatchAccount[],
  documents: MatchDocument[],
  amounts: AmountCandidate[],
  paramsIn: Partial<MatchParams> = {},
): MatchOutput {
  const defined = Object.fromEntries(Object.entries(paramsIn).filter(([, v]) => v !== undefined));
  const params: MatchParams = { ...DEFAULT_PARAMS, ...defined };
  const docById = new Map(documents.map(d => [d.id, d]));

  // Index der Belegbeträge nach |Betrag| in ganzen Franken für schnelle Suche
  const byFranc = new Map<number, AmountCandidate[]>();
  for (const a of amounts) {
    const k = Math.floor(Math.abs(a.cents) / 100);
    (byFranc.get(k) ?? byFranc.set(k, []).get(k)!).push(a);
  }

  const results: AccountResult[] = [];
  for (const acc of accounts) {
    const base = { accountId: acc.id, accountNumber: acc.accountNumber, accountName: acc.accountName, balance: acc.balance };
    const inScope = params.scope === 'all' || acc.category === 'aktiven' || acc.category === 'passiven' || acc.category === 'unbekannt';
    if (!inScope) {
      results.push({ ...base, status: 'NICHT_IM_UMFANG', best: null, candidates: [], reasons: ['Erfolgsrechnungskonto – nicht im Prüfumfang (scope=balance_sheet).'] });
      continue;
    }
    if (acc.balance === 0) {
      results.push({ ...base, status: 'NULLSALDO', best: null, candidates: [], reasons: ['Saldo ist 0 – kein Nachweis erforderlich (Vollständigkeit separat beurteilen).'] });
      continue;
    }

    const target = Math.abs(acc.balance);
    const tol = Math.max(params.absoluteToleranceCents, Math.round(target * params.relativeTolerance));
    const allowedDocs = params.assignments?.[acc.id];
    const lo = Math.floor((target - tol) / 100) - 1;
    const hi = Math.floor((target + tol) / 100) + 1;

    const scored: ScoredCandidate[] = [];
    for (let k = Math.max(0, lo); k <= hi; k++) {
      for (const c of byFranc.get(k) ?? []) {
        if (allowedDocs && !allowedDocs.includes(c.documentId)) continue;
        const s = scoreCandidate(acc, c, target, tol, params, docById.get(c.documentId));
        if (s) scored.push(s);
      }
    }
    scored.sort((a, b) => b.score - a.score || Math.abs(a.differenceCents) - Math.abs(b.differenceCents));
    const top = scored.slice(0, MAX_CANDIDATES);
    results.push({ ...base, status: 'KEIN_NACHWEIS', best: top[0] ?? null, candidates: top, reasons: [] });
  }

  markAmbiguities(results);

  for (const r of results) {
    if (r.status === 'NICHT_IM_UMFANG' || r.status === 'NULLSALDO') continue;
    const b = r.best;
    if (!b) {
      r.reasons.push(`Kein Betrag ${formatChf(Math.abs(r.balance))} (±Toleranz) in den Belegen gefunden.`);
      continue;
    }
    const blocking = b.flags.filter(f => BLOCKING_FLAGS.has(f));
    if (b.kind === 'exact' && b.score >= params.confirmScore && blocking.length === 0) {
      r.status = 'BELEGT';
      r.reasons.push(`Saldo exakt in ${b.filename} (S. ${b.page}, Z. ${b.lineNo}) gefunden, Punktzahl ${b.score}.`);
    } else {
      r.status = 'PRUEFEN';
      if (b.kind !== 'exact') r.reasons.push(`Nur ${b.kind === 'rounded' ? 'gerundeter' : 'Toleranz-'}Treffer, Differenz ${formatChf(b.differenceCents)}.`);
      if (b.score < params.confirmScore) r.reasons.push(`Punktzahl ${b.score} unter Schwelle ${params.confirmScore} (zu wenig Kontext).`);
      for (const f of blocking) r.reasons.push(FLAG_TEXT[f] ?? f);
    }
  }

  const counts: Record<AccountStatus, number> = { BELEGT: 0, PRUEFEN: 0, KEIN_NACHWEIS: 0, NULLSALDO: 0, NICHT_IM_UMFANG: 0 };
  let inScopeAbs = 0;
  let confirmedAbs = 0;
  for (const r of results) {
    counts[r.status]++;
    if (r.status !== 'NICHT_IM_UMFANG') inScopeAbs += Math.abs(r.balance);
    if (r.status === 'BELEGT') confirmedAbs += Math.abs(r.balance);
  }
  return {
    summary: {
      engineVersion: ENGINE_VERSION,
      params,
      counts,
      inScopeAbsTotal: inScopeAbs,
      confirmedAbsTotal: confirmedAbs,
      coverage: inScopeAbs === 0 ? 1 : confirmedAbs / inScopeAbs,
    },
    results,
  };
}

const BLOCKING_FLAGS = new Set(['SIGN_CONFLICT', 'AMBIGUOUS', 'CURRENCY_MISMATCH', 'DATE_MISMATCH', 'OCR_SOURCE']);

const FLAG_TEXT: Record<string, string> = {
  DATE_MISMATCH: 'Stichtag im Beleg weicht vom Bilanzstichtag ab.',
  OCR_SOURCE: 'Betrag stammt aus Texterkennung (Scan) – Abschrift mit Original vergleichen.',
  SIGN_CONFLICT: 'Vorzeichen im Beleg widerspricht dem Saldo (z. B. Kontokorrent im Minus).',
  AMBIGUOUS: 'Derselbe Belegbetrag passt zu mehreren Konten – Zuordnung manuell bestätigen.',
  CURRENCY_MISMATCH: 'Beleg nennt eine andere Währung als die Buchwährung – Fremdwährung prüfen.',
};

function scoreCandidate(
  acc: MatchAccount,
  c: AmountCandidate,
  target: Cents,
  tol: Cents,
  params: MatchParams,
  doc: MatchDocument | undefined,
): ScoredCandidate | null {
  const filename = doc?.filename ?? '';
  const ev = Math.abs(c.cents);
  const diff = ev - target;
  let kind: MatchKind;
  if (diff === 0) kind = 'exact';
  else if (c.decimals === 0 && ev === Math.round(target / 100) * 100) kind = 'rounded';
  else if (Math.abs(diff) <= tol) kind = 'tolerance';
  else return null;

  const reasons: string[] = [];
  const flags: string[] = [];
  let score = kind === 'exact' ? 50 : kind === 'rounded' ? 30 : Math.max(10, 30 - Math.round((Math.abs(diff) / Math.max(tol, 1)) * 20));
  reasons.push(kind === 'exact' ? 'Betrag exakt (+50)' : kind === 'rounded' ? 'Betrag auf ganze Einheit gerundet (+30)' : `Betrag innerhalb Toleranz (Differenz ${formatChf(diff)})`);

  const accDigits = acc.accountNumber.replace(/\D/g, '');
  if (accDigits.length >= 3 && new RegExp(`(^|\\D)${accDigits}(\\D|$)`).test(c.line)) {
    score += 25;
    reasons.push('Kontonummer in derselben Zeile (+25)');
  }
  if (accDigits.length >= 3 && filename.replace(/\D+/g, ' ').split(' ').includes(accDigits)) {
    score += 15;
    reasons.push('Kontonummer im Dateinamen (+15)');
  }
  const nameTokens = significantTokens(acc.accountName);
  const fileAndLine = `${filename} ${c.line}`.toLowerCase();
  const hit = nameTokens.filter(t => fileAndLine.includes(t));
  if (hit.length) {
    score += 10;
    reasons.push(`Kontobezeichnung (${hit.join(', ')}) in Zeile/Dateiname (+10)`);
  }
  if (c.context.balanceKeyword) {
    score += 15;
    reasons.push('Saldo-/Total-Begriff in der Zeile (+15)');
  }
  if (c.decimals === 2 && target % 100 !== 0) {
    score += 5;
    reasons.push('Betrag mit Rappen – geringe Zufallswahrscheinlichkeit (+5)');
  }
  if (target < 100_00 && !hit.length && !c.context.balanceKeyword) {
    score -= 15;
    flags.push('LOW_SPECIFICITY');
    reasons.push('Kleiner Betrag ohne Kontext – hohe Zufallswahrscheinlichkeit (−15)');
  }

  // Vorzeichenprüfung für Aktivkonten (Bank, Kasse, Forderungen):
  // Beleg zeigt Schuld des Kunden (Minus, "zu unseren Gunsten", Überzug, Sollsaldo) -> muss zum Saldo passen.
  if (acc.category === 'aktiven') {
    const debtWording = /zu unseren gunsten|zu ihren lasten|überzug|ueberzug|sollsaldo|soll-saldo|debitsaldo|überzogen/i.test(c.line);
    const creditWording = /zu ihren gunsten|guthaben|habensaldo/i.test(c.line);
    const evNeg = c.cents < 0 || c.context.sollHaben === 'haben' || (debtWording && !creditWording);
    // Bei Saldobilanz ohne Vorzeichen gelten Aktivsalden als Guthaben (positiv)
    const balNeg = params.signConvention === 'signed' ? acc.balance < 0 : false;
    const evidenceSignKnown = c.explicitSign || c.context.sollHaben !== null || debtWording || creditWording;
    if (evNeg !== balNeg && (evidenceSignKnown || balNeg)) {
      flags.push('SIGN_CONFLICT');
      score -= 30;
      reasons.push(evNeg ? 'Beleg zeigt Schuld/Überzug, Saldobilanz ein Guthaben (−30)' : 'Beleg zeigt Guthaben, Saldobilanz eine Schuld (−30)');
    }
  }
  if (c.source && c.source !== 'text-layer') {
    flags.push('OCR_SOURCE');
    reasons.push(`Quelle: Texterkennung (${c.source})`);
  }
  const ins = doc?.insight;
  if (ins) {
    if (ins.verifiedBalances.some(v => v.page === c.page && v.lineNo === c.lineNo && Math.abs(v.cents) === Math.abs(c.cents))) {
      score += 10;
      reasons.push('KI-Auswertung: als Saldo erkannt und am Belegtext verifiziert (+10)');
    }
    if (ins.balanceDate && params.closingDate && ins.balanceDate === params.closingDate) {
      score += 10;
      reasons.push('Bilanzstichtag im Beleg genannt (+10)');
    }
    if (ins.balanceDate && params.closingDate && ins.balanceDate !== params.closingDate) {
      flags.push('DATE_MISMATCH');
      reasons.push(`Stichtag Beleg ${ins.balanceDate} ≠ Bilanzstichtag ${params.closingDate}`);
    }
  }
  if (c.context.currency && c.context.currency !== 'CHF' && !/\b(EUR|USD|GBP)\b/i.test(acc.accountName)) {
    flags.push('CURRENCY_MISMATCH');
    reasons.push(`Währung im Beleg: ${c.context.currency}`);
  }

  return {
    documentId: c.documentId,
    filename,
    page: c.page,
    lineNo: c.lineNo,
    source: c.source ?? 'text-layer',
    bbox: c.bbox,
    line: c.line.slice(0, 300),
    raw: c.raw,
    evidenceCents: c.cents,
    differenceCents: diff,
    kind,
    score: Math.max(0, Math.min(100, score)),
    flags,
    reasons,
  };
}

const STOP = new Set(['und', 'der', 'die', 'das', 'aus', 'für', 'mit', 'von', 'ag', 'gmbh', 'konto', 'kto', 'chf', 'eur', 'usd', 'kk', 'übrige', 'diverse']);
function significantTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-zäöüéèà0-9]+/i)
    .filter(t => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t));
}

/**
 * Wenn dieselbe Belegzeile/derselbe Betrag das beste Ergebnis für mehrere Konten ist,
 * wird es nur dem Konto mit klar höherer Punktzahl belassen; sonst AMBIGUOUS.
 */
function markAmbiguities(results: AccountResult[]): void {
  const byKey = new Map<string, AccountResult[]>();
  for (const r of results) {
    if (!r.best) continue;
    const k = `${r.best.documentId}#${r.best.source}#${r.best.page}#${r.best.lineNo}#${r.best.raw}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.best!.score - a.best!.score);
    const [first, second] = group;
    const clearWinner = first && second && first.best!.score - second.best!.score >= 20;
    for (const [i, r] of group.entries()) {
      if (clearWinner && i === 0) continue;
      r.best!.flags.push('AMBIGUOUS');
    }
  }
}
