import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runAudit, type RunResult } from '../src/index.js';
import { fixedAssetsFor, classify } from '../src/analysis/fixedAssets.js';

const DIR = path.resolve(import.meta.dirname, 'fixtures', 'anlagen');

describe('Anlagespiegel aus Kontoblättern', () => {
  let res: RunResult;
  beforeAll(async () => {
    res = await runAudit({ mandate: 'Muster Bau AG', closingDate: '2025-12-31', trialBalancePath: path.join(DIR, 'Saldobilanz_2025.xlsx'), evidencePaths: [path.join(DIR, 'Saldobilanz_2025.xlsx')], targetDir: null, fileMode: 'none', ledgerPaths: [path.join(DIR, 'Kontoblaetter_2025.pdf')] });
  }, 60_000);

  it('Anfangsbestand, Zugänge, Abgänge, Abschreibungen, Endbestand je Konto – abgestimmt mit Saldobilanz', () => {
    const r = fixedAssetsFor(res);
    expect(r.available).toBe(true);
    expect(r.rows.map(x => [x.accountNumber, x.opening, x.additions, x.disposals, x.depreciation, x.closing, x.tbDiff])).toEqual([
      ['1500', 12000000, 6000000, 0, 5400000, 12600000, 0],
      ['1510', 4000000, 0, 0, 1000000, 3000000, 0],
      ['1530', 6000000, 0, 1500000, 2700000, 1800000, 0],
      ['1600', 100000000, 0, 0, 4000000, 96000000, 0],
    ]);
    expect(r.candidates.map(c => c.accountNumber)).not.toContain('6800');
  });

  it('Zugangsliste: alle Zugangsbuchungen, Summe = Zugänge; manuelle Klassierung fliesst ein; im Excel als Blatt „Zugänge“', async () => {
    const r = fixedAssetsFor(res);
    expect(r.additionsList.length).toBeGreaterThan(0);
    expect(r.additionsList.reduce((s, a) => s + a.amount, 0)).toBe(r.totals.additions);
    for (const row of r.rows) expect(r.additionsList.filter(a => a.assetAccount === row.accountNumber).reduce((s, a) => s + a.amount, 0)).toBe(row.additions);
    expect(r.additionsList.every(a => a.date && a.key && !a.manual)).toBe(true);
    // eine Abschreibung als Zugang umklassieren → erscheint (markiert) in der Liste
    const dep = r.rows.find(x => x.accountNumber === '1510')!.postings.find(p => p.cls === 'abschreibung')!;
    const r2 = fixedAssetsFor(res, { classes: { [dep.key]: 'zugang' } });
    expect(r2.additionsList.find(a => a.key === dep.key)).toMatchObject({ assetAccount: '1510', manual: true });
    expect(r2.additionsList.reduce((s, a) => s + a.amount, 0)).toBe(r2.totals.additions);
    const ExcelJS = (await import('exceljs')).default;
    const { fixedAssetsWorkbook } = await import('../src/report/fixedAssetsExcel.js');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await fixedAssetsWorkbook(r, { mandate: 'Muster Bau AG', closingDate: '2025-12-31', findings: [] }) as never);
    expect(wb.worksheets.map(w => w.name)).toEqual(['Anlagespiegel', 'Zugänge', 'Buchungen']);
    const zs = wb.getWorksheet('Zugänge')!;
    expect(zs.getCell(4, 1).value).toBe('Anlagekonto');
    expect(zs.getCell(5 + r.additionsList.length, 1).value).toBe('Total');
  });

  it('ESTV-Kategorie und effektiver Satz; Abschreibung über Normalsatz wird gemeldet', () => {
    const r = fixedAssetsFor(res);
    const by = Object.fromEntries(r.rows.map(x => [x.accountNumber, x]));
    expect([by['1500']!.estvRate, by['1510']!.estvRate, by['1530']!.estvRate, by['1600']!.estvRate]).toEqual([30, 25, 40, 4]);
    expect(by['1500']!.effectiveRate).toBeCloseTo(0.3, 5);
    expect(by['1530']!.effectiveRate).toBeCloseTo(0.6, 5);
    expect(by['1530']!.flags.join(' ')).toMatch(/über dem ESTV-Normalsatz von 40 %/);
    expect(by['1500']!.flags.join(' ')).not.toMatch(/über dem ESTV/);
  });

  it('Klassierung manuell korrigierbar; Kategorie wählbar', () => {
    const r0 = fixedAssetsFor(res);
    const sale = r0.rows.find(x => x.accountNumber === '1530')!.postings.find(p => p.cls === 'abgang')!;
    const r = fixedAssetsFor(res, { classes: { [sale.key]: 'abschreibung' }, categories: { '1530': 'maschinen' } });
    const row = r.rows.find(x => x.accountNumber === '1530')!;
    expect([row.disposals, row.depreciation, row.estvRate]).toEqual([0, 4200000, 30]);
  });

  it('Klassierung nach Text, wenn kein Gegenkonto (Navision)', () => {
    const p = (text: string, amount: number) => ({ date: '2025-12-31', text, contra: null, docNo: null, amount, balance: null, page: 1, lineNo: 1 });
    expect(classify(p('Buchmässige Abschreibungen', -100), new Set()).cls).toBe('abschreibung');
    expect(classify(p('Ausbuchen RW VW Tiguan', -100), new Set()).cls).toBe('abgang');
    expect(classify(p('RG ER0302 Evident Europe GmbH', 100), new Set()).cls).toBe('zugang');
  });
});
