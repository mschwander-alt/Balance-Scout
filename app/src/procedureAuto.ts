/**
 * Automatische Ergebnisse für Prüfungshandlungen: Analysen und Belegstatus liefern einen Vorschlag
 * (abgehakt ja/nein, Notiz, Referenz). Er gilt, solange die Prüferin / der Prüfer die Handlung nicht selbst bearbeitet.
 */
import { chf, pct } from './format';
import type { AccrualsResult, FixedAssetsResult, ProcedureAuto, ReceivablesResult } from '../electron/shared';
import type { ViewAccount, ViewDoc } from './review';

export interface AutoResult { done: boolean; note: string; ref?: string }
export type AutoResults = Partial<Record<ProcedureAuto, AutoResult>>;

const inScope = (a: ViewAccount) => a.status !== 'NICHT_IM_UMFANG' && a.status !== 'NULLSALDO';

/** Belege der Konten einer Position und wesentliche Veränderungen zum Vorjahr */
export function accountAuto(items: ViewAccount[], docs: ViewDoc[]): AutoResults {
  const scope = items.filter(inScope);
  const ok = scope.filter(a => a.status === 'BELEGT');
  const regs = [...new Set(ok.map(a => docs.find(d => d.id === a.docId)?.register).filter((x): x is string => !!x))];
  const missing = scope.filter(a => a.status !== 'BELEGT').map(a => a.accountNumber);
  const out: AutoResults = {};
  if (scope.length) {
    out.belege = {
      done: !missing.length,
      note: missing.length ? `${ok.length} von ${scope.length} Konten belegt – offen: ${missing.join(', ')}` : `Alle ${scope.length} Konten mit Nachweis belegt`,
      ref: regs.join(', '),
    };
  }
  // wesentlich: mindestens 20 % und CHF 10'000 Veränderung (bzw. neues Konto)
  const big = items.filter(a => {
    const d = a.balance - (a.balancePreviousYear ?? 0);
    return Math.abs(d) >= 1_000_000 && (!a.balancePreviousYear || Math.abs(d / a.balancePreviousYear) >= 0.2);
  });
  if (items.some(a => a.balancePreviousYear !== null)) {
    out.vorjahr = {
      done: false,
      note: big.length
        ? `Zu erklären: ${big.slice(0, 5).map(a => `${a.accountNumber} ${a.balancePreviousYear ? `${a.balance >= a.balancePreviousYear ? '+' : ''}${(((a.balance - a.balancePreviousYear) / Math.abs(a.balancePreviousYear)) * 100).toFixed(0)} %` : 'neu'}`).join(', ')}${big.length > 5 ? ' …' : ''}`
        : 'Keine wesentlichen Veränderungen (≥ 20 % und ≥ CHF 10\'000)',
    };
  }
  return out;
}

export function receivablesAuto(r: ReceivablesResult, ref: string): AutoResults {
  const a = r.aging;
  if (!a) return {};
  const failed = a.checks.filter(c => !c.passed);
  const diff = r.balanceChf === null ? null : a.totalChf - r.balanceChf;
  const reconciled = diff !== null && Math.abs(diff) <= 1;
  return {
    'op-abstimmung': {
      done: reconciled && !failed.some(c => /Gesamttotal|Stichtag/.test(c.name)),
      note: diff === null ? `OP-Liste ${chf(a.totalChf)}` : `OP-Liste ${chf(a.totalChf)} – Saldo ${r.balanceAccounts} ${chf(r.balanceChf)}: ${reconciled ? 'abgestimmt' : `Differenz ${chf(diff)}`}${failed.length ? ` · ${failed.map(c => c.name).join(', ')} prüfen` : ''}`,
      ref,
    },
    'op-alter': {
      done: true,
      note: `> 90 Tage ${chf(a.kpis.overdue90)} (${pct(a.kpis.overdue90Share)}), ${a.kpis.overdueCustomers} von ${a.kpis.customers} Kunden überfällig${a.kpis.largestOverdue ? `, grösster Posten ${a.kpis.largestOverdue.customer} ${chf(a.kpis.largestOverdue.amount)}` : ''}`,
      ref,
    },
  };
}

export function fixedAssetsAuto(r: FixedAssetsResult, ref: string): AutoResults {
  if (!r.available || !r.rows.length) return {};
  const diffs = r.rows.filter(x => x.tbDiff !== null && Math.abs(x.tbDiff) > 1);
  const exp = r.expense && Math.abs(r.expense.diff) > 1 ? ` · Abschreibungen ≠ Aufwand (Δ ${chf(r.expense.diff)})` : '';
  return {
    anlagespiegel: {
      done: !diffs.length && !exp,
      note: `${r.rows.length} Konten, Endbestand ${chf(r.totals.closing)}${diffs.length ? ` – Differenz zur Saldobilanz bei ${diffs.map(x => x.accountNumber).join(', ')}` : ' = Saldobilanz'}; Zugänge ${chf(r.totals.additions)}, Abschreibungen ${chf(r.totals.depreciation)}${exp}`,
      ref,
    },
  };
}

export function accrualsAuto(r: AccrualsResult, ref: string, side: 'aktiv' | 'passiv'): AutoResults {
  const accs = r.accounts.filter(a => a.side === side);
  if (!r.available || !accs.length) return {};
  const open = accs.filter(a => Math.abs(a.unexplained.cy) > 1 || Math.abs(a.unexplained.py) > 1);
  const n = accs.reduce((s, a) => s + a.positions.length, 0);
  const note = `${n} Positionen, Vorjahr ${chf(accs.reduce((s, a) => s + a.totals.py, 0))}, laufend ${chf(accs.reduce((s, a) => s + a.totals.cy, 0))}${open.length ? ` – ungeklärte Differenz bei ${open.map(a => a.accountNumber).join(', ')}` : ', vollständig zugeordnet'}`;
  return { abgrenzungen: { done: !open.length, note, ref } };
}
