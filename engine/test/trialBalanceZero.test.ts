/** Import der Saldobilanz: Konten mit Saldo null auf Wunsch nicht importieren */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { loadTrialBalance, zeroBalanceReason } from '../src/domain/trialBalance/load.js';

let dir = '';
beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'bs-tb0-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
async function xlsx(name: string, rows: (string | number | null)[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Saldobilanz');
  const p = path.join(dir, name);
  await writeFile(p, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return p;
}

describe('zeroBalanceReason', () => {
  it.each([
    [0, 0, 'Saldo null in beiden Jahren – nicht importiert'],
    [0, null, 'Saldo null (ohne Vorjahr) – nicht importiert'],
    [0, 5000, null], // Vorjahr mit Saldo: bleibt (Veränderung ist prüfungsrelevant)
    [100, 0, null],
    [100, null, null],
    [-1, 0, null], // ein Rappen ist nicht null
  ])('laufend %d, Vorjahr %s → %s', (cy, py, reason) => expect(zeroBalanceReason({ balanceCurrentYear: cy, balancePreviousYear: py })).toBe(reason));
});

describe('loadTrialBalance mit skipZeroBalances', () => {
  const withPy = () => xlsx('mitvj.xlsx', [
    ['Konto', 'Bezeichnung', 'Saldo', 'Vorjahr'],
    ['1000', 'Kasse', 1500, 1200],
    ['1010', 'Post alt', 0, 0], // beide null → weg
    ['1020', 'Bank aufgelöst', 0, 8000], // laufend null, Vorjahr nicht → bleibt
    ['1030', 'Bank neu', 2500, 0], // bleibt
    ['2000', 'Kreditoren', -4000, -1200],
  ]);

  it('ohne Option: alle Konten', async () => {
    const tb = await loadTrialBalance([await withPy()]);
    expect(tb.rows.map(r => r.accountNumber)).toEqual(['1000', '1010', '1020', '1030', '2000']);
  });

  it('mit Vorjahr: nur Konten mit Saldo null in beiden Jahren werden ausgeblendet (mit Grund)', async () => {
    const tb = await loadTrialBalance([await withPy()], { skipZeroBalances: true });
    expect(tb.rows.map(r => r.accountNumber)).toEqual(['1000', '1020', '1030', '2000']);
    expect(tb.excluded.filter(e => /^Saldo null/.test(e.reason)).map(e => [e.accountNumber, e.reason])).toEqual([['1010', 'Saldo null in beiden Jahren – nicht importiert']]);
    expect(tb.parts[0]!.accountCount).toBe(4);
  });

  it('ohne Vorjahresspalte: Saldo null im laufenden Jahr genügt', async () => {
    const p = await xlsx('ohnevj.xlsx', [
      ['Konto', 'Bezeichnung', 'Saldo'],
      ['1000', 'Kasse', 1500], ['1010', 'Post alt', 0], ['1020', 'Bank', 0], ['2000', 'Kreditoren', -1500],
    ]);
    const tb = await loadTrialBalance([p], { skipZeroBalances: true });
    expect(tb.rows.map(r => r.accountNumber)).toEqual(['1000', '2000']);
    expect(tb.excluded.filter(e => /^Saldo null/.test(e.reason)).map(e => e.accountNumber)).toEqual(['1010', '1020']);
  });
});
