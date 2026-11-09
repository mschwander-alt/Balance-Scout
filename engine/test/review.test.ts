import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { PDFDocument } from 'pdf-lib';
import {
  runAudit, loadTrialBalance, classify, defaultGroupLetters, applyReview, finalizeAudit, saveSnapshot, loadSnapshot,
  type RunResult, type ReviewDecisions,
} from '../src/index.js';
import { LocalOcr } from '../src/ingest/ocr.js';

const FIX = path.resolve(import.meta.dirname, 'fixtures');
const SPLIT = path.join(FIX, 'tb_split');
const ALPEN = path.join(FIX, 'alpen');
const expected = async () => {
  const wb = XLSX.read(await readFile(path.join(ALPEN, 'Saldobilanz_2025.xlsx')));
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1 }).slice(4)
    .filter(r => r[0]).map(r => [String(r[0]), Math.round(Number(r[2]) * 100)]);
};

describe('Bilanz und Erfolgsrechnung – eine oder zwei Dateien, Ziffernbereich', () => {
  it('zwei Dateien (Excel + PDF) mit Gruppen und Zwischensummen: 4 Ziffern -> exakt die 27 Konten', async () => {
    const ocr = new LocalOcr();
    try {
      const tb = await loadTrialBalance([path.join(SPLIT, 'Bilanz_2025.xlsx'), path.join(SPLIT, 'Erfolgsrechnung_2025.pdf')], { accountDigits: { min: 4, max: 4 }, ocr });
      expect(tb.rows.map(r => [r.accountNumber, r.balanceCurrentYear])).toEqual(await expected());
      expect(tb.parts.map(p => p.accountCount)).toEqual([22, 5]);
      expect(tb.rows.find(r => r.accountNumber === '3200')!.source).toBe('Erfolgsrechnung_2025.pdf');
      // Gruppen- und Totalzeilen wurden ausgeblendet und sind nachvollziehbar aufgelistet
      expect(tb.excluded.some(e => e.accountNumber === '100' && /Total Flüssige Mittel/.test(e.accountName))).toBe(true);
      expect(tb.excluded.every(e => e.accountNumber.length !== 4)).toBe(true);
      expect(tb.suggestedDigits).toEqual({ min: 4, max: 4 });
    } finally {
      await ocr.close();
    }
  });

  it('ohne Ziffernbereich würden Zwischensummen als Konten gelten – Vorschlag erkennt 4 Ziffern', async () => {
    const tb = await loadTrialBalance([path.join(SPLIT, 'Bilanz_2025.xlsx')]);
    expect(tb.rows.length).toBeGreaterThan(22);
    expect(tb.suggestedDigits).toEqual({ min: 4, max: 4 });
  });

  it('eine Datei mit Deckblatt, Bilanz- und ER-Blatt', async () => {
    const tb = await loadTrialBalance([path.join(SPLIT, 'Jahresrechnung_2025.xlsx')], { accountDigits: { min: 4, max: 4 } });
    expect(tb.parts.map(p => [p.sheet, p.status])).toEqual([['Deckblatt', 'ignoriert'], ['Bilanz', 'ok'], ['Erfolgsrechnung', 'ok']]);
    expect(tb.rows.map(r => [r.accountNumber, r.balanceCurrentYear])).toEqual(await expected());
  });

  it('Ziffernbereich von–bis (4- und 6-stellige Konten gemischt)', async () => {
    const tb = await loadTrialBalance([path.join(SPLIT, 'Bilanz_2025.xlsx')], { accountDigits: { min: 3, max: 4 } });
    expect(tb.rows.some(r => r.accountNumber === '100')).toBe(true);
    expect(tb.rows.some(r => r.accountNumber === '10')).toBe(false);
  });
});

describe('Gruppierung nach KMU-Kontenrahmen', () => {
  it('über Nummer, sonst über Bezeichnung', () => {
    expect(classify('1020', 'Bank')).toMatchObject({ source: 'nummer', group: { name: 'Flüssige Mittel' } });
    expect(classify('102000', 'UBS')).toMatchObject({ source: 'nummer', group: { code: 'A10' } });
    expect(classify('K-17', 'Bank UBS Kontokorrent')).toMatchObject({ source: 'bezeichnung', group: { code: 'A10' } });
    expect(classify('77', 'Kontokorrentkredit Raiffeisen')?.group.code).toBe('P11');
    expect(classify('55', 'Debitoren Inland')?.group.code).toBe('A12');
    expect(classify('56', 'Aktienkapital')?.group.code).toBe('P30');
    expect(classify('57', 'Löhne Produktion')?.group.code).toBe('E50');
    expect(classify('58', 'XYZ')).toBeNull();
  });
  it('Register der Revisionsstelle: A Allgemein, B Flüssige Mittel, D Wertschriften, E Ford. L+L …', () => {
    expect(defaultGroupLetters()).toMatchObject({ ALLG: 'A', A10: 'B', A11: 'D', A12: 'E', A13: 'F', A16: 'G', P14: 'G', A14: 'I', A25: 'N', P13: 'Q', P10: 'R', P15: 'S', E89: 'S', P20: 'T', P11: 'U', P22: 'W' });
  });
  it('IC und Steuern über die Bezeichnung, Beteiligungen über 148x', () => {
    expect(classify('2450', 'Darlehen Aktionär')?.group.code).toBe('P14');
    expect(classify('1150', 'Forderungen gegenüber Konzerngesellschaften')?.group.code).toBe('A16');
    expect(classify('2340', 'Rückstellung für direkte Steuern')?.group.code).toBe('P15');
    expect(classify('8900', 'Direkte Steuern')?.group.code).toBe('E89');
    expect(classify('1480', 'Beteiligung Muster GmbH')?.group.code).toBe('A25');
    expect(classify('2200', 'Geschuldete MWST')?.group.code).toBe('P12');
    expect(classify('1176', 'Verrechnungssteuer')?.group.code).toBe('A13');
  });
});

