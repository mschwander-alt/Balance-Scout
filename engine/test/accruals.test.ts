/** Rechnungsabgrenzungen: Vorjahresvergleich aus den Kontoblättern */
import { describe, it, expect } from 'vitest';
import type { Ledger, LedgerAccount, LedgerPosting } from '../src/ingest/ledger.js';
import { accrualsFor, positionText } from '../src/analysis/accruals.js';

let line = 0;
const p = (date: string, text: string, contra: string | null, chf: number): LedgerPosting => ({ date, text, contra, docNo: null, amount: Math.round(chf * 100), balance: null, page: 1, lineNo: ++line });
const account = (accountNumber: string, accountName: string, opening: number, postings: LedgerPosting[]): LedgerAccount => {
  const closing = Math.round(opening * 100) + postings.reduce((s, x) => s + x.amount, 0);
  return { accountNumber, accountName, currency: 'CHF', opening: Math.round(opening * 100), closing, debitTotal: 0, creditTotal: 0, postings, consistent: true, pages: [1], source: 'kb.pdf' };
};
// Aktive Rechnungsabgrenzung (Geschäftsjahr 1.7.2025–30.6.2026)
const aktiv = account('1300', 'Aktive Rechnungsabgrenzungen', 44_950 + 11_300 + 5_900, [
  p('2025-07-01', 'Auflösung TA Swiss Life, BVG Kader 07.-12.', '5720', -44_950),
  p('2025-07-01', 'Auflösung TA Helvetia, UVG 07.-12.', '5730', -11_300),
  p('2025-07-01', 'Auflösung TA Helvetia, UVG Zusatz 07.-12.', '5730', -5_900),
  p('2025-12-31', 'Halbjahresabgrenzung Miete', '6000', 2_000), // unterjährig, wieder aufgelöst
  p('2026-01-05', 'Auflösung Halbjahresabgrenzung Miete', '6000', -2_000),
  p('2026-06-30', 'Swiss Life, BVG Kader 07.-12.', '5720', 76_100),
  p('2026-06-30', 'Helvetia, UVG 07.-12.', '5730', 10_000),
  p('2026-06-30', 'Büroausflug 2026/2027', '5800', 2_500),
]);
// Passive Rechnungsabgrenzung (Haben-Saldo)
const passiv = account('2300', 'Passive Rechnungsabgrenzungen', -8_000, [
  p('2025-07-03', 'Auflösung TP Revision Vorjahr', '6530', 8_000),
  p('2026-06-30', 'TP Revision', '6530', -8_500),
]);
const ledger: Ledger = { accounts: [aktiv, passiv], period: { from: '2025-07-01', to: '2026-06-30' }, baseCurrency: 'CHF', warnings: [] };
const res = {
  accounts: [
    { accountNumber: '1300', accountName: 'Aktive Rechnungsabgrenzungen', groupCode: 'A15', category: 'aktiven', balanceCurrentYear: aktiv.closing! },
    { accountNumber: '2300', accountName: 'Passive Rechnungsabgrenzungen', groupCode: 'P13', category: 'passiven', balanceCurrentYear: passiv.closing! },
    { accountNumber: '2330', accountName: 'Kurzfristige Rückstellungen', groupCode: 'P13', category: 'passiven', balanceCurrentYear: -100_000 },
  ],
  ledger,
};
const chf = (x: number) => x / 100;

