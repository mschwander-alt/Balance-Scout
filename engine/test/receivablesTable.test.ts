/**
 * OP-Listen als Tabelle (Excel, CSV): Spaltenzuordnung, Betrags- und Datumsformate, Totale, Grenzfälle.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { readDocument, type EvidenceLine } from '../src/ingest/readDocument.js';
import { parseOpList, analyzeAging, cellAmount, cellDate, receivablesFor, itemKey } from '../src/analysis/receivables.js';

let dir = '';
beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'bs-op-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

/** Excel-Datei mit echten leeren Zellen (null) schreiben und wie die App einlesen */
async function xlsx(name: string, rows: (string | number | Date | null)[][]): Promise<EvidenceLine[]> {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), 'OP');
  const p = path.join(dir, name);
  await writeFile(p, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return (await readDocument(p, name, {} as never)).lines;
}
async function csv(name: string, text: string): Promise<EvidenceLine[]> {
  const p = path.join(dir, name);
  await writeFile(p, text, 'utf8');
  return (await readDocument(p, name, {} as never)).lines;
}
const base = { closingDate: '2025-12-31', termDays: 30, rates: {} };
const failed = (a: ReturnType<typeof analyzeAging>) => a.checks.filter(c => !c.passed).map(c => c.name);

describe('cellAmount – Beträge in Tabellenzellen', () => {
  it.each([
    ["1'234.50", 123450], ['1’234.50', 123450], ['1 234.50', 123450], ['1.234,50', 123450], ['1,234.50', 123450],
    ['1234,5', 123450], ['31230.2', 3123020], ['23410', 2341000], ['0.05', 5],
    ['-500.00', -50000], ['500.00-', -50000], ['(500.00)', -50000], ['−500', -50000],
    ['CHF 1\'000.00', 100000], ['1000.00 EUR', 100000], ['CHF -1\'000.00', -100000], ["1'234'567.89", 123456789],
  ])('%s → %d Rappen', (raw, cents) => expect(cellAmount(raw)).toBe(cents));

  it.each(['', '   ', 'R-2025-118', 'Meier AG', '12.5%', '1.2.3', '15.12.2025', '1,2,3', 'CHF', '--5', '1.234.5'])('%j → null', raw =>
    expect(cellAmount(raw)).toBeNull());

  it('undefined → null', () => expect(cellAmount(undefined)).toBeNull());
});

describe('cellDate – Datum in Tabellenzellen', () => {
  it.each([
    ['15.12.2025', '2025-12-15'], ['1.2.2025', '2025-02-01'], ['15.12.25', '2025-12-15'], ['15/12/2025', '2025-12-15'],
    ['2025-12-15', '2025-12-15'], ['2025-12-15T00:00:00Z', '2025-12-15'], ['15.12.2025 00:00', '2025-12-15'], ['29.02.2024', '2024-02-29'],
  ])('%s → %s', (raw, iso) => expect(cellDate(raw)).toBe(iso));

  it.each(['31.02.2025', '29.02.2025', '31.04.2025', '00.12.2025', '15.13.2025', '2025-02-30', 'R-2025-118', '', '15.12.'])('%j ist kein Datum', raw =>
    expect(cellDate(raw)).toBeNull());
});

