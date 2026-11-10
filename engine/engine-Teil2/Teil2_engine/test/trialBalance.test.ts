import { describe, it, expect } from 'vitest';
import { detectMapping, parseTrialBalance, readGrid, type Grid } from '../src/domain/trialBalance/parser.js';
import { classifyRows, validateTrialBalance } from '../src/domain/trialBalance/validate.js';
import { classifyAccount } from '../src/domain/trialBalance/accountGroups.js';

const grid: Grid = [
  ['Muster AG', null, null, null],
  ['Saldobilanz per 31.12.2025', null, null, null],
  ['Konto', 'Bezeichnung', 'Saldo 2025', 'Saldo 2024'],
  ['1000', 'Kasse', "1'500.00", "1'200.00"],
  ['1020', 'Bank UBS Kontokorrent', "48'250.35", "30'000.00"],
  ['1100', 'Debitoren', "12'000.00", "10'000.00"],
  [null, 'Total Aktiven', "61'750.35", null],
  ['2000', 'Kreditoren', "-8'000.00", "-7'000.00"],
  ['2800', 'Aktienkapital', "-50'000.00", "-50'000.00"],
  ['3200', 'Warenertrag', "-20'000.00", "-15'000.00"],
  ['4200', 'Warenaufwand', "16'249.65", "30'800.00"],
];

describe('Saldobilanz', () => {
  it('erkennt Kopfzeile mit Jahreszahlen', () => {
    expect(detectMapping(grid)).toEqual({ headerRowIndex: 2, mapping: { accountNumber: 0, accountName: 1, balanceCurrentYear: 2, balancePreviousYear: 3 } });
  });

  it('parst Zeilen, überspringt Totale', () => {
    const p = parseTrialBalance(grid);
    expect(p.rows).toHaveLength(7);
    expect(p.rows[1]).toMatchObject({ accountNumber: '1020', balanceCurrentYear: 4825035, rowIndex: 5 });
    expect(p.issues.map(i => i.code)).toContain('TOTAL_ROW_SKIPPED');
  });

  it('validiert Soll = Haben (signed)', () => {
    const p = parseTrialBalance(grid);
    const v = validateTrialBalance(classifyRows(p.rows), p.issues, 'signed');
    expect(v.checks.every(c => c.passed)).toBe(true);
    expect(v.ok).toBe(true);
    expect(v.totalsCurrentYear.aktiven).toBe(6175035);
  });

  it('meldet Differenz und doppelte Konten', () => {
    const g = grid.map(r => [...r]);
    g[4]![2] = "48'250.00";
    g.push(['1000', 'Kasse doppelt', '0', '0']);
    const p = parseTrialBalance(g);
    const v = validateTrialBalance(classifyRows(p.rows), p.issues, 'signed');
    expect(v.ok).toBe(false);
    expect(v.checks[0]).toMatchObject({ passed: false, difference: -35 });
    expect(v.issues.some(i => i.code === 'DUPLICATE_ACCOUNT')).toBe(true);
  });

  it('meldet ungültige Beträge als Fehler', () => {
    const g = grid.map(r => [...r]);
    g[3]![2] = 'n/a';
    const p = parseTrialBalance(g);
    expect(p.issues.find(i => i.code === 'INVALID_AMOUNT')?.rowIndex).toBe(4);
  });

  it('klassiert nach KMU-Kontenrahmen (längstes Präfix)', () => {
    expect(classifyAccount('1020')?.name).toBe('Flüssige Mittel');
    expect(classifyAccount('2800')?.code).toBe('P30');
    expect(classifyAccount('2970')?.code).toBe('P31');
    expect(classifyAccount('ABC')).toBeNull();
  });

  it('liest CSV mit Semikolon', async () => {
    const csv = "Kontonummer;Kontobezeichnung;Saldo;Vorjahr\n1020;Bank;1'000.00;900.00\n2000;Kreditoren;-1'000.00;-900.00\n";
    const g = await readGrid(Buffer.from(csv), 'tb.csv');
    const p = parseTrialBalance(g);
    expect(p.rows.map(r => r.balanceCurrentYear)).toEqual([100000, -100000]);
  });
});
