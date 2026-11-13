/** Analyse der Erfolgsrechnung: Staffel nach KMU-Kontenrahmen, Margen, Vorjahr, Bemerkungen, Excel */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { analyzeIncomeStatement, type IncomeSection, type IncomeResult } from '../src/analysis/incomeStatement.js';
import { incomeWorkbook } from '../src/report/incomeExcel.js';

// Saldobilanz-Vorzeichen: Ertrag Haben (−), Aufwand Soll (+); Beträge in Rappen
const acc = (accountNumber: string, groupCode: string, accountName: string, cy: number, py: number | null) => ({
  accountNumber, groupCode, accountName, category: groupCode === 'E30' || groupCode === 'E70' ? 'ertrag' : 'aufwand', balanceCurrentYear: cy * 100, balancePreviousYear: py === null ? null : py * 100,
});
const accounts = [
  acc('3200', 'E30', 'Handelserlöse', -1_000_000, -900_000),
  acc('3800', 'E30', 'Erlösminderungen', 20_000, 10_000),
  acc('4200', 'E40', 'Handelswarenaufwand', 600_000, 540_000),
  acc('5000', 'E50', 'Lohnaufwand', 150_000, 140_000),
  acc('5700', 'E50', 'AHV/IV/EO/ALV', 15_000, 14_000),
  acc('5720', 'E50', 'Berufliche Vorsorge', 9_000, 8_000),
  acc('6000', 'E60', 'Raumaufwand', 36_000, 36_000),
  acc('6500', 'E60', 'Verwaltungsaufwand', 20_000, 22_000),
  acc('6800', 'E60', 'Abschreibungen', 30_000, 25_000),
  acc('6900', 'E60', 'Zinsaufwand', 5_000, 6_000),
  acc('8900', 'E89', 'Direkte Steuern', 23_000, 20_000),
  acc('1000', 'A10', 'Kasse', 5_000, 4_000), // Bilanzkonto – gehört nicht dazu
  { ...acc('9200', 'X90', 'Gewinn', 0, 0), category: 'abschluss' },
];
const clean = accounts.map(x => (x.groupCode === 'A10' ? { ...x, category: 'aktiven' } : x));
const a = analyzeIncomeStatement(clean);
const sec = (id: string) => a.rows.find(r => r.kind === 'section' && r.id === id) as IncomeSection;
const res = (id: string) => a.rows.find(r => r.kind === 'result' && r.id === id) as IncomeResult;