describe('Excel: Spaltenpositionen bleiben erhalten', () => {
  it('leere Zelle in der Mitte verschiebt die Spalten nicht', async () => {
    const lines = await xlsx('leer.xlsx', [
      ['Offene Posten Debitoren per 31.12.2025'],
      ['Kunde', 'Rechnung', 'Datum', 'Fällig', 'Mahnstufe', 'Betrag'],
      ['Meier AG', 'R-1', '15.11.2025', '15.12.2025', 1, 1000],
      ['Meier AG', 'R-2', '20.12.2025', null, null, 250.5], // Fälligkeit und Mahnstufe leer
      ['Total', null, null, null, null, 1250.5],
    ]);
    // Text wie bisher (nur gefüllte Zellen), Positionen separat
    expect(lines[3]!.text).toBe('Meier AG | R-2 | 20.12.2025 | 250.50');
    expect(lines[3]!.cells).toEqual(['Meier AG', 'R-2', '20.12.2025', '', '', '250.50']);

    const l = parseOpList(lines);
    expect(l.items.map(i => [i.docNo, i.date, i.dueDate, i.dunningLevel, i.amount])).toEqual([
      ['R-1', '2025-11-15', '2025-12-15', 1, 100000],
      ['R-2', '2025-12-20', null, null, 25050],
    ]);
    const a = analyzeAging(l, base);
    expect(failed(a)).toEqual([]);
    // R-1: fällig 15.12. → 16 Tage; R-2: Belegdatum + 30 → nicht fällig
    expect(a.items.map(i => [i.bucket, i.dueWhy])).toEqual([[1, 'Fälligkeit laut Liste'], [0, 'Belegdatum + 30 Tage']]);
  });

  it('Kunde nur in der ersten Zeile des Blocks gilt für die folgenden Posten; Kunden- und Gesamttotale', async () => {
    const lines = await xlsx('block.xlsx', [
      ['OP-Liste per 31.12.2025'],
      ['Kunden-Nr', 'Kunde', 'Beleg', 'Datum', 'Offen'],
      ['1001', 'Alpha AG', 'R-1', '01.12.2025', 100],
      [null, null, 'R-2', '05.12.2025', 200],
      ['Total 1001 Alpha AG', null, null, null, 300],
      ['1002', 'Beta GmbH', 'R-3', '01.10.2025', 50],
      [null, null, 'G-1', '10.12.2025', -20],
      ['Total Beta GmbH', null, null, null, 30],
      ['Gesamttotal', null, null, null, 330],
    ]);
    const l = parseOpList(lines);
    expect(l.items.map(i => [i.customerNo, i.customerName, i.amount])).toEqual([
      ['1001', 'Alpha AG', 10000], ['1001', 'Alpha AG', 20000], ['1002', 'Beta GmbH', 5000], ['1002', 'Beta GmbH', -2000],
    ]);
    expect(l.customerTotals.map(t => [t.customerName, t.amount])).toEqual([['Alpha AG', 30000], ['Beta GmbH', 3000]]);
    expect(l.grandTotals.map(g => g.amount)).toEqual([33000]);
    const a = analyzeAging(l, base);
    expect(failed(a)).toEqual([]);
    expect(a.customers).toHaveLength(2);
    expect(a.credits).toBe(-2000);
  });

  it('falsches Kundentotal wird erkannt', async () => {
    const l = parseOpList(await xlsx('falsch.xlsx', [
      ['OP-Liste per 31.12.2025'], ['Kunde', 'Datum', 'Betrag'],
      ['Alpha AG', '01.12.2025', 100], ['Total Alpha AG', null, 999], ['Beta GmbH', '01.12.2025', 50], ['Total', null, 1049],
    ]));
    expect(l.customerTotals.map(t => t.amount)).toEqual([99900]);
    expect(l.grandTotals.map(g => g.amount)).toEqual([104900]);
    const a = analyzeAging(l, base);
    expect(failed(a)).toEqual(['Kundentotale', 'Gesamttotal CHF']);
  });

  it('Gesamttotale je Währung, Währung aus Spalte', async () => {
    const l = parseOpList(await xlsx('fx.xlsx', [
      ['Offene Posten per 31.12.2025'], ['Kunde', 'Datum', 'Whg', 'Offen'],
      ['Alpha AG', '01.12.2025', 'CHF', 100], ['Beta SA', '01.12.2025', 'EUR', 200], ['Gamma Inc', '01.12.2025', 'USD', 300],
      ['Total CHF', null, null, 100], ['Total EUR', null, null, 200], ['Total USD', null, null, 300],
    ]));
    expect(l.items.map(i => i.currency)).toEqual(['CHF', 'EUR', 'USD']);
    expect(l.grandTotals.map(g => [g.currency, g.amount])).toEqual([['CHF', 10000], ['EUR', 20000], ['USD', 30000]]);
    expect(failed(analyzeAging(l, { ...base, rates: { EUR: 0.93, USD: 0.8 } }))).toEqual([]);
  });

  it('Übertrag, Nullposten und wiederholte Kopfzeile werden übergangen', async () => {
    const l = parseOpList(await xlsx('uebertrag.xlsx', [
      ['OP-Liste per 31.12.2025'], ['Kunde', 'Datum', 'Betrag'],
      ['Alpha AG', '01.12.2025', 100], ['Übertrag', null, 100],
      ['Kunde', 'Datum', 'Betrag'],
      ['Beta GmbH', '01.12.2025', 0], ['Gamma AG', '02.12.2025', 50], ['Total', null, 150],
    ]));
    expect(l.items.map(i => i.customerName)).toEqual(['Alpha AG', 'Gamma AG']);
    expect(l.grandTotals.map(g => g.amount)).toEqual([15000]);
    expect(l.customerTotals).toEqual([]);
  });

  it('Zeile mit Datum, aber unlesbarem Betrag wird gemeldet statt verschwiegen', async () => {
    const l = parseOpList(await xlsx('unlesbar.xlsx', [
      ['OP-Liste per 31.12.2025'], ['Kunde', 'Datum', 'Betrag'],
      ['Alpha AG', '01.12.2025', 100], ['Beta GmbH', '02.12.2025', 'ca. 50'],
    ]));
    expect(l.items).toHaveLength(1);
    expect(l.unreadable.map(u => u.line)).toEqual(['Beta GmbH | 02.12.2025 | ca. 50']);
    expect(failed(analyzeAging(l, base))).toContain('Lesbarkeit');
  });

  it('Zeile mit Betrag ohne Datum: als Zwischensumme gemeldet, Warnung nur wenn das Gesamttotal nicht stimmt', async () => {
    const rows = (total: number) => [
      ['OP-Liste per 31.12.2025'], ['Kunde', 'Datum', 'Betrag'],
      ['Alpha AG', '01.12.2025', 100], ['Alpha AG', null, 100], ['Total', null, total],
    ];
    const ok = analyzeAging(parseOpList(await xlsx('zws1.xlsx', rows(100))), base);
    expect(ok.items).toHaveLength(1);
    expect(ok.checks.find(c => c.name === 'Zeilen ohne Datum')).toMatchObject({ passed: true });
    const ko = analyzeAging(parseOpList(await xlsx('zws2.xlsx', rows(200))), base);
    expect(ko.checks.find(c => c.name === 'Zeilen ohne Datum')).toMatchObject({ passed: false });
  });

  it('echte Excel-Datumszellen werden gelesen', async () => {
    const l = parseOpList(await xlsx('datum.xlsx', [
      ['OP-Liste per 31.12.2025'], ['Kunde', 'Rechnungsdatum', 'Fälligkeit', 'Betrag'],
      ['Alpha AG', new Date(Date.UTC(2025, 10, 1)), new Date(Date.UTC(2025, 11, 1)), 100],
    ]));
    expect(l.items.map(i => [i.date, i.dueDate])).toEqual([['2025-11-01', '2025-12-01']]);
  });
});