describe('Vorjahresvergleich Rechnungsabgrenzungen', () => {
  const r = accrualsFor(res);
  const a = r.accounts.find(x => x.accountNumber === '1300')!;

  it('Vorschlag: aktive und passive RAP mit Kontoblatt, Rückstellungen nicht', () => {
    expect(r.available).toBe(true);
    expect(r.candidates.map(c => [c.accountNumber, c.side, c.suggested, c.inLedger])).toEqual([['1300', 'aktiv', true, true], ['2300', 'passiv', true, true], ['2330', 'passiv', false, false]]);
    expect(r.accounts.map(x => x.accountNumber)).toEqual(['1300', '2300']);
  });

  it('Vorjahr aus den Auflösungen, laufendes Jahr aus der Bildung Ende Jahr, Positionen zugeordnet', () => {
    expect(a.positions.map(x => [x.label, x.contra, chf(x.cy), chf(x.py), x.status])).toEqual([
      ['Swiss Life, BVG Kader 07.-12.', '5720', 76_100, 44_950, 'beide'],
      ['Helvetia, UVG 07.-12.', '5730', 10_000, 11_300, 'beide'],
      ['Büroausflug 2026/2027', '5800', 2_500, 0, 'neu'],
      ['Helvetia, UVG Zusatz 07.-12.', '5730', 0, 5_900, 'entfallen'],
    ]);
    expect([chf(a.totals.cy), chf(a.totals.py)]).toEqual([88_600, 62_150]);
    expect(a.unexplained).toEqual({ cy: 0, py: 0 });
    expect(a.intraYear).toBe(2);
    expect(a.flags).toEqual([]);
  });

  it('passive Abgrenzung: Beträge positiv (Schuld), Vorjahr und laufendes Jahr', () => {
    const b = r.accounts.find(x => x.accountNumber === '2300')!;
    expect(b.positions.map(x => [chf(x.cy), chf(x.py), x.status])).toEqual([[8_500, 8_000, 'beide']]);
    expect([chf(b.opening), chf(b.closing)]).toEqual([8_000, 8_500]);
    expect(r.totals.passiv).toEqual({ cy: 850_000, py: 800_000 });
  });

  it('manuelle Klassierung: unterjährige Buchung als laufendes Jahr → Differenz zum Schlusssaldo gemeldet', () => {
    const k = a.postings.find(x => x.text === 'Halbjahresabgrenzung Miete')!.key;
    const r2 = accrualsFor(res, { classes: { [k]: 'laufend' } });
    const a2 = r2.accounts.find(x => x.accountNumber === '1300')!;
    expect(chf(a2.unexplained.cy)).toBe(-2_000);
    expect(a2.flags.join(' ')).toMatch(/Laufendes Jahr: Summe der Abgrenzungen/);
  });

  it('Konto steht nie auf null: Annahme nach Datum, mit Hinweis', () => {
    const odd = account('1301', 'Transitorische Aktiven', 1_000, [p('2025-07-10', 'Auflösung Lizenz', '6570', -600), p('2026-06-20', 'Lizenz', '6570', 900)]);
    const r3 = accrualsFor({ accounts: [{ accountNumber: '1301', accountName: 'Transitorische Aktiven', groupCode: 'A15', category: 'aktiven', balanceCurrentYear: odd.closing! }], ledger: { ...ledger, accounts: [odd] } });
    const x = r3.accounts[0]!;
    expect(x.postings.map(y => y.cls)).toEqual(['vorjahr', 'laufend']);
    expect(x.flags.join(' ')).toMatch(/nie auf null/);
    expect([chf(x.unexplained.py), chf(x.unexplained.cy)]).toEqual([400, 400]);
  });

  it('ohne Kontoblätter: Hinweis', () => {
    expect(accrualsFor({ accounts: res.accounts, ledger: null })).toMatchObject({ available: false });
  });

  it('Vergleichstext ohne Zahlen und Buchungsart', () => {
    expect(positionText('Auflösung TA Swiss Life, BVG Kader 07.-12.')).toBe(positionText('Swiss Life, BVG Kader 07.-12.'));
  });
});

describe('Excel', () => {
  it('Block je Konto mit Total = Saldo, Bemerkungen und Buchungsblatt', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { accrualsWorkbook } = await import('../src/report/accrualsExcel.js');
    const r = accrualsFor(res);
    const a = r.accounts[0]!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await accrualsWorkbook(r, { mandate: 'Muster AG', closingDate: '2026-06-30', notes: { [`1300|${a.positions[0]!.key}`]: { text: 'neuer Vertrag' } } }) as never);
    expect(wb.worksheets.map(w => w.name)).toEqual(['Rechnungsabgrenzungen', 'Buchungen']);
    const ws = wb.getWorksheet('Rechnungsabgrenzungen')!;
    expect([ws.getCell(5, 3).value, ws.getCell(5, 4).value]).toEqual(['30.06.2026', '30.06.2025']);
    expect([ws.getCell(6, 1).value, ws.getCell(6, 3).value, ws.getCell(6, 4).value, ws.getCell(6, 7).value]).toEqual(['Swiss Life, BVG Kader 07.-12.', 76_100, 44_950, 'neuer Vertrag']);
    const total = 6 + a.positions.length;
    expect(ws.getCell(total, 1).value).toBe('Total');
    expect((ws.getCell(total, 3).value as { result: number }).result).toBe(88_600);
  });
});

