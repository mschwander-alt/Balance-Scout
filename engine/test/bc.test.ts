import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runAudit, diagnosticReport, type RunResult } from '../src/index.js';
import { fixedAssetsFor } from '../src/analysis/fixedAssets.js';
import { fixedAssetsWorkbook } from '../src/report/fixedAssetsExcel.js';
import ExcelJS from 'exceljs';

// Erfundene Daten im Aufbau von Business Central „Fibukonto – Kontoblatt“ (Layout Gegenkontoinfo), siehe test/corpus/generate_bc.py
const DIR = path.resolve(import.meta.dirname, 'fixtures', 'bc');
const TB = path.join(DIR, 'Saldobilanz_2025.xlsx');
const KB = path.join(DIR, 'Fibu-Kontoblaetter_2025.xlsx');
const run = (closingDate: string, ledgerPaths: string[]) =>
  runAudit({ mandate: 'Muster Maschinen AG', closingDate, trialBalancePath: TB, evidencePaths: [TB], targetDir: null, fileMode: 'none', ledgerPaths });

describe('Business Central Kontoblatt und indirekte Abschreibung', () => {
  let res: RunResult;
  beforeAll(async () => { res = await run('2025-12-31', [KB]); }, 60_000);

  it('liest alle Konten (Kopf "1500 | Bezeichnung", leerer Anfangssaldo = 0, Endsaldo Soll|Haben|Saldo)', () => {
    const L = res.ledger!;
    expect(L.accounts.map(a => a.accountNumber)).toEqual(['1020', '1500', '1501', '1510', '1530', '1531', '2000', '6800']);
    expect(L.accounts.every(a => a.consistent)).toBe(true);
    expect(L.period).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    const kred = L.accounts.find(a => a.accountNumber === '2000')!;
    expect([kred.opening, kred.closing, kred.postings.length]).toEqual([0, 0, 2]);
    expect(res.accountLedger['1500']?.tbDiff).toBe(0);
    expect(L.files?.[0]).toMatchObject({ accounts: 8, consistent: 8, postings: 24, from: '2025-01-01', to: '2025-12-31' });
  });

  it('Gegenkonto nur bei Art F; Jahreszahl im Text ist kein Gegenkonto; Belegnummer aus der Spalte Belegnr.', () => {
    const by = (no: string) => res.ledger!.accounts.find(a => a.accountNumber === no)!.postings;
    expect(by('1020').map(p => [p.contra, p.docNo])).toEqual([['6940', 'G00012'], [null, 'ZLG00031'], ['8510', 'ZLG00044']]);
    expect(by('1501').find(p => /Übernahmebilanz/.test(p.text))!.contra).toBe('6800');
    expect(by('2000').map(p => p.contra)).toEqual([null, null]); // K = Kreditor, B = Bankkonto
    expect(by('1500')[0]!.contra).toBeNull(); // Anlagennummer ohne Art
  });

  it('Wertberichtigungskonten werden dem Anlagekonto zugeordnet; Anlagespiegel netto und brutto', () => {
    const r = fixedAssetsFor(res);
    expect(r.candidates.filter(c => c.wbFor).map(c => [c.accountNumber, c.wbFor])).toEqual([['1501', '1500'], ['1531', '1530']]);
    expect(r.rows.map(x => [x.accountNumber, x.wbAccount, x.opening, x.additions, x.disposals, x.depreciation, x.closing, x.tbDiff])).toEqual([
      ['1500', '1501', 20000000, 7840000, 400000, 5950000, 21490000, 0],
      ['1510', null, 4000000, 1200000, 0, 1300000, 3900000, 0],
      ['1530', '1531', 4000000, 0, 0, 1600000, 2400000, 0],
    ]);
    const m = r.rows[0]!;
    expect([m.awOpening, m.awAdditions, m.awDisposals, m.awClosing]).toEqual([50000000, 7840000, 4000000, 53840000]);
    expect([m.kumOpening, m.kumDisposals, m.kumClosing]).toEqual([-30000000, 3600000, -32350000]);
    const why = (re: RegExp) => m.postings.find(p => re.test(p.text) && p.cls)!;
    expect(m.postings.filter(p => /CNC-Fräse/.test(p.text) && p.amount < 0 && p.key.startsWith('1500|'))[0]!.cls).toBe('zugang'); // Skonto
    expect(why(/Übernahmebilanz/).cls).toBe('abschreibung'); // Korrektur gegen 6800
    expect(m.postings.filter(p => /Drehbank/.test(p.text)).map(p => p.cls)).toEqual(['abgang', 'abgang']);
    expect(m.flags.join(' ')).toMatch(/Abgänge \(Buchwert\) CHF 4'000.00/);
    expect(r.rows.flatMap(x => x.flags).join(' ')).not.toMatch(/ESTV-Normalsatz/);
  });

  it('Abstimmung Abschreibungen ↔ Aufwand 6800', () => {
    const r = fixedAssetsFor(res);
    expect(r.expense).toMatchObject({ total: 8850000, diff: 0 });
    expect(r.expense!.accounts.map(a => a.accountNumber)).toEqual(['6800']);
    const r2 = fixedAssetsFor(res, { accounts: ['1500', '1501', '1510'] }); // Fahrzeuge nicht gewählt
    expect(r2.expense!.diff).toBe(-1600000);
    expect(r2.suggestions.join(' ')).toMatch(/≠ Abschreibungsaufwand laut Saldobilanz/);
  });

  it('Excel: Blatt Anschaffungswerte und Abstimmung', async () => {
    const r = fixedAssetsFor(res);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await fixedAssetsWorkbook(r, { mandate: 'Muster Maschinen AG', closingDate: '2025-12-31', findings: [] }) as unknown as ArrayBuffer);
    expect(wb.worksheets.map(w => w.name)).toEqual(['Anlagespiegel', 'Anschaffungswerte', 'Zugänge', 'Buchungen']);
    const g = wb.getWorksheet('Anschaffungswerte')!;
    expect([g.getCell('A5').value, g.getCell('C5').value, g.getCell('D5').value, g.getCell('F5').value, g.getCell('K5').value]).toEqual(['1500', '1501', 500000, -40000, 36000]);
    const s = wb.getWorksheet('Anlagespiegel')!;
    const texts: string[] = [];
    s.eachRow(row => texts.push(String(row.getCell(2).value ?? '')));
    expect(texts).toContain('Abschreibungsaufwand laut Saldobilanz');
    const b = wb.getWorksheet('Buchungen')!;
    const accounts = new Set<string>();
    b.eachRow((row, i) => { if (i > 1) accounts.add(String(row.getCell(1).value)); });
    expect([...accounts].sort()).toEqual(['1500', '1501', '1510', '1531']);
  });

  it('Hinweise: Kontoblätter aus anderem Geschäftsjahr; Datei ohne erkannte Konten (mit anonymem Aufbau im Diagnosebericht)', async () => {
    const other = await run('2026-12-31', [KB]);
    expect(other.validation.issues.some(i => i.code === 'LEDGER_PERIOD' && /01\.01\.2025 – 31\.12\.2025.*31\.12\.2026/.test(i.message))).toBe(true);
    const none = await run('2025-12-31', [TB]); // keine Kontoblätter
    expect(none.ledger!.accounts.length).toBe(0);
    expect(none.validation.issues.find(i => i.code === 'LEDGER_EMPTY')!.message).toMatch(/keine Konten erkannt – der Aufbau wurde nicht erkannt/);
    expect(fixedAssetsFor(none).reason).toMatch(/keine Konten erkannt/);
    const diag = diagnosticReport(none);
    expect(diag).toMatch(/Aufbau K1 \(keine Konten erkannt/);
    expect(diag).not.toMatch(/Muster|Maschinen|Saldobilanz_2025/); // anonym
  }, 60_000);
});