describe('Staffel und Margen', () => {
  it('Reihenfolge Abschnitte/Ergebnisse; leere Nebenabschnitte weggelassen', () => {
    expect(a.rows.map(r => r.key)).toEqual([
      'S:ertrag', 'R:betriebsertrag', 'S:material', 'R:brutto1', 'S:personal', 'R:brutto2', 'S:betrieb', 'R:ebitda',
      'S:abschreibungen', 'R:ebit', 'S:finanz', 'R:betriebsergebnis', 'R:vorSteuern', 'S:steuern', 'R:gewinn',
    ]);
    expect(a.check.accounts).toBe(11);
  });
  it('Zwischenergebnisse, Ertrag positiv / Aufwand negativ, Jahresgewinn = Summe aller Erfolgskonten', () => {
    expect([res('betriebsertrag').cy, res('brutto1').cy, res('brutto2').cy, res('ebitda').cy, res('ebit').cy, res('gewinn').cy].map(x => x / 100))
      .toEqual([980_000, 380_000, 206_000, 150_000, 120_000, 92_000]);
    expect(res('gewinn').cy).toBe(a.check.total);
    expect(res('gewinn').py! / 100).toBe(900_000 - 10_000 - 540_000 - 162_000 - 58_000 - 25_000 - 6_000 - 20_000);
  });
  it('Untergruppen nach Kontonummer: Erlösminderungen, Sozialversicherungen', () => {
    expect(sec('ertrag').subs.map(s => [s.id, s.cy / 100])).toEqual([['erloese', 1_000_000], ['erloesminderungen', -20_000]]);
    expect(sec('personal').subs.map(s => [s.id, s.cy / 100, s.accounts.map(x => x.accountNumber)])).toEqual([['lohn', -150_000, ['5000']], ['sozial', -24_000, ['5700', '5720']]]);
  });
  it('Anteil am Betriebsertrag (beide Jahre), Differenz und Differenz %', () => {
    const b1 = res('brutto1');
    expect(b1.pctCy).toBeCloseTo(380_000 / 980_000, 6);
    expect(b1.pctPy).toBeCloseTo(350_000 / 890_000, 6);
    expect(b1.diff! / 100).toBe(30_000);
    expect(b1.diffPct).toBeCloseTo(30_000 / 350_000, 6);
    const em = sec('ertrag').subs.find(s => s.id === 'erloesminderungen')!;
    expect(em.diffPct).toBeCloseTo(-1, 6); // −20'000 statt −10'000: Verdoppelung der Minderung
    expect(em.accounts[0]!.big).toBe(true);
  });
  it('vom Prüfer verschobenes Konto (Gruppe) und Konto ohne KMU-Nummer', () => {
    const b = analyzeIncomeStatement([acc('4711', 'E50', 'Temporärpersonal', 10_000, 5_000), { ...acc('X1', '', 'Unbekannt', 1_000, null), groupCode: null }]);
    expect((b.rows.find(r => r.key === 'S:personal') as IncomeSection).subs.map(s => [s.id, s.accounts[0]!.accountNumber])).toEqual([['uebrige', '4711']]);
    expect(b.rows.find(r => r.key === 'S:ohne')).toBeDefined();
  });
  it('ohne Vorjahr: keine Vorjahreswerte, keine Differenzen', () => {
    const b = analyzeIncomeStatement([acc('3200', 'E30', 'Erlöse', -100, null), acc('4200', 'E40', 'Aufwand', 60, null)]);
    expect(b.hasPreviousYear).toBe(false);
    expect(b.rows.every(r => r.py === null && r.diff === null && r.pctPy === null)).toBe(true);
  });
});