describe('Durchlauf mit Kontoblättern (Excel, ein Blatt je Konto)', () => {
  it('Vorjahresvergleich wie im Beispiel: Total 139\'514.45 / 104\'811.00, alle Positionen zugeordnet', async () => {
    const path = (await import('node:path')).default;
    const { runAudit } = await import('../src/index.js');
    const DIR = path.resolve(import.meta.dirname, 'fixtures', 'rap');
    const run = await runAudit({ mandate: 'Muster Treuhand AG', closingDate: '2026-06-30', trialBalancePath: path.join(DIR, 'Saldobilanz_2026.xlsx'), evidencePaths: [path.join(DIR, 'Saldobilanz_2026.xlsx')], targetDir: null, fileMode: 'none', ledgerPaths: [path.join(DIR, 'Kontoblaetter_2026.xlsx')] });
    const r = accrualsFor(run);
    expect(r.accounts.map(a => [a.accountNumber, a.side, a.totals.cy / 100, a.totals.py / 100, a.flags])).toEqual([
      ['1300', 'aktiv', 139_514.45, 104_811, []],
      ['2300', 'passiv', 34_700, 18_500, []],
    ]);
    const a = r.accounts[0]!;
    expect(a.positions.filter(x => x.status === 'beide')).toHaveLength(12);
    expect(a.positions.filter(x => x.status === 'neu').map(x => x.label).sort()).toEqual(['Büroausflug 2026/2027', 'Rotmonten, Umsatzabrechnung']);
    expect(a.positions.find(x => x.label === 'Swiss Life, BVG Kader 07.-12.')).toMatchObject({ contra: '5720', cy: 7_610_000, py: 4_495_000 });
    expect(r.accounts[1]!.positions.find(x => x.status === 'neu')!.label).toBe('TP Ferienguthaben');
  }, 60_000);
});

describe('Manuelle Eingriffe des Prüfers', () => {
  it('zusätzliche Position, Korrektur einer Position; Total und „nicht aufgeschlüsselt“ folgen', () => {
    const r0 = accrualsFor(res);
    const swiss = r0.accounts[0]!.positions.find(x => x.label.startsWith('Swiss Life'))!;
    const r = accrualsFor(res, {
      manual: { '1300': [{ id: 'm1', label: 'Lizenz Mirus (nicht gebucht)', contra: '6560', cy: 400_000, py: 0 }] },
      edits: { [`1300|${swiss.key}`]: { label: 'Swiss Life BVG Kader 2. HJ', cy: 7_500_000 } },
    });
    const a = r.accounts[0]!;
    expect(a.positions.at(-1)).toMatchObject({ key: 'M:m1', label: 'Lizenz Mirus (nicht gebucht)', cy: 400_000, status: 'manuell', diff: 400_000 });
    expect(a.positions.find(x => x.key === swiss.key)).toMatchObject({ label: 'Swiss Life BVG Kader 2. HJ', cy: 7_500_000, py: 4_495_000, diff: 3_005_000, edited: true });
    expect(a.totals.cy).toBe(r0.accounts[0]!.totals.cy + 400_000 - 110_000);
    expect(a.unexplained.cy).toBe(-290_000);
    expect(a.flags.join(' ')).toMatch(/manuelle Positionen prüfen/);
  });
});

