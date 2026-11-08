import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { placeFiles, planTargetNames } from '../src/organize/placeFiles.js';
import { findDates, detectBalanceDate } from '../src/ingest/documentFacts.js';
import { runAudit, writeExcelReport, diagnosticReport, reportFileName, uniqueReportPath, type RunResult } from '../src/index.js';
import type { EvidenceDocument } from '../src/ingest/readDocument.js';
import { createHash } from 'node:crypto';

const FIX = path.join(import.meta.dirname, 'fixtures');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('Zieldateinamen', () => {
  it('gleiche Namen aus verschiedenen Unterordnern bekommen Präfix', () => {
    const m = planTargetNames([
      { docId: 'a', relPath: 'Bank/UBS/Kontoauszug.pdf' },
      { docId: 'b', relPath: 'Bank/PostFinance/Kontoauszug.pdf' },
      { docId: 'c', relPath: 'Steuern/MWST.pdf' },
    ]);
    expect([...m.values()]).toEqual(['Bank_UBS_Kontoauszug.pdf', 'Bank_PostFinance_Kontoauszug.pdf', 'MWST.pdf']);
  });
  it('unzulässige Zeichen werden ersetzt', () => {
    expect(planTargetNames([{ docId: 'x', relPath: 'a:b?.pdf' }]).get('x')).toBe('a_b_.pdf');
  });
});

describe('Ablage', () => {
  it('kopiert in 01/02, überschreibt nie, erkennt identische Dateien', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'src-'));
    const dst = await mkdtemp(path.join(tmpdir(), 'dst-'));
    await writeFile(path.join(src, 'a.pdf'), 'A');
    await writeFile(path.join(src, 'b.pdf'), 'B');
    const plans = [
      { docId: '1', absPath: path.join(src, 'a.pdf'), relPath: 'a.pdf', sha256: sha('A'), assigned: true, targetName: 'a.pdf' },
      { docId: '2', absPath: path.join(src, 'b.pdf'), relPath: 'b.pdf', sha256: sha('B'), assigned: false, targetName: 'b.pdf' },
    ];
    const r1 = await placeFiles(dst, plans, 'copy');
    expect(r1.map(r => `${r.status}:${r.newRelPath}`)).toEqual(['kopiert:01_Zugeordnet/a.pdf', 'kopiert:02_Nicht_zugeordnet/b.pdf']);
    // Original bleibt beim Kopieren erhalten
    expect(await readFile(path.join(src, 'a.pdf'), 'utf8')).toBe('A');
    // zweiter Lauf: identisch -> nicht nochmals
    expect((await placeFiles(dst, plans, 'copy')).map(r => r.status)).toEqual(['bereits vorhanden', 'bereits vorhanden']);
    // andere Datei mit gleichem Namen -> Nummer, nie überschreiben
    await writeFile(path.join(src, 'a.pdf'), 'A2');
    const r3 = await placeFiles(dst, [{ ...plans[0]!, sha256: sha('A2') }], 'copy');
    expect(r3[0]!.newRelPath).toBe('01_Zugeordnet/a (2).pdf');
    expect(await readFile(path.join(dst, '01_Zugeordnet', 'a.pdf'), 'utf8')).toBe('A');
  });

  it('verschieben entfernt das Original', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'src-'));
    const dst = await mkdtemp(path.join(tmpdir(), 'dst-'));
    await writeFile(path.join(src, 'x.pdf'), 'X');
    const r = await placeFiles(dst, [{ docId: '1', absPath: path.join(src, 'x.pdf'), relPath: 'x.pdf', sha256: sha('X'), assigned: true, targetName: 'x.pdf' }], 'move');
    expect(r[0]!.status).toBe('verschoben');
    expect(await stat(path.join(src, 'x.pdf')).then(() => true, () => false)).toBe(false);
  });

  it('"keine" legt nichts ab', async () => {
    const dst = await mkdtemp(path.join(tmpdir(), 'dst-'));
    const r = await placeFiles(dst, [{ docId: '1', absPath: '/x', relPath: 'x', sha256: '', assigned: true, targetName: 'x' }], 'none');
    expect(r[0]!.status).toBe('nicht abgelegt');
    expect(await readdir(dst)).toEqual([]);
  });
});

describe('Datumserkennung', () => {
  const doc = (lines: string[]) => ({ lines: lines.map((text, i) => ({ page: 1, lineNo: i + 1, text })) }) as unknown as EvidenceDocument;
  it.each([
    ['Kontoauszug per 31.12.2025', '2025-12-31'], ['Stand 31.12.25', '2025-12-31'], ['Bewertung per 31. Dezember 2025', '2025-12-31'],
    ['Saldo per 2025-12-31', '2025-12-31'], ['Datum 31. Dez. 2025', '2025-12-31'],
  ])('%s', (t, iso) => expect(findDates(doc([t]))[0]!.iso).toBe(iso));
  it('Bilanzstichtag hat Vorrang, sonst Datum mit Schlüsselwort', () => {
    expect(detectBalanceDate(doc(['Druck 15.01.2026', 'Saldo per 31.12.2025']), '2025-12-31').date).toBe('2025-12-31');
    expect(detectBalanceDate(doc(['Druck 15.01.2026', 'Saldo per 30.11.2025']), '2025-12-31').date).toBe('2025-11-30');
    expect(detectBalanceDate(doc(['Rechnung vom 15.01.2026']), '2025-12-31').date).toBeNull();
    expect(findDates(doc(['Konto 32.13.2025 99.99.9999']))).toEqual([]);
  });
});

