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