describe('CSV-Exporte', () => {
  it('Semikolon, ISO-Datum, Dezimalkomma, Minus hinten, leere Fälligkeit', async () => {
    const lines = await csv('op.csv', [
      'Kunde;Rechnung;Belegdatum;Fälligkeit;Offener Betrag',
      'Alpha AG;R-1;2025-11-01;2025-12-01;1.234,50',
      'Alpha AG;G-1;2025-12-10;;100,00-',
      'Beta GmbH;R-2;2025-08-15;2025-09-14;500,00',
      'Total;;;;1.634,50',
    ].join('\n'));
    const l = parseOpList(lines);
    expect(l.items.map(i => [i.docNo, i.date, i.dueDate, i.amount])).toEqual([
      ['R-1', '2025-11-01', '2025-12-01', 123450], ['G-1', '2025-12-10', null, -10000], ['R-2', '2025-08-15', '2025-09-14', 50000],
    ]);
    const a = analyzeAging(l, { ...base, listDate: '2025-12-31' });
    expect(failed(a)).toEqual([]);
    expect(a.buckets).toEqual([0, 123450, 0, 0, 50000]); // R-1: 30 Tage; R-2: 108 Tage
    expect(a.credits).toBe(-10000);
  });
});

describe('Liste ohne Datumsspalte (nur Kunde und Betrag)', () => {
  it('Posten werden gelesen; Fälligkeit muss der Prüfer erfassen', async () => {
    const lines = await xlsx('ohnedatum.xlsx', [
      ['Offene Posten per 31.12.2025'], ['Kunde', 'Betrag'], ['A AG', 40000], ['B GmbH', 24310.4], ['Total Debitoren', 64310.4],
    ]);
    const l = parseOpList(lines);
    expect(l.items.map(i => [i.customerName, i.date, i.amount])).toEqual([['A AG', null, 4000000], ['B GmbH', null, 2431040]]);
    expect(l.grandTotals.map(g => g.amount)).toEqual([6431040]);
    const a = analyzeAging(l, base);
    expect(failed(a)).toEqual(['Fälligkeit']);
    expect(a.items.every(i => i.dueWhy === 'kein Datum – bitte erfassen')).toBe(true);
    // Prüfer erfasst die Fälligkeit → Posten wird eingeordnet
    const b = analyzeAging(l, { ...base, corrections: { [itemKey(l.items[0]!)]: { due: '2025-09-01' }, [itemKey(l.items[1]!)]: { due: '2026-01-31' } } });
    expect(b.buckets).toEqual([2431040, 0, 0, 0, 4000000]);
    expect(failed(b)).toEqual([]);
  });
});