describe('Excel-Bericht und Diagnose', () => {
  let res: RunResult;
  let file: string;
  let target: string;
  beforeAll(async () => {
    target = await mkdtemp(path.join(tmpdir(), 'ziel-'));
    res = await runAudit({ mandate: 'Alpenblick Treuhand AG', client: 'Alpenblick', closingDate: '2025-12-31', trialBalancePath: path.join(FIX, 'alpen', 'Saldobilanz_2025.xlsx'), evidencePaths: [path.join(FIX, 'alpen', 'Kunde_Upload')], targetDir: target, fileMode: 'copy' });
    file = path.join(target, reportFileName(res.input.mandate, res.input.closingDate));
    await writeExcelReport(res, file);
  });

  it('Aufbau wie Vorlage, Dateiname und Fundstelle je Konto, Links auf Kopie', async () => {
    const wb = XLSX.read(await readFile(file), { cellFormula: true });
    expect(wb.SheetNames).toEqual(['Übersicht', 'Saldenabstimmung', 'Offene Punkte', 'Belegverzeichnis', 'Anleitung']);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Saldenabstimmung']!);
    expect(rows).toHaveLength(27);
    const bank = rows.find(r => String(r['Konto']) === '1020')!;
    expect(bank).toMatchObject({ 'Status (automatisch)': 'Belegt', 'Datei (Beleg)': 'Kontoauszug.pdf', 'Seite': 2, 'Wert im Beleg': 148250.35 });
    expect(String(bank['Link / Ablageort'])).toBe('01_Zugeordnet/Bank_UBS_Kontoauszug.pdf');
    expect(wb.Sheets['Saldenabstimmung']!['L2']!.f).toMatch(/ROUND\(ABS\(K2\)-ABS\(E2\),2\)/);
    const cell = wb.Sheets['Saldenabstimmung']!['H3'];
    expect(cell?.l?.Target ?? '').toMatch(/01_Zugeordnet\//);
  });

  it('Belegverzeichnis ist Excel-Tabelle tblBelege mit Zielordner', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await readFile(file));
    const tables = Object.keys(zip.files).filter(n => /^xl\/tables\/[^/]+\.xml$/.test(n));
    expect(tables.length).toBe(1);
    expect(await zip.file(tables[0]!)!.async('string')).toMatch(/name="tblBelege"/);
    const wb = XLSX.read(await readFile(file));
    const bv = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['Belegverzeichnis']!);
    expect(bv).toHaveLength(20);
    expect(bv.filter(r => r['Zielordner'] === 'Zugeordnet').length).toBe(res.documents.filter(d => d.assigned).length);
  });

  it('Kopien liegen im Zielordner, Originale unverändert', async () => {
    expect((await readdir(path.join(target, '01_Zugeordnet'))).length).toBe(res.documents.filter(d => d.assigned).length);
    expect((await readdir(path.join(target, '02_Nicht_zugeordnet'))).length).toBe(res.documents.filter(d => !d.assigned).length);
    expect(await stat(path.join(FIX, 'alpen', 'Kunde_Upload', 'Bank', 'UBS', 'Kontoauszug.pdf')).then(() => true)).toBe(true);
  });

  it('Diagnosebericht enthält keine Beträge, Namen oder Dateinamen', () => {
    const d = diagnosticReport(res);
    expect(d).toMatch(/DIAGNOSEBERICHT/);
    for (const secret of ["148'250", '148250', 'Alpenblick', 'Kontoauszug.pdf', 'UBS', 'Keller', 'Aebi']) expect(d).not.toContain(secret);
    expect(d.split('\n').filter(l => /^\d+ \|/.test(l))).toHaveLength(20);
  });

  it('bestehender Bericht wird nie überschrieben – Folgelauf erhält „(2)“, Zielordner wird angelegt', async () => {
    const before = await readFile(file);
    const next = await uniqueReportPath(target, res.input.mandate, res.input.closingDate);
    expect(path.basename(next)).toBe('Saldenabstimmung_Alpenblick Treuhand AG_2025-12-31 (2).xlsx');
    await expect(writeExcelReport(res, file)).rejects.toThrow(/nicht überschrieben/);
    expect((await readFile(file)).equals(before)).toBe(true);
    const fresh = path.join(target, 'neu', 'unter');
    const p = await uniqueReportPath(fresh, 'Muster AG', null);
    expect(path.dirname(p)).toBe(fresh);
    expect(path.basename(p)).toBe('Saldenabstimmung_Muster AG_ohne-Stichtag.xlsx');
    await writeExcelReport(res, p);
    expect((await stat(p)).size).toBeGreaterThan(5000);
  });
});
