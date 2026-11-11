import { describe, it, expect } from 'vitest';
import { extractAmounts } from '../src/domain/matching/extractAmounts.js';
import { runMatching, type MatchAccount } from '../src/domain/matching/engine.js';

const L = (text: string, lineNo = 1, page = 1) => ({ page, lineNo, text });

describe('extractAmounts', () => {
  it('ignoriert Datum, IBAN, Uhrzeit, Prozent und Jahreszahlen', () => {
    const a = extractAmounts('d', [
      L('Kontoauszug per 31.12.2025 IBAN CH93 0076 2011 6238 5295 7 um 14:30'),
      L('Zins 1.25 % Geschäftsjahr 2025'),
    ]);
    expect(a).toEqual([]);
  });

  it('findet CH-Beträge mit Kontext', () => {
    const a = extractAmounts('d', [L("Saldo zu Ihren Gunsten CHF 48'250.35"), L('Total -1 234,50'), L("Kassabestand 1'500.–")]);
    expect(a.map(x => x.cents)).toEqual([4825035, -123450, 150000]);
    expect(a[0]!.context).toMatchObject({ balanceKeyword: true, currency: 'CHF' });
  });

  it('trennt mehrere Beträge in einer Zeile', () => {
    const a = extractAmounts('d', [L("Soll 1'000.00 Haben 2'500.50 Saldo 1'500.50")]);
    expect(a.map(x => x.cents)).toEqual([100000, 250050, 150050]);
  });
});

const acc = (id: string, nr: string, name: string, bal: number, cat: MatchAccount['category'] = 'aktiven'): MatchAccount =>
  ({ id, accountNumber: nr, accountName: name, balance: bal, category: cat });

describe('runMatching', () => {
  const docs = [{ id: 'D1', filename: 'UBS_Kontoauszug_1020.pdf' }, { id: 'D2', filename: 'Rechnungen.pdf' }];

  it('BELEGT bei exaktem Treffer mit Kontext', () => {
    const amounts = extractAmounts('D1', [L("Schlusssaldo per 31.12.2025 CHF 48'250.35")]);
    const r = runMatching([acc('A', '1020', 'Bank UBS Kontokorrent', 4825035)], docs, amounts);
    expect(r.results[0]!.status).toBe('BELEGT');
    expect(r.summary.coverage).toBe(1);
  });

  it('PRUEFEN bei exaktem Betrag ohne Kontext (Zufallstreffer möglich)', () => {
    const amounts = extractAmounts('D2', [L("Position 17   12'000.00")]);
    const r = runMatching([acc('A', '1100', 'Debitoren', 1200000)], docs, amounts);
    expect(r.results[0]!.status).toBe('PRUEFEN');
    expect(r.results[0]!.reasons.join(' ')).toMatch(/unter Schwelle/);
  });

  it('PRUEFEN bei Toleranz-Treffer, nie BELEGT', () => {
    const amounts = extractAmounts('D1', [L("Saldo 1020 CHF 48'250.85")]);
    const r = runMatching([acc('A', '1020', 'Bank UBS', 4825035)], docs, amounts, { absoluteToleranceCents: 100 });
    expect(r.results[0]).toMatchObject({ status: 'PRUEFEN', best: { kind: 'tolerance', differenceCents: 50 } });
  });

  it('KEIN_NACHWEIS ausserhalb der Toleranz', () => {
    const amounts = extractAmounts('D1', [L("Saldo CHF 48'260.35")]);
    const r = runMatching([acc('A', '1020', 'Bank UBS', 4825035)], docs, amounts);
    expect(r.results[0]!.status).toBe('KEIN_NACHWEIS');
  });

  it('erkennt Vorzeichenkonflikt (Kontokorrent im Minus)', () => {
    const amounts = extractAmounts('D1', [L("Saldo 1020 CHF -48'250.35")]);
    const r = runMatching([acc('A', '1020', 'Bank UBS', 4825035)], docs, amounts);
    expect(r.results[0]!.status).toBe('PRUEFEN');
    expect(r.results[0]!.best!.flags).toContain('SIGN_CONFLICT');
  });

  it('markiert mehrdeutige Treffer', () => {
    const amounts = extractAmounts('D2', [L("Saldo 5'000.00")]);
    const r = runMatching([acc('A', '1100', 'Debitoren', 500000), acc('B', '1140', 'Vorschüsse', 500000)], docs, amounts);
    expect(r.results.every(x => x.best?.flags.includes('AMBIGUOUS'))).toBe(true);
    expect(r.results.every(x => x.status === 'PRUEFEN')).toBe(true);
  });

  it('Nullsaldo und Erfolgsrechnung ausserhalb Umfang', () => {
    const r = runMatching([acc('A', '1000', 'Kasse', 0), acc('B', '3200', 'Warenertrag', -2000000, 'ertrag')], docs, []);
    expect(r.results.map(x => x.status)).toEqual(['NULLSALDO', 'NICHT_IM_UMFANG']);
  });

  it('beschränkt Suche auf manuell zugeordnete Dokumente', () => {
    const amounts = extractAmounts('D2', [L("Saldo 1020 48'250.35")]);
    const r = runMatching([acc('A', '1020', 'Bank', 4825035)], docs, amounts, { assignments: { A: ['D1'] } });
    expect(r.results[0]!.status).toBe('KEIN_NACHWEIS');
  });

  it('ist deterministisch', () => {
    const amounts = extractAmounts('D1', [L("Saldo 48'250.35"), L("Total 12'000.00")]);
    const a = [acc('A', '1020', 'Bank', 4825035), acc('B', '1100', 'Debitoren', 1200000)];
    expect(runMatching(a, docs, amounts)).toEqual(runMatching(a, docs, amounts));
  });
});
