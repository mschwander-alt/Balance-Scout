/**
 * Qualitätsmessung an zwei realistischen Testsätzen (fiktive Mandate) mit Soll-Lösung.
 * Diese Tests sichern die Trefferquote ab – jede Änderung an der Engine muss sie bestehen.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAudit, type RunResult } from '../src/index.js';
import { evaluate } from './corpus/evaluate.js';

const FIX = path.join(import.meta.dirname, 'fixtures');

describe('Testsatz 1 "Alpenblick Treuhand AG" (PDF, Scans, Foto, xlsx, xls, docx, Excel mit Bild, Störfälle)', () => {
  let res: RunResult;
  beforeAll(async () => {
    res = await runAudit({ mandate: 'Alpenblick Treuhand AG', closingDate: '2025-12-31', trialBalancePath: path.join(FIX, 'alpen', 'Saldobilanz_2025.xlsx'), evidencePaths: [path.join(FIX, 'alpen', 'Kunde_Upload')], targetDir: null, fileMode: 'none' });
  });

  it('findet jede erwartete Fundstelle, kein fälschliches "Belegt"', async () => {
    const e = await evaluate(path.join(FIX, 'alpen'), res);
    const fails = e.rows.filter(r => !r.dateiOk || !r.statusOk);
    expect(fails, JSON.stringify(fails, null, 1)).toEqual([]);
    expect(e.falschBelegt).toBe(0);
  });

  it('liest alle Dateien inkl. Unterordner; Störfälle sauber gemeldet', () => {
    const by = Object.fromEntries(res.documents.map(d => [d.doc.relPath, d.doc]));
    expect(Object.keys(by)).toHaveLength(20); // ~$-Sperrdatei ignoriert
    expect(by['Diverses/defekt.pdf']!.status).toBe('error');
    expect(by['Diverses/Mail_Treuhaender.msg']!.status).toBe('unsupported');
    expect(by['Bank/ZKB/Scan_20260112.pdf']!.ocrPages).toBe(1);
    expect(by['Kasse/IMG_4471.jpg']!.ocrConfidence).toBeGreaterThan(80);
    expect(by['Inventar/Inventar_2025.xls']!.method).toBe('xls');
    expect(by['Anlagen/Anlagenspiegel.xlsx']!.ocrPages).toBe(1); // eingefügtes Bild
    expect(by['Kreditoren/Kreditoren_OP.docx']!.method).toBe('word');
  });

  it('erkennt Stichtag und Belegart', () => {
    const d = (p: string) => res.documents.find(x => x.doc.relPath === p)!;
    expect(d('Bank/UBS/Kontoauszug.pdf')).toMatchObject({ balanceDate: '2025-12-31', docType: 'Kontoauszug' });
    expect(d('Sozialversicherung/AHV_Kontoauszug.pdf').balanceDate).toBe('2025-11-30');
    expect(d('Darlehen/Saldobestaetigung_Aktionaer.pdf').docType).toBe('Saldobestätigung');
  });

  it('Saldobilanz ist ausgeglichen', () => {
    expect(res.validation.checks[0]).toMatchObject({ passed: true });
    expect(res.accounts).toHaveLength(27);
  });
});

describe('Testsatz 2: Praxisfallen', () => {
  let res: RunResult;
  let truth: Record<string, { file: string | null; expect: string }>;
  beforeAll(async () => {
    truth = JSON.parse(await readFile(path.join(FIX, 'hard', 'truth.json'), 'utf8')).truth;
    res = await runAudit({ mandate: 'Praxisfallen', closingDate: '2025-12-31', trialBalancePath: path.join(FIX, 'hard', 'SaBi.csv'), signConvention: 'unsigned', evidencePaths: [path.join(FIX, 'hard', 'Upload')], targetDir: null, fileMode: 'none' });
  });
  const LABEL: Record<string, string> = { BELEGT: 'Belegt', PRUEFEN: 'Prüfen', KEIN_NACHWEIS: 'Kein Nachweis' };

  it.each([
    ['1000', 'schlechter Scan'], ['1020', 'Betrag auf Folgezeile, deutsches Format'], ['1021', 'Kontoüberzug'],
    ['1100', 'Excel mit Beträgen als Text'], ['1101', 'Zufallstreffer Lohnausweis'], ['2000', 'Summe ohne Saldo-Wort'],
    ['2400', 'Stichtag nur im Dateinamen'], ['2410', 'falscher Stichtag im Beleg'], ['2800', 'Zufallstreffer Kreditlimite'],
  ])('Konto %s – %s', konto => {
    const r = res.match.results.find(x => x.accountNumber === konto)!;
    const exp = truth[konto]!;
    expect(exp.expect.split(' oder ')).toContain(LABEL[r.status]);
  });

  it('Kontoüberzug wird nie "Belegt"', () => {
    const r = res.match.results.find(x => x.accountNumber === '1021')!;
    expect(r.best!.flags).toContain('SIGN_CONFLICT');
  });
});
