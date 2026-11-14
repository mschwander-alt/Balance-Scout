/** Saldobilanz in einer Excel-Datei mit mehreren Blättern: Prüfer wählt Bilanz- und Erfolgsrechnungsblatt */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { loadTrialBalance } from '../src/domain/trialBalance/load.js';

let dir = '';
let file = '';
const id = (sheet: string) => `${file}#${sheet}`;
const head = ['Konto', 'Bezeichnung', 'Saldo'];
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bs-sheets-'));
  file = path.join(dir, 'Jahresrechnung.xlsx');
  const wb = XLSX.utils.book_new();
  const add = (name: string, rows: (string | number)[][]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  add('Deckblatt', [['Jahresrechnung 2023'], ['Muster AG']]);
  // Gesamtblatt (Bilanz und ER) – am meisten Konten, wird automatisch gewählt
  add('2023', [head, ['1000', 'Kasse', 100], ['1020', 'Bank', 900], ['2000', 'Kreditoren', -500], ['3200', 'Handelserlöse', -2000], ['4200', 'Warenaufwand', 1500]]);
  // Vorjahr mit denselben Konten
  add('2022', [head, ['1000', 'Kasse', 80], ['1020', 'Bank', 700], ['2000', 'Kreditoren', -400], ['3200', 'Handelserlöse', -1800], ['4200', 'Warenaufwand', 1420]]);
  // Getrennte Blätter; das Bilanzblatt enthält zusätzlich eine Erfolgszeile (z. B. Jahresergebnis-Hilfszeile)
  add('Bilanz', [head, ['1000', 'Kasse', 111], ['1020', 'Bank', 999], ['2000', 'Kreditoren', -555], ['4200', 'Warenaufwand (Hilfszeile)', 1]]);
  add('ER', [head, ['3200', 'Handelserlöse', -2222], ['4200', 'Warenaufwand', 1667], ['1000', 'Kasse (Hilfszeile)', 1]]);
  await writeFile(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
const nums = (rows: { accountNumber: string; balanceCurrentYear: number }[]) => rows.map(r => [r.accountNumber, r.balanceCurrentYear / 100]);

describe('Blattwahl Bilanz / Erfolgsrechnung', () => {
  it('automatisch: das vollständigste Blatt, Blätter mit gleichen Konten werden übergangen (mit Grund)', async () => {
    const tb = await loadTrialBalance([file]);
    expect(nums(tb.rows)).toEqual([['1000', 100], ['1020', 900], ['2000', -500], ['3200', -2000], ['4200', 1500]]);
    const p = Object.fromEntries(tb.parts.map(x => [x.sheet, [x.status, x.reason ?? '']]));
    expect(p['2022']![0]).toBe('ignoriert');
    expect(p['2022']![1]).toMatch(/dieselben Konten wie/);
  });

  it('Bilanz und Erfolgsrechnung aus getrennten Blättern: nur passende Konten je Blatt, übrige Blätter nicht verwendet', async () => {
    const tb = await loadTrialBalance([file], { partRoles: { [id('Bilanz')]: 'bilanz', [id('ER')]: 'erfolg' } });
    expect(nums(tb.rows).sort()).toEqual([['1000', 111], ['1020', 999], ['2000', -555], ['3200', -2222], ['4200', 1667]].sort());
    const p = Object.fromEntries(tb.parts.map(x => [x.sheet, x]));
    expect([p.Bilanz!.status, p.Bilanz!.role, p.Bilanz!.accountCount]).toEqual(['ok', 'bilanz', 3]);
    expect([p.ER!.status, p.ER!.role, p.ER!.accountCount]).toEqual(['ok', 'erfolg', 2]);
    for (const s of ['2023', '2022']) expect([p[s]!.status, p[s]!.reason]).toEqual(['ignoriert', 'nicht gewählt (andere Blätter dieser Datei gewählt)']);
    // die „falschen“ Zeilen sind nachvollziehbar ausgeblendet
    expect(tb.excluded.filter(e => /gewählt$/.test(e.reason)).map(e => [e.accountNumber, e.reason])).toEqual([
      ['4200', 'Konto der Erfolgsrechnung – Blatt ist für die Bilanz gewählt'],
      ['1000', 'Konto der Bilanz – Blatt ist für die Erfolgsrechnung gewählt'],
    ]);
  });

  it('ausdrücklich gewähltes Blatt wird verwendet, auch wenn ein anderes Blatt dieselben Konten hat', async () => {
    const tb = await loadTrialBalance([file], { partRoles: { [id('2022')]: 'beide' } });
    expect(nums(tb.rows)).toEqual([['1000', 80], ['1020', 700], ['2000', -400], ['3200', -1800], ['4200', 1420]]);
  });

  it('„nicht verwenden“ schliesst ein Blatt aus; die übrigen bleiben automatisch', async () => {
    const tb = await loadTrialBalance([file], { partRoles: { [id('2023')]: 'aus' } });
    const p = Object.fromEntries(tb.parts.map(x => [x.sheet, x]));
    expect([p['2023']!.status, p['2023']!.reason]).toEqual(['ignoriert', 'vom Prüfer abgewählt']);
    expect(tb.rows.length).toBeGreaterThan(0);
  });
});
