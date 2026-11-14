/** Prüfgebiete: Status, Abdeckung und Feststellungen je Gruppe (gleiche Regeln wie das Blatt „Prüfgebiete“ im Excel) */
import type { AreaState, ReviewDecisions } from '../electron/shared';
import type { ViewAccount } from './review';

export const AREA_ANALYSIS: Record<string, string> = {
  A12: 'Fälligkeitsanalyse', A15: 'Vorjahresvergleich TA', P13: 'Vorjahresvergleich TP',
  A21: 'Anlagespiegel', A22: 'Anlagespiegel', A23: 'Anlagespiegel', ER: 'Analyse mit Margen',
};
const FIXED = ['A21', 'A22', 'A23'];
const isER = (a: { category: string }) => a.category === 'aufwand' || a.category === 'ertrag';

export interface AreaRow {
  code: string; name: string; letter: string; items: ViewAccount[]; cy: number; py: number; coverage: number | null;
  analysis: string | null; status: AreaState; visum: string; at: string | null; findings: { text: string; status: 'offen' | 'erledigt' }[];
}

export function areaRow(code: string, name: string, items: ViewAccount[], d: ReviewDecisions, allAccounts: ViewAccount[]): AreaRow {
  const scope = items.filter(a => a.status !== 'NICHT_IM_UMFANG' && a.status !== 'NULLSALDO');
  const abs = scope.reduce((s, a) => s + Math.abs(a.balance), 0);
  const ok = scope.filter(a => a.status === 'BELEGT').reduce((s, a) => s + Math.abs(a.balance), 0);
  const firstFixed = FIXED.find(c => allAccounts.some(a => a.groupCode === c));
  const st = d.areaStatus?.[code];
  return {
    code, name, letter: (d.groupLetters?.[code] ?? '').trim(), items,
    cy: items.reduce((s, a) => s + a.balance, 0), py: items.reduce((s, a) => s + (a.balancePreviousYear ?? 0), 0),
    coverage: code === 'ER' || !abs ? null : ok / abs, analysis: AREA_ANALYSIS[code] ?? null,
    status: st?.status ?? 'offen', visum: st?.visum ?? '', at: st?.at ?? null,
    findings: [
      ...(d.groupFindings?.[code] ?? []).map(f => ({ text: f.text, status: f.status })),
      ...(code === 'A12' ? d.analyses?.receivables?.findings ?? [] : []),
      ...(code === firstFixed ? d.analyses?.fixedAssets?.findings ?? [] : []),
    ],
  };
}

export function areaOverview(accounts: ViewAccount[], groups: { code: string; name: string; category: string }[], d: ReviewDecisions): AreaRow[] {
  const rows = groups.filter(g => g.category === 'aktiven' || g.category === 'passiven')
    .map(g => ({ g, items: accounts.filter(a => a.groupCode === g.code) }))
    .filter(x => x.items.length)
    .map(x => areaRow(x.g.code, x.g.name, x.items, d, accounts));
  const er = accounts.filter(isER);
  if (er.length) rows.push(areaRow('ER', 'Erfolgsrechnung', er, d, accounts));
  return rows;
}
