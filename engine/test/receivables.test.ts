import { describe, it, expect, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readDocument } from '../src/ingest/readDocument.js';
import { LocalOcr } from '../src/ingest/ocr.js';
import { parseOpList, analyzeAging, looksLikeOpList, bucketOf, suggestFindings, itemKey } from '../src/analysis/receivables.js';

const DIR = path.resolve(import.meta.dirname, 'fixtures', 'op');
const ocr = new LocalOcr();
afterAll(() => ocr.close());
const load = async (f: string) => (await readDocument(path.join(DIR, f), f, { ocr })).lines;

describe('OP-Listen lesen (Abacus, Navision-Scan, Business Central)', async () => {
  const truth = JSON.parse(await readFile(path.join(DIR, 'truth.json'), 'utf8')) as Record<string, { closing: string; customers: number; items: number; totals: Record<string, number> }>;
  it.each(Object.keys(truth))('%s: alle Posten, Kundentotale und Gesamttotal exakt', async f => {
    const t = truth[f]!;
    const lines = await load(f);
    expect(looksLikeOpList(lines)).toBe(true);
    const l = parseOpList(lines);
    expect(l.items).toHaveLength(t.items);
    expect(new Set(l.items.map(i => i.customerNo)).size).toBe(t.customers);
    expect(l.listDate).toBe(t.closing);
    for (const [cur, v] of Object.entries(t.totals)) expect(l.items.filter(i => i.currency === cur).reduce((a, i) => a + i.amount, 0)).toBe(v);
    const a = analyzeAging(l, { closingDate: t.closing, termDays: 30, rates: { EUR: 0.93, USD: 0.9 } });
    expect(a.checks.filter(c => !c.passed)).toEqual([]);
    expect(a.customers).toHaveLength(t.customers);
  }, 120_000);
});

describe('Fälligkeitsanalyse', () => {
  const line = (text: string, i: number) => ({ page: 1, lineNo: i + 1, text });
  const lines = [
    'Liste der offenen Debitorenposten per 31.12.2025', 'Bel.-Nr. Art FIBU-Datum Beleg-Betrag Beleg-OP',
    '1001 KUNDE A',
    '5001 R Rechnung 20.12.2025 CHF 1\'000.00 1\'000.00', // fällig 19.01.26 -> nicht fällig
    '5002 R Rechnung 15.11.2025 CHF 500.00 500.00', // fällig 15.12. -> 16 Tage
    '5003 R Rechnung 01.06.2025 EUR 200.00 200.00', // > 90
    '5004 G Gutschrift 10.12.2025 CHF -300.00 -300.00',
    "Total 1001 KUNDE A 4 Beleg(e) CHF 1'200.00 1'200.00",
  ].map(line);
  const l = parseOpList(lines);
  const a = analyzeAging(l, { closingDate: '2025-12-31', termDays: 30, rates: { EUR: 0.95 } });
  it('Altersklassen nur für Rechnungen, Gutschriften separat, Fremdwährung umgerechnet', () => {
    expect(a.buckets).toEqual([100000, 50000, 0, 0, 19000]);
    expect(a.credits).toBe(-30000);
    expect(a.totalChf).toBe(139000);
    expect(a.kpis.overdueCustomers).toBe(1);
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(30)).toBe(1);
    expect(bucketOf(91)).toBe(4);
  });
  it('fehlender Kurs wird gemeldet, Abstimmung mit Saldo als Feststellung', () => {
    const b = analyzeAging(l, { closingDate: '2025-12-31', termDays: 30, rates: {} });
    expect(b.missingRates).toEqual(['EUR']);
    expect(b.checks.find(c => c.name === 'Fremdwährungskurse')?.passed).toBe(false);
    expect(suggestFindings(a, 150000).join(' ')).toMatch(/Differenz OP-Liste zu Saldo/);
  });
});

describe('Hilfe durch den Prüfer (Korrekturen)', () => {
  const line = (text: string, i: number) => ({ page: 1, lineNo: i + 1, text });
  const lines = [
    'Liste der offenen Debitorenposten', 'Bel.-Nr. Art FIBU-Datum Beleg-Betrag Beleg-OP',
    '1001 KUNDE A',
    "5001 R Rechnung 20.12.2025 CHF 1'000.00 1'000.00",
    '5002 R Rechnung 15.11.2025 CHF 500.00 500.00',
    '5003 R Rechnung 01.06.2025 CHF 200.00 200.00',
  ].map(line);
  const l = parseOpList(lines);
  const k = (n: number) => itemKey(l.items[n]!);
  const base = { closingDate: '2025-12-31', termDays: 30, rates: {} };

  it('ohne Stichtag in der Liste: Hinweis; Prüfer erfasst den Stichtag', () => {
    expect(analyzeAging(l, base).checks.find(c => c.name === 'Stichtag der Liste')!.passed).toBe(false);
    expect(analyzeAging(l, { ...base, listDate: '2025-12-31' }).checks.find(c => c.name === 'Stichtag der Liste')!.passed).toBe(true);
  });

  it('Frist je Kunde, Fälligkeit manuell, Betrag korrigiert, Posten ausgeschlossen – mit Herleitung', () => {
    const a0 = analyzeAging(l, base);
    expect(a0.items.map(i => [i.due, i.dueWhy])).toEqual([['2026-01-19', 'Belegdatum + 30 Tage'], ['2025-12-15', 'Belegdatum + 30 Tage'], ['2025-07-01', 'Belegdatum + 30 Tage']]);
    const a = analyzeAging(l, { ...base, customerTerms: { '1001': 60 }, corrections: { [k(0)]: { due: '2025-10-31', comment: 'Fälligkeit laut Rechnung' }, [k(1)]: { amount: 40000 }, [k(2)]: { exclude: true, comment: 'bezahlt am 05.01.2026' } } });
    expect(a.items.map(i => [i.due, i.daysOverdue, i.amount, i.dueWhy, i.corrected])).toEqual([
      ['2025-10-31', 61, 100000, 'manuell erfasst', true],
      ['2026-01-14', -14, 40000, 'Belegdatum + 60 Tage (Frist des Kunden)', true],
    ]);
    expect(a.excluded.map(i => i.comment)).toEqual(['bezahlt am 05.01.2026']);
    expect(a.totalChf).toBe(140000);
    expect(a.checks.find(c => c.name === 'Korrekturen Prüfer')!.message).toMatch(/3 Posten vom Prüfer korrigiert, davon 1 ausgeschlossen/);
  });

  it('Fälligkeit immer aus Belegdatum + Frist bzw. letztes Datum der Zeile', () => {
    const l2 = parseOpList(['Liste per 31.12.2025', 'Bel.-Nr. Art FIBU-Datum Beleg-Betrag Beleg-OP', '1001 KUNDE A', '5001 R Rechnung 01.12.2025 31.03.2026 CHF 100.00 100.00'].map(line));
    expect(analyzeAging(l2, { ...base, dueMode: 'lastDate' }).items[0]!.due).toBe('2026-03-31');
    expect(analyzeAging(l2, { ...base, dueMode: 'term' }).items[0]!.due).toBe('2025-12-31');
  });
});
