import { formatChf, type Cents } from '../amount.js';
import { classifyAccount, type Category } from './accountGroups.js';
import type { RowIssue, TrialBalanceRow } from './parser.js';

/**
 * Vorzeichenkonvention der Saldobilanz:
 *  - 'signed':   Soll positiv, Haben negativ. Summe aller Salden muss 0 ergeben.
 *  - 'unsigned': Alle Salden als Betrag (Aktiven/Aufwand im Soll, Passiven/Ertrag im Haben).
 *                Prüfung: Aktiven − Passiven = Ertrag − Aufwand (Jahreserfolg).
 */
export type SignConvention = 'signed' | 'unsigned';

export interface ClassifiedAccount extends TrialBalanceRow {
  groupCode: string | null;
  groupName: string | null;
  category: Category;
}

export interface Totals {
  aktiven: Cents;
  passiven: Cents;
  aufwand: Cents;
  ertrag: Cents;
  abschluss: Cents;
  unbekannt: Cents;
  sumAll: Cents;
}

export interface BalanceCheck {
  name: string;
  passed: boolean;
  difference: Cents;
  message: string;
}

export interface ValidationReport {
  signConvention: SignConvention;
  accountCount: number;
  totalsCurrentYear: Totals;
  totalsPreviousYear: Totals | null;
  checks: BalanceCheck[];
  issues: RowIssue[];
  /** true, wenn keine Fehler (severity=error) und alle Bilanzprüfungen bestanden */
  ok: boolean;
}

export function classifyRows(rows: TrialBalanceRow[]): ClassifiedAccount[] {
  return rows.map(r => {
    const g = classifyAccount(r.accountNumber);
    return { ...r, groupCode: g?.code ?? null, groupName: g?.name ?? null, category: g?.category ?? 'unbekannt' };
  });
}

export function validateTrialBalance(
  accounts: ClassifiedAccount[],
  parseIssues: RowIssue[],
  signConvention: SignConvention,
  toleranceCents: Cents = 0,
): ValidationReport {
  const issues: RowIssue[] = [...parseIssues];

  // Doppelte Kontonummern
  const seen = new Map<string, number>();
  for (const a of accounts) {
    const prev = seen.get(a.accountNumber);
    if (prev !== undefined) {
      issues.push({ rowIndex: a.rowIndex, severity: 'error', code: 'DUPLICATE_ACCOUNT', message: `Kontonummer ${a.accountNumber} kommt mehrfach vor (auch Zeile ${prev}).` });
    } else seen.set(a.accountNumber, a.rowIndex);
  }
  for (const a of accounts) {
    if (a.category === 'unbekannt') {
      issues.push({ rowIndex: a.rowIndex, severity: 'warning', code: 'UNCLASSIFIED', message: `Konto ${a.accountNumber} "${a.accountName}" passt in keine Gruppe des KMU-Kontenrahmens.` });
    }
  }
  // Auffällige Vorzeichen (nur bei signed sinnvoll beurteilbar)
  if (signConvention === 'signed') {
    for (const a of accounts) {
      const b = a.balanceCurrentYear;
      if (b === 0) continue;
      const contra = /wertberichtigung|delkredere|abschreibung|\bwb\b|kum\.|kumuliert/i.test(a.accountName);
      if (contra) continue; // Wertberichtigungs-/Minuskonten haben bewusst Gegenvorzeichen
      if ((a.category === 'aktiven' || a.category === 'aufwand') && b < 0) {
        issues.push({ rowIndex: a.rowIndex, severity: 'warning', code: 'UNUSUAL_SIGN', message: `Konto ${a.accountNumber} (${a.category}) hat Haben-Saldo ${formatChf(b)}.` });
      }
      if ((a.category === 'passiven' || a.category === 'ertrag') && b > 0) {
        issues.push({ rowIndex: a.rowIndex, severity: 'warning', code: 'UNUSUAL_SIGN', message: `Konto ${a.accountNumber} (${a.category}) hat Soll-Saldo ${formatChf(b)}.` });
      }
    }
  }

  const totalsCy = computeTotals(accounts, a => a.balanceCurrentYear);
  const hasPy = accounts.some(a => a.balancePreviousYear !== null);
  const totalsPy = hasPy ? computeTotals(accounts, a => a.balancePreviousYear ?? 0) : null;

  const checks: BalanceCheck[] = [];
  checks.push(...balanceChecks(totalsCy, signConvention, toleranceCents, 'Aktuelles Jahr'));
  if (totalsPy) checks.push(...balanceChecks(totalsPy, signConvention, toleranceCents, 'Vorjahr'));

  const ok = !issues.some(i => i.severity === 'error') && checks.every(c => c.passed);
  return { signConvention, accountCount: accounts.length, totalsCurrentYear: totalsCy, totalsPreviousYear: totalsPy, checks, issues, ok };
}

function computeTotals(accounts: ClassifiedAccount[], pick: (a: ClassifiedAccount) => Cents): Totals {
  const t: Totals = { aktiven: 0, passiven: 0, aufwand: 0, ertrag: 0, abschluss: 0, unbekannt: 0, sumAll: 0 };
  for (const a of accounts) {
    const v = pick(a);
    t[a.category] += v;
    t.sumAll += v;
  }
  return t;
}

function balanceChecks(t: Totals, conv: SignConvention, tol: Cents, label: string): BalanceCheck[] {
  if (conv === 'signed') {
    const diff = t.sumAll;
    const bsResult = t.aktiven + t.passiven; // = Gewinn (positiv) bei Soll+/Haben-
    const plResult = -(t.aufwand + t.ertrag);
    const d2 = bsResult - plResult - t.abschluss - t.unbekannt;
    return [
      {
        name: `${label}: Soll = Haben`,
        passed: Math.abs(diff) <= tol,
        difference: diff,
        message: diff === 0 ? 'Summe aller Salden ist 0.' : `Summe aller Salden beträgt ${formatChf(diff)} (Soll ≠ Haben).`,
      },
      {
        name: `${label}: Bilanzerfolg = Erfolgsrechnung`,
        passed: Math.abs(d2) <= tol,
        difference: d2,
        message: `Erfolg gemäss Bilanz ${formatChf(bsResult)}, gemäss Erfolgsrechnung ${formatChf(plResult)}.`,
      },
    ];
  }
  const bsResult = t.aktiven - t.passiven;
  const plResult = t.ertrag - t.aufwand;
  const diff = bsResult - plResult;
  return [
    {
      name: `${label}: Bilanzerfolg = Erfolgsrechnung`,
      passed: Math.abs(diff) <= tol,
      difference: diff,
      message:
        `Aktiven ${formatChf(t.aktiven)} − Passiven ${formatChf(t.passiven)} = ${formatChf(bsResult)}; ` +
        `Ertrag ${formatChf(t.ertrag)} − Aufwand ${formatChf(t.aufwand)} = ${formatChf(plResult)}. ` +
        `Hinweis: Kontenklassen 7/8 sind gemischt (Aufwand/Ertrag); bei Abweichungen Vorzeichenkonvention "signed" verwenden.`,
    },
  ];
}