describe('Abschluss: Aufstellung <Buchstabe>.100, Anhänge <Buchstabe>.100.1 …', () => {
  it('legt Excel und Anhänge mit fortlaufender Nummer ab, Original des Anhangs bleibt', async () => {
    const path = (await import('node:path')).default;
    const { mkdtemp, writeFile, readdir } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { runAudit, finalizeAudit, defaultGroupLetters } = await import('../src/index.js');
    const DIR = path.resolve(import.meta.dirname, 'fixtures', 'rap');
    const tmp = await mkdtemp(path.join(tmpdir(), 'bs-rap-'));
    const pol = path.join(tmp, 'Police_SwissLife.pdf');
    const ver = path.join(tmp, 'Vertrag_Abacus.pdf');
    const mail = path.join(tmp, 'Mail_Revision.msg');
    await writeFile(pol, '%PDF-1.4 Police'); await writeFile(ver, '%PDF-1.4 Vertrag'); await writeFile(mail, 'Mail');
    const run = await runAudit({ mandate: 'Muster Treuhand AG', closingDate: '2026-06-30', trialBalancePath: path.join(DIR, 'Saldobilanz_2026.xlsx'), evidencePaths: [path.join(DIR, 'Saldobilanz_2026.xlsx')], targetDir: null, fileMode: 'none', ledgerPaths: [path.join(DIR, 'Kontoblaetter_2026.xlsx')] });
    const letters = defaultGroupLetters();
    const swiss = accrualsFor(run).accounts[0]!.positions.find(x => x.label.startsWith('Swiss Life'))!;
    const target = path.join(tmp, 'Ablage');
    const out = await finalizeAudit(run, { groupLetters: letters, analyses: { accruals: { attachments: [
      { id: 'a1', name: 'Police_SwissLife.pdf', path: pol, account: '1300', position: swiss.key },
      { id: 'a2', name: 'Vertrag_Abacus.pdf', path: ver, account: '1300' },
      { id: 'a3', name: 'weg.pdf', path: path.join(tmp, 'gibt-es-nicht.pdf'), account: '1300' },
    ] } }, groupAttachments: { P13: [{ id: 'g1', name: 'Mail_Revision.msg', path: mail }] },
      areaStatus: { A15: { status: 'erledigt', at: '2026-08-01T09:00:00Z', visum: 'MS' } }, groupFindings: { A15: [{ text: 'Police 2026 nachfordern', status: 'offen' }] }, procedures: { A15: { items: { vj: { done: true, note: 'alle 12 VJ-Positionen aufgelöst', ref: 'Q.100', visum: 'MS' } } } } }, { targetDir: target, fileMode: 'move', reportDir: tmp });
    const L = letters.A15 || letters.P13; // wie beim Abschluss: Buchstabe der aktiven, sonst der passiven Abgrenzungen
    const files = (await readdir(path.join(target, '01_Zugeordnet'))).filter(f => f.startsWith(`${L}.100`)).sort();
    expect(files).toEqual([`${L}.100.1_Police_SwissLife.pdf`, `${L}.100.2_Vertrag_Abacus.pdf`, `${L}.100.3_Mail_Revision.msg`, `${L}.100_Analyse_Rechnungsabgrenzungen.xlsx`]);
    expect(existsSync(pol) && existsSync(ver)).toBe(true); // Anhänge immer kopiert
    expect(out.result.analysisFiles?.map(f => f.name)).toContain(`${L}.100_Analyse_Rechnungsabgrenzungen.xlsx`);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(target, '01_Zugeordnet', `${L}.100_Analyse_Rechnungsabgrenzungen.xlsx`));
    const ws = wb.getWorksheet('Rechnungsabgrenzungen')!;
    const vals: string[] = [];
    ws.eachRow(r => vals.push(r.values ? (r.values as unknown[]).map(v => String(v ?? '')).join('|') : ''));
    expect(vals.join('\n')).toMatch(new RegExp(`Swiss Life, BVG Kader[^\\n]*Beleg ${L}\\.100\\.1`));
    expect(vals.join('\n')).toContain(`Beilagen zum Konto: ${L}.100.2 Vertrag_Abacus.pdf`);
    // Hauptdokumentation: Blatt „Prüfgebiete“ mit Status, Visum und Feststellungen
    const main = new ExcelJS.Workbook();
    await main.xlsx.readFile(out.excelPath);
    expect(main.worksheets.map(w => w.name).slice(0, 3)).toEqual(['Übersicht', 'Prüfgebiete', 'Saldenabstimmung']);
    const pa = main.getWorksheet('Prüfgebiete')!;
    const rows: string[] = [];
    pa.eachRow(r => rows.push((r.values as unknown[]).slice(1).map(v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ''))).join('|')));
    const ta = rows.find(r => r.includes('Aktive Rechnungsabgrenzungen'))!;
    expect(rows).toContain('|☑ Vorjahresabgrenzungen auf Auflösung im laufenden Jahr prüfen|||||Q.100|erledigt|MS|||alle 12 VJ-Positionen aufgelöst');
    expect(ta).toMatch(/\|Vorjahresvergleich TA\|erledigt\|MS\|2026-08-01\|1\|☐ Police 2026 nachfordern$/);
  }, 60_000);
});