describe('Excel', () => {
  it('Staffel mit Bemerkungen, Konten gegliedert, Ergebnisse hervorgehoben', async () => {
    const buf = await incomeWorkbook(a, { 'R:brutto1': { text: 'Marge stabil' }, '5720': { text: 'Neuer BVG-Plan ab 1.1.' } }, { mandate: 'Muster AG', closingDate: '2025-12-31' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    const ws = wb.getWorksheet('Analyse Erfolgsrechnung')!;
    expect([4].map(r => [3, 5].map(c => ws.getCell(r, c).value))).toEqual([['2025', '2024']]);
    const rowOf = (label: string) => { for (let r = 5; r <= ws.rowCount; r++) if (ws.getCell(r, 2).value === label) return r; return -1; };
    const b1 = rowOf('Bruttoergebnis nach Material- und Warenaufwand');
    expect([ws.getCell(b1, 3).value, ws.getCell(b1, 9).value]).toEqual([380_000, 'Marge stabil']);
    const bvg = rowOf('Berufliche Vorsorge');
    expect([ws.getCell(bvg, 1).value, ws.getCell(bvg, 9).value, ws.getRow(bvg).outlineLevel]).toEqual(['5720', 'Neuer BVG-Plan ab 1.1.', 1]);
  });
});

describe('Vorzeichen, Bezugsgrösse, Platzierung', () => {
  it('Saldobilanz mit umgekehrtem Vorzeichen (Ertrag +): wird erkannt, Ertrag bleibt positiv', () => {
    const flipped = clean.map(x => ({ ...x, balanceCurrentYear: -x.balanceCurrentYear, balancePreviousYear: x.balancePreviousYear === null ? null : -x.balancePreviousYear }));
    const b = analyzeIncomeStatement(flipped);
    expect(b.signFlipped).toBe(true);
    expect(a.signFlipped).toBe(false);
    expect(b.rows.map(r => r.cy)).toEqual(a.rows.map(r => r.cy));
  });
  it('Bezugsgrösse Lohnaufwand (Untergruppe): Lohn = 100 %, Sozialversicherungen in % des Lohns, positiv', () => {
    const b = analyzeIncomeStatement(clean, { base: { kind: 'line', key: 'U:personal/lohn' } });
    expect(b.base).toMatchObject({ key: 'U:personal/lohn', label: 'Lohnaufwand', cy: -15_000_000 });
    const p = b.rows.find(r => r.key === 'S:personal') as IncomeSection;
    expect(p.subs.map(s => [s.id, s.pctCy])).toEqual([['lohn', 1], ['sozial', 0.16]]);
    expect(p.subs[1]!.accounts.map(x => x.pctCy)).toEqual([0.1, 0.06]);
    expect(p.subs[0]!.pctPy).toBe(1);
  });
  it('Bezugsgrösse Einzelkonten (mehrere)', () => {
    const b = analyzeIncomeStatement(clean, { base: { kind: 'accounts', accounts: ['3200', '3800'] } });
    expect(b.base).toMatchObject({ cy: 98_000_000, label: '2 Konten (3200, 3800)' });
    expect(res('betriebsertrag').pctCy).toBe(1);
  });
  it('unbekannte Bezugsgrösse → Betriebsertrag', () => {
    expect(analyzeIncomeStatement(clean, { base: { kind: 'line', key: 'R:gibtsnicht' } }).base.key).toBe('R:betriebsertrag');
  });
  it('Platzierung per Drag & Drop: Konto in andere Untergruppe bzw. anderen Abschnitt', () => {
    const b = analyzeIncomeStatement(clean, { placements: { '5720': { section: 'personal', sub: 'uebriger' }, '6500': { section: 'material', sub: 'dienstleistungen' } } });
    const p = b.rows.find(r => r.key === 'S:personal') as IncomeSection;
    expect(p.subs.map(s => [s.id, s.accounts.map(x => x.accountNumber)])).toEqual([['lohn', ['5000']], ['sozial', ['5700']], ['uebriger', ['5720']]]);
    const m = b.rows.find(r => r.key === 'S:material') as IncomeSection;
    expect(m.subs.find(s => s.id === 'dienstleistungen')!.accounts.map(x => x.accountNumber)).toEqual(['6500']);
    // Jahresgewinn unverändert, Bruttoergebnis 1 kleiner um den Verwaltungsaufwand
    expect(b.rows.find(r => r.key === 'R:gewinn')!.cy).toBe(res('gewinn').cy);
    expect(b.rows.find(r => r.key === 'R:brutto1')!.cy).toBe(res('brutto1').cy - 2_000_000);
  });
});

describe('Bezugsgrösse je Zeile', () => {
  it('AHV in % des Lohnaufwands, BVG in % eines Einzelkontos; übrige Zeilen beim Betriebsertrag', () => {
    const b = analyzeIncomeStatement(clean, { rowBases: { '5700': { kind: 'line', key: 'U:personal/lohn' }, '5720': { kind: 'accounts', accounts: ['5000'] }, 'U:personal/sozial': { kind: 'line', key: 'S:personal' } } });
    const p = b.rows.find(r => r.key === 'S:personal') as IncomeSection;
    const soz = p.subs.find(s => s.id === 'sozial')!;
    expect(soz.accounts.map(x => [x.accountNumber, x.pctCy, x.pctBase?.label])).toEqual([['5700', 0.1, 'Lohnaufwand'], ['5720', 0.06, '5000 Lohnaufwand']]);
    expect(soz.pctCy).toBeCloseTo(24_000 / 174_000, 6);
    expect(soz.pctBase).toEqual({ key: 'S:personal', label: 'Personalaufwand' });
    expect(p.pctBase).toBeUndefined();
    expect(p.pctCy).toBeCloseTo(-174_000 / 980_000, 6);
    // Vorjahr ebenfalls zur eigenen Bezugsgrösse
    expect(soz.accounts[0]!.pctPy).toBe(0.1);
  });
});
