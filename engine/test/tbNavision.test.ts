import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadTrialBalance } from '../src/domain/trialBalance/load.js';

// Navision-Saldobilanzen mit Soll und Haben in getrennten Spalten (erfundene Daten, test/corpus/generate_tb_navision.py)
const DIR = path.resolve(import.meta.dirname, 'fixtures', 'tb_navision');
const by = (rows: { accountNumber: string; balanceCurrentYear: number; balancePreviousYear: number | null }[]) =>
  Object.fromEntries(rows.map(r => [r.accountNumber, [r.balanceCurrentYear, r.balancePreviousYear]]));

describe('Saldobilanz mit Soll/Haben-Spalten für aktuelles Jahr und Vorjahr', () => {
  it('PDF „Dieses Jahr bis …“ zweimal: Haben wird negativ, Vorjahr aus dem zweiten Paar', async () => {
    const r = await loadTrialBalance([path.join(DIR, 'Saldobilanz_Navision.pdf')], { accountDigits: { min: 4, max: 4 } });
    const b = by(r.rows);
    expect(b['1020']).toEqual([100710415, 28826441]);
    expect(b['1061']).toEqual([-2490000, 0]);
    expect(b['1109']).toEqual([-6000000, -4940000]);
    expect(b['2970']).toEqual([0, -9814000]);
    expect(r.rows.some(x => x.accountNumber === '1099')).toBe(false); // Total-Zeile
  });

  it('Excel: Vorjahr links, Beträge neben der Überschrift (verbundene Zellen)', async () => {
    const r = await loadTrialBalance([path.join(DIR, 'Saldenliste_Navision.xlsx')]);
    expect(by(r.rows)).toEqual({ '1020': [100050, 20000], '2000': [-80000, -15000], '3200': [-70050, -5000], '4000': [50000, 0] });
    expect(r.rows.reduce((s, x) => s + x.balanceCurrentYear, 0)).toBe(0);
    expect(r.rows.reduce((s, x) => s + (x.balancePreviousYear ?? 0), 0)).toBe(0);
  });
});
