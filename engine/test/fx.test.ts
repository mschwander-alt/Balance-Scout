import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { readDocument } from '../src/ingest/readDocument.js';
import { LocalOcr } from '../src/ingest/ocr.js';
import { parseLedger, looksLikeLedger } from '../src/ingest/ledger.js';
import { parseEstvRates, looksLikeRateList } from '../src/ingest/fxRates.js';
import { runAudit, type RunResult } from '../src/index.js';

const FX = path.resolve(import.meta.dirname, 'fixtures', 'fx');
const ALPEN = path.resolve(import.meta.dirname, 'fixtures', 'alpen');

describe('Kontoblätter und ESTV-Kursliste lesen', () => {
  it.each(['Kontoblaetter_2025.pdf', 'Kontoblaetter_2025.xlsx'])('%s: Währung, Saldovortrag, Buchungen, Schlusssaldo, Kontrolle', async f => {
    const d = await readDocument(path.join(FX, f), f, { ocr: new LocalOcr(), maxOcrPages: 0 });
    expect(looksLikeLedger(d.lines)).toBe(true);
    const l = parseLedger(d.lines, { pageLabels: d.pageLabels });
    expect(l.accounts.map(a => [a.accountNumber, a.currency, a.opening, a.closing, a.consistent])).toEqual([
      ['1020', 'CHF', 8000000, 10000000, true], ['1025', 'EUR', 4000000, 5000000, true], ['1105', 'USD', 0, 1000000, true],
    ]);
    const eur = l.accounts[1]!;
    expect(eur.postings.map(p => [p.date, p.amount, p.contra])).toEqual([['2025-05-12', 1500000, '1105'], ['2025-11-20', -500000, '6800']]);
  });
  it('ESTV-Kursliste: Kurs je 1 Einheit (JPY/DKK per 100)', async () => {
    const d = await readDocument(path.join(FX, 'ESTV_Kursliste_2025.pdf'), 'k.pdf', { ocr: new LocalOcr(), maxOcrPages: 0 });
    expect(looksLikeRateList(d.lines)).toBe(true);
    const r = parseEstvRates(d.lines);
    expect(r.date).toBe('2025-12-31');
    expect(r.rates).toMatchObject({ EUR: 0.9305, USD: 0.79225, GBP: 1.065681, JPY: 0.005054, DKK: 0.124581, DZD: 0.006114 });
  });
  it('Bankauszüge mit "Saldovortrag" gelten nicht als Kontoblatt', async () => {
    const d = await readDocument(path.join(ALPEN, 'Kunde_Upload', 'Bank', 'UBS', 'Kontoauszug.pdf'), 'k.pdf', { ocr: new LocalOcr(), maxOcrPages: 0 });
    expect(looksLikeLedger(d.lines)).toBe(false);
  });
});

describe('Fremdwährungskonten: Abgleich in Fremdwährung, Bewertung zum Stichtagskurs', () => {
  let res: RunResult;
  beforeAll(async () => {
    res = await runAudit({
      mandate: 'Muster Export AG', closingDate: '2025-12-31', trialBalancePath: path.join(FX, 'Saldobilanz_2025.xlsx'),
      evidencePaths: [path.join(FX, 'Kunde')], targetDir: null, fileMode: 'none',
      ledgerPaths: [path.join(FX, 'Kontoblaetter_2025.xlsx')],
      fxRates: { date: '2025-12-31', rates: { EUR: 0.9305, USD: 0.79225 }, source: 'ESTV Kursliste 31.12.2025' },
    });
  }, 120_000);
  const r = (n: string) => res.match.results.find(x => x.accountNumber === n)!;

  it('EUR-Bankkonto: EUR 50\'000 im Auszug = EUR-Saldo laut Kontoblatt -> belegt, keine Bewertungsdifferenz', () => {
    expect(r('1025').status).toBe('BELEGT');
    expect(r('1025').best!.filename).toBe('UBS_EUR_Kontoauszug.pdf');
    expect(res.accountLedger['1025']).toMatchObject({ currency: 'EUR', closing: 5000000, rate: 0.9305, chfAtRate: 4652500, valuationDiff: 0 });
  });
  it('USD-Debitoren: USD-Saldo belegt, Bewertungsdifferenz CHF 27.50 ausgewiesen', () => {
    expect(r('1105').status).toBe('BELEGT');
    expect(res.accountLedger['1105']).toMatchObject({ currency: 'USD', closing: 1000000, chfAtRate: 792250, valuationDiff: 2750 });
  });
  it('CHF-Konto: Kontoblatt stimmt mit Saldobilanz überein', () => {
    expect(r('1020').best!.filename).toBe('UBS_CHF_Kontoauszug.pdf');
    expect(res.accountLedger['1020']).toMatchObject({ currency: 'CHF', tbDiff: 0 });
  });
  it('Kontoblatt im Kundenordner wird erkannt und nicht als Nachweis verwendet', () => {
    const k = res.documents.find(d => d.doc.filename === 'Kontoblaetter_Kopie.pdf')!;
    expect(k.docType).toMatch(/Kontoblatt/);
    expect(res.match.results.every(x => x.best?.documentId !== k.doc.id)).toBe(true);
  });
});
