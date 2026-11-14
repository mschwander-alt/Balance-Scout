import { KMU_GROUPS } from '../domain/trialBalance/accountGroups.js';
import type { ReviewDecisions, AreaState } from '../finalize.js';
import { proceduresFor, DEFAULT_PROCEDURES, type ProcedureCatalog } from './procedures.js';

/** Prüfgebiete mit eigener vertiefter Prüfung */
export const AREA_ANALYSIS: Record<string, string> = {
  A12: 'Fälligkeitsanalyse', A15: 'Vorjahresvergleich TA', P13: 'Vorjahresvergleich TP',
  A21: 'Anlagespiegel', A22: 'Anlagespiegel', A23: 'Anlagespiegel', ER: 'Analyse mit Margen',
};
export const AREA_STATE_LABEL: Record<AreaState, string> = { offen: 'offen', in_arbeit: 'in Arbeit', erledigt: 'erledigt' };
const FIXED = ['A21', 'A22', 'A23'];

export interface AreaAccount { accountNumber: string; groupCode: string | null; category: string; balance: number; balancePreviousYear: number | null; status: string }
export interface AreaRow {
  code: string; name: string; letter: string; accounts: number; cy: number; py: number;
  /** belegt / Prüfumfang (Beträge absolut), null = nichts im Prüfumfang */
  coverage: number | null;
  analysis: string | null; status: AreaState; visum: string; at: string | null;
  findings: { text: string; status: 'offen' | 'erledigt' }[];
  /** Prüfungshandlungen (Katalog ohne ausgeblendete, dann eigene) mit Ergebnis */
  procedures: { id: string; text: string; done: boolean; note: string; ref: string; visum: string; custom: boolean }[];
}

/** Prüfungshandlungen eines Gebiets mit den Entscheiden der Prüferin / des Prüfers */
export function areaProcedures(code: string, d: ReviewDecisions, catalog: ProcedureCatalog = DEFAULT_PROCEDURES): AreaRow['procedures'] {
  const ap = d.procedures?.[code];
  const removed = new Set(ap?.removed ?? []);
  const list = [...proceduresFor(code, catalog).filter(x => !removed.has(x.id)).map(x => ({ ...x, custom: false })), ...(ap?.custom ?? []).map(x => ({ ...x, custom: true }))];
  return list.map(x => {
    const st = ap?.items?.[x.id];
    return { id: x.id, text: x.text, done: !!st?.done, note: st?.note ?? '', ref: st?.ref ?? '', visum: st?.visum ?? '', custom: x.custom };
  });
}

/**
 * Übersicht der Prüfgebiete: je Bilanzgruppe mit Konten eine Zeile, dazu die Erfolgsrechnung („ER“).
 * Feststellungen aus der Gruppe sowie aus den vertieften Prüfungen (Forderungen, Anlagespiegel).
 * Beträge in Rappen (wie die Konten).
 */
export function areaOverview(accounts: AreaAccount[], d: ReviewDecisions, catalog: ProcedureCatalog = DEFAULT_PROCEDURES): AreaRow[] {
  const rows: AreaRow[] = [];
  const firstFixed = FIXED.find(c => accounts.some(a => a.groupCode === c));
  const make = (code: string, name: string, items: AreaAccount[]): AreaRow => {
    const scope = items.filter(a => a.status !== 'NICHT_IM_UMFANG' && a.status !== 'NULLSALDO');
    const abs = scope.reduce((s, a) => s + Math.abs(a.balance), 0);
    const ok = scope.filter(a => a.status === 'BELEGT').reduce((s, a) => s + Math.abs(a.balance), 0);
    const st = d.areaStatus?.[code];
    const findings = [
      ...(d.groupFindings?.[code] ?? []).map(f => ({ text: f.text, status: f.status })),
      ...(code === 'A12' ? d.analyses?.receivables?.findings ?? [] : []),
      ...(code === firstFixed ? d.analyses?.fixedAssets?.findings ?? [] : []),
    ];
    return {
      code, name, letter: (d.groupLetters?.[code] ?? '').trim(), accounts: items.length,
      cy: items.reduce((s, a) => s + a.balance, 0), py: items.reduce((s, a) => s + (a.balancePreviousYear ?? 0), 0),
      coverage: code === 'ER' || !abs ? null : ok / abs, analysis: AREA_ANALYSIS[code] ?? null,
      status: st?.status ?? 'offen', visum: st?.visum ?? '', at: st?.at ?? null, findings, procedures: areaProcedures(code, d, catalog),
    };
  };
  for (const g of KMU_GROUPS) {
    if (g.category !== 'aktiven' && g.category !== 'passiven') continue;
    const items = accounts.filter(a => a.groupCode === g.code);
    if (items.length) rows.push(make(g.code, g.name, items));
  }
  const er = accounts.filter(a => a.category === 'aufwand' || a.category === 'ertrag');
  if (er.length) rows.push(make('ER', 'Erfolgsrechnung', er));
  return rows;
}