describe('Durchsicht und Abschluss: akzeptieren, manuell zuordnen, Notizen, Register', () => {
  let res: RunResult;
  let snap: string;
  beforeAll(async () => {
    res = await runAudit({
      mandate: 'Alpenblick Treuhand AG', closingDate: '2025-12-31', trialBalancePath: path.join(SPLIT, 'Bilanz_2025.xlsx'),
      trialBalancePaths: [path.join(SPLIT, 'Bilanz_2025.xlsx'), path.join(SPLIT, 'Erfolgsrechnung_2025.pdf')], accountDigits: { min: 4, max: 4 },
      evidencePaths: [path.join(ALPEN, 'Kunde_Upload')], targetDir: null, fileMode: 'none',
    });
    snap = path.join(await mkdtemp(path.join(tmpdir(), 'snap-')), 's.json');
    await saveSnapshot(res, snap);
  }, 120_000);

  const now = '2026-02-10T09:00:00.000Z';
  const pruefen = () => res.match.results.filter(r => r.status === 'PRUEFEN');
  const unassigned = () => res.documents.filter(d => !d.assigned);

  it('gleiches Ergebnis wie mit der einzelnen Saldobilanz (10/6/5)', () => {
    const c = res.match.summary.counts;
    expect([c.BELEGT, c.PRUEFEN, c.KEIN_NACHWEIS]).toEqual([10, 6, 5]);
  });

  it('Akzeptieren: Prüfen -> Belegt, Kennzahlen neu berechnet', () => {
    const p = pruefen()[0]!;
    const r = applyReview(res, { accepted: { [p.accountNumber]: { at: now, visum: 'MS' } } });
    expect(r.match.results.find(x => x.accountNumber === p.accountNumber)!.status).toBe('BELEGT');
    expect(r.match.summary.counts.BELEGT).toBe(11);
    expect(r.match.summary.counts.PRUEFEN).toBe(5);
    expect(r.match.summary.coverage).toBeGreaterThan(res.match.summary.coverage);
    expect(r.review.manual.get(p.accountNumber)).toBe('akzeptiert');
  });

  it('Manuelle Zuordnung eines nicht zugeordneten Belegs zu einem Konto ohne Nachweis', () => {
    const doc = unassigned().find(d => d.doc.ext === '.pdf' && d.doc.status === 'ok')!;
    const kn = res.match.results.find(r => r.status === 'KEIN_NACHWEIS')!;
    const r = applyReview(res, { assignments: { [doc.doc.id]: { accountNumber: kn.accountNumber, at: now, visum: 'MS' } } });
    expect(r.match.results.find(x => x.accountNumber === kn.accountNumber)!.status).toBe('BELEGT');
    expect(r.documents.find(d => d.doc.id === doc.doc.id)!.assignedAccounts).toEqual([kn.accountNumber]);
  });

  it('Register je Gruppe: B.1, B.2 … in Reihenfolge der Kontonummer', () => {
    const r = applyReview(res, { groupLetters: defaultGroupLetters() });
    const regs = [...r.review.registers.entries()].map(([id, reg]) => [r.documents.find(d => d.doc.id === id)!.assignedAccounts[0], reg]);
    const b = regs.filter(([, reg]) => reg!.startsWith('B.')).sort((x, y) => x[1]!.localeCompare(y[1]!, 'de', { numeric: true }));
    expect(b.map(x => x[1])).toEqual(b.map((_, i) => `B.${i + 1}`));
    expect(b.length).toBeGreaterThanOrEqual(3);
    const nums = b.map(x => Number(x[0]));
    expect([...nums].sort((x, y) => x - y)).toEqual(nums);
  });

  it('Abschluss: alle Belege zugeordnet, Präfix im Dateinamen, Notiz vor dem PDF bzw. als eigenes PDF, Excel mit Entscheiden', async () => {
    const loaded = await loadSnapshot(snap);
    const decisions: ReviewDecisions = { groupLetters: defaultGroupLetters(), accepted: {}, assignments: {}, notes: {} };
    for (const p of pruefen()) decisions.accepted![p.accountNumber] = { at: now, visum: 'MS', comment: 'Original eingesehen' };
    const kn = res.match.results.filter(r => r.status === 'KEIN_NACHWEIS');
    unassigned().forEach((d, i) => (decisions.assignments![d.doc.id] = { accountNumber: i < kn.length && d.doc.status === 'ok' ? kn[i]!.accountNumber : null, at: now, visum: 'MS' }));
    const ubs = res.match.results.find(r => r.accountNumber === '1020')!; // PDF
    const deb = res.match.results.find(r => r.accountNumber === '1100')!; // Excel
    decisions.notes = {
      '1020': { text: 'Saldo mit Bankbestätigung abgestimmt. Keine Abweichung – ok.', at: now, visum: 'MS' },
      '1100': { text: 'OP-Liste mit Debitorenkonto abgestimmt.', at: now, visum: 'MS' },
    };
    const agb = res.documents.find(d => d.doc.filename === 'AGB_Lieferant.pdf')!;
    decisions.assignments![agb.doc.id] = { accountNumber: '@allgemein', at: now, visum: 'MS' };
    const target = await mkdtemp(path.join(tmpdir(), 'abschluss-'));
    const out = await finalizeAudit(loaded, decisions, { targetDir: target, fileMode: 'copy', reportDir: target });

    // Jede Datei hat eine Zuordnung (Konto oder „nicht relevant“)
    expect(out.result.documents.every(d => d.assigned || out.result.review.irrelevant.has(d.doc.id))).toBe(true);
    const zu = await readdir(path.join(target, '01_Zugeordnet'));
    expect(await readdir(path.join(target, '02_Nicht_zugeordnet'))).toEqual([]);
    expect((await readdir(path.join(target, '03_Nicht_relevant'))).length).toBeGreaterThan(0);
    expect(zu.filter(f => /^B\.\d+_/.test(f)).length).toBeGreaterThanOrEqual(3);
    expect(zu).toContain('A.1_AGB_Lieferant.pdf');
    // ohne Präfix nur Belege von Gruppen ohne Registerbuchstaben (z. B. Sachanlagen, Eigenkapital)
    expect(zu.filter(f => !/^[A-Z]+\d*\.\d+_/.test(f)).length).toBeLessThanOrEqual(4);

    // PDF mit vorangestellter Notiz: eine Seite mehr als das Original
    const ubsDoc = out.result.documents.find(d => d.doc.id === ubs.best!.documentId)!;
    const orig = await PDFDocument.load(await readFile(ubsDoc.doc.absPath));
    const filed = await PDFDocument.load(await readFile(ubsDoc.placement!.newPath!));
    expect(filed.getPageCount()).toBe(orig.getPageCount() + 1);
    expect(path.basename(ubsDoc.placement!.newPath!)).toMatch(/^B\.\d+_/);
    // Excel-Beleg: separates Notiz-PDF mit gleichem Register
    const debDoc = out.result.documents.find(d => d.doc.id === deb.best!.documentId)!;
    expect(debDoc.notePlacement?.newPath).toMatch(/E\.\d+_Notiz_.*\.pdf$/);
    expect((await PDFDocument.load(await readFile(debDoc.notePlacement!.newPath!))).getPageCount()).toBe(1);

    // Excel: Status, Prüfer-Spalten, Register
    const wb = XLSX.read(await readFile(out.excelPath));
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Saldenabstimmung']!);
    expect(rows.filter(r => r['Status (automatisch)'] === 'Prüfen')).toHaveLength(0);
    const acc = rows.find(r => String(r['Konto']) === pruefen()[0]!.accountNumber)!;
    expect(acc).toMatchObject({ 'Status (automatisch)': 'Belegt', 'Prüfer-Entscheid': 'Bestätigt', 'Visum': 'MS' });
    expect(String(acc['Kommentar Prüfer'])).toMatch(/Manuell akzeptiert: Original eingesehen/);
    expect(String(rows.find(r => String(r['Konto']) === '1020')!['Register'])).toMatch(/^B\.\d+$/);
    expect(rows.find(r => String(r['Konto']) === '1020')!['Gruppe (KMU-Kontenrahmen)']).toBe('Flüssige Mittel');
    const bv = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['Belegverzeichnis']!);
    expect(bv.filter(r => r['Zielordner'] === 'Nicht zugeordnet')).toHaveLength(0);
    expect(bv.some(r => r['Zielordner'] === 'Nicht relevant')).toBe(true);
    const ov = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Übersicht']!, { header: 1 });
    expect(ov.some(r => r[0] === 'Saldobilanz (Datei)' && String(r[1]).includes('Erfolgsrechnung_2025.pdf'))).toBe(true);
  }, 120_000);
});