describe('Korrekturen mit ungültigem Datum', () => {
  it('ungültige manuelle Fälligkeit landet nicht in „> 90 Tage“', () => {
    const line = (text: string, i: number) => ({ page: 1, lineNo: i + 1, text });
    const l = parseOpList(['Liste der offenen Debitorenposten per 31.12.2025', 'Bel.-Nr. Art FIBU-Datum Beleg-Betrag Beleg-OP', '1001 KUNDE A',
      "5001 R Rechnung 20.12.2025 CHF 1'000.00 1'000.00"].map(line));
    const a = analyzeAging(l, { ...base, corrections: { [itemKey(l.items[0]!)]: { due: '2025-02-31' } } });
    expect(a.items[0]).toMatchObject({ due: null, daysOverdue: null });
    expect(a.items[0]!.dueWhy).toMatch(/ungültig/);
    expect(failed(a)).toContain('Fälligkeit');
  });
});

describe('Mehrere Listen mit demselben Kunden', () => {
  it('Kundentotale werden je Liste abgestimmt', () => {
    const doc = (id: string, amount: number) => ({
      doc: { id, filename: `${id}.xlsx`, relPath: `${id}.xlsx`, lines: [
        ['OP-Liste per 31.12.2025'], ['Kunde', 'Datum', 'Betrag'], ['Alpha AG', '01.12.2025', String(amount)], ['Total Alpha AG', '', String(amount)], ['Total', '', String(amount)],
      ].map((c, i) => ({ page: 1, lineNo: i + 1, text: c.filter(Boolean).join(' | '), cells: c })) },
      assignedAccounts: ['1100'],
    });
    const r = receivablesFor({
      documents: [doc('inland', 100), doc('ausland', 250)],
      accounts: [{ accountNumber: '1100', accountName: 'Forderungen L+L', groupCode: 'A12', balanceCurrentYear: 35000 }],
      input: { closingDate: '2025-12-31' },
    }, { docIds: ['inland', 'ausland'] });
    expect(r.aging!.items).toHaveLength(2);
    expect(r.aging!.checks.find(c => c.name === 'Kundentotale')).toMatchObject({ passed: true });
    expect(r.aging!.totalChf).toBe(35000);
    expect(r.suggestions.join(' ')).not.toMatch(/Differenz OP-Liste/);
  });
});

describe('Abstimmung mit frei gewählten Konten', () => {
  const lines = [['OP-Liste per 31.12.2025'], ['Kunde', 'Datum', 'Betrag'], ['Alpha AG', '01.12.2025', '1000'], ['Total', '', '1000']]
    .map((c, i) => ({ page: 1, lineNo: i + 1, text: c.filter(Boolean).join(' | '), cells: c }));
  const res = {
    documents: [{ doc: { id: 'op', filename: 'op.xlsx', relPath: 'op.xlsx', lines }, assignedAccounts: ['1100'] }],
    accounts: [
      { accountNumber: '1100', accountName: 'Forderungen L+L', groupCode: 'A12', balanceCurrentYear: 70000 },
      { accountNumber: '1109', accountName: 'Delkredere', groupCode: 'A12', balanceCurrentYear: -5000 },
      { accountNumber: '1101', accountName: 'Forderungen L+L (manuell)', groupCode: 'A12', balanceCurrentYear: 0 },
      { accountNumber: '1140', accountName: 'Kontokorrent Kunde (falsch gegliedert)', groupCode: 'A13', balanceCurrentYear: 30000 },
      { accountNumber: '3200', accountName: 'Handelserlöse', groupCode: 'E30', balanceCurrentYear: -900000 },
    ],
    input: { closingDate: '2025-12-31' },
  };

  it('ohne Wahl: Konto der Liste; Optionen enthalten alle Konten, Forderungen L+L (ohne Delkredere) zuerst', () => {
    const r = receivablesFor(res, {});
    expect(r.balanceAccounts).toBe('1100');
    expect(r.balanceChf).toBe(70000);
    expect(r.accountOptions.map(o => [o.accountNumber, o.suggested])).toEqual([
      ['1100', true], ['1101', true], ['1109', false], ['1140', false], ['3200', false],
    ]);
  });

  it('gewählte Konten aus anderen Gruppen werden summiert; Differenz verschwindet', () => {
    const r = receivablesFor(res, { accounts: ['1100', '1140'] });
    expect(r.balanceAccounts).toBe('1100, 1140');
    expect(r.balanceChf).toBe(100000);
    expect(r.aging!.totalChf).toBe(100000);
    expect(r.suggestions.join(' ')).not.toMatch(/Differenz OP-Liste/);
  });

  it('ausdrücklich gewähltes Delkredere zählt mit; unbekannte Kontonummer wird ignoriert', () => {
    const r = receivablesFor(res, { accounts: ['1100', '1109', '9999'] });
    expect(r.balanceAccounts).toBe('1100, 1109');
    expect(r.balanceChf).toBe(65000);
  });
});
