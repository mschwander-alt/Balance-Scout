import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readGrid, parseTrialBalance } from '../src/domain/trialBalance/parser.js';
import { linesToGrid } from '../src/domain/trialBalance/pdfGrid.js';
import { LocalOcr } from '../src/ingest/ocr.js';
import { runAudit } from '../src/index.js';

const F = path.join(import.meta.dirname, 'fixtures');

describe('Saldobilanz als PDF', async () => {
  const ref = parseTrialBalance(await readGrid(await readFile(path.join(F, 'alpen', 'Saldobilanz_2025.xlsx')), 'x.xlsx'));
  const refMap = new Map(ref.rows.map(r => [r.accountNumber, r.balanceCurrentYear]));

  it.each([
    ['SaBi_Text.pdf', 'Text-PDF, zweiseitig, Kopfzeile wiederholt, Zwischentotale, Seitenfuss'],
    ['SaBi_SollHaben.pdf', 'Soll/Haben-Spalten ohne Saldo'],
    ['SaBi_Scan.pdf', 'eingescannt (Texterkennung)'],
  ])('%s – %s: alle Konten mit exakt gleichem Saldo wie Excel', async f => {
    const ocr = new LocalOcr();
    const meta: { ocrPages?: number } = {};
    try {
      const p = parseTrialBalance(await readGrid(await readFile(path.join(F, 'tb_pdf', f)), f, { ocr, meta }));
      expect(p.rows.map(r => r.accountNumber).sort()).toEqual([...refMap.keys()].sort());
      for (const r of p.rows) expect([r.accountNumber, r.balanceCurrentYear]).toEqual([r.accountNumber, refMap.get(r.accountNumber)]);
      expect(p.issues.filter(i => i.severity === 'error')).toEqual([]);
      expect(Boolean(meta.ocrPages)).toBe(f.includes('Scan'));
    } finally {
      await ocr.close();
    }
  });

  it('Spaltenbildung: breiter Titel verschmilzt keine Spalten', () => {
    const g = linesToGrid([
      [{ text: 'Sehr langer Titel der Saldobilanz über die ganze Breite', x0: 0.1, x1: 0.9 }],
      [{ text: 'Konto', x0: 0.1, x1: 0.15 }, { text: 'Bezeichnung', x0: 0.2, x1: 0.3 }, { text: 'Saldo', x0: 0.7, x1: 0.75 }],
      [{ text: '1020', x0: 0.1, x1: 0.13 }, { text: 'Bank', x0: 0.2, x1: 0.25 }, { text: "1'000.00", x0: 0.68, x1: 0.75 }],
      [{ text: '2000 Kreditoren', x0: 0.1, x1: 0.3 }, { text: "-500.00", x0: 0.7, x1: 0.75 }],
    ]);
    expect(g[1]).toEqual(['Konto', 'Bezeichnung', 'Saldo']);
    expect(g[2]).toEqual(['1020', 'Bank', "1'000.00"]);
    expect(g[3]).toEqual(['2000', 'Kreditoren', '-500.00']); // verschmolzene Kontonummer abgetrennt
  });

  it('kompletter Lauf mit eingescannter Saldobilanz: gleiches Ergebnis wie mit Excel, mit Hinweis', async () => {
    const res = await runAudit({ mandate: 'x', closingDate: '2025-12-31', trialBalancePath: path.join(F, 'tb_pdf', 'SaBi_Scan.pdf'), evidencePaths: [path.join(F, 'alpen', 'Kunde_Upload')], targetDir: null, fileMode: 'none' });
    expect([res.match.summary.counts.BELEGT, res.match.summary.counts.PRUEFEN, res.match.summary.counts.KEIN_NACHWEIS]).toEqual([10, 6, 5]);
    expect(res.validation.issues.some(i => i.code === 'TB_OCR')).toBe(true);
    expect(res.validation.checks[0]!.passed).toBe(true);
  });
});
