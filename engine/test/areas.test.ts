/** Übersicht der Prüfgebiete: Status, Visum, Abdeckung und Feststellungen je Gruppe (auch im Excel) */
import { describe, it, expect } from 'vitest';
import { areaOverview } from '../src/analysis/areas.js';

const acc = (accountNumber: string, groupCode: string | null, category: string, balance: number, status: string) => ({ accountNumber, groupCode, category, balance, balancePreviousYear: balance / 2, status });

describe('Prüfgebiete', () => {
  const accounts = [
    acc('1000', 'A10', 'aktiven', 10_000, 'BELEGT'), acc('1020', 'A10', 'aktiven', 30_000, 'KEIN_NACHWEIS'),
    acc('1100', 'A12', 'aktiven', 50_000, 'BELEGT'), acc('1500', 'A21', 'aktiven', 20_000, 'PRUEFEN'),
    acc('2000', 'P10', 'passiven', -40_000, 'BELEGT'), acc('3200', 'E30', 'ertrag', -90_000, 'NICHT_IM_UMFANG'), acc('4200', 'E40', 'aufwand', 60_000, 'NICHT_IM_UMFANG'),
  ];
  const rows = areaOverview(accounts, {
    groupLetters: { A10: 'B', A12: 'E' },
    areaStatus: { A12: { status: 'erledigt', at: '2026-02-10T10:00:00Z', visum: 'MS' }, ER: { status: 'in_arbeit', at: '2026-02-11T10:00:00Z', visum: 'MS' } },
    groupFindings: { A10: [{ text: 'Bankbestätigung PostFinance fehlt', status: 'offen' }], ER: [{ text: 'Margenrückgang erklären', status: 'offen' }] },
    analyses: { receivables: { docId: null, termDays: 30, rates: {}, findings: [{ text: 'Delkredere begründen', status: 'erledigt' }] }, fixedAssets: { findings: [{ text: 'Abschreibungssatz prüfen', status: 'offen' }] } },
  });

  it('eine Zeile je Bilanzgruppe mit Konten, Erfolgsrechnung am Schluss', () => {
    expect(rows.map(r => r.code)).toEqual(['A10', 'A12', 'A21', 'P10', 'ER']);
    expect(rows.at(-1)).toMatchObject({ name: 'Erfolgsrechnung', cy: -30_000, coverage: null, analysis: 'Analyse mit Margen', status: 'in_arbeit' });
  });

  it('Abdeckung = belegte Beträge / Prüfumfang', () => {
    expect(rows[0]).toMatchObject({ letter: 'B', accounts: 2, cy: 40_000, py: 20_000, coverage: 0.25, analysis: null, status: 'offen', visum: '' });
  });

  it('Status und Visum; Feststellungen aus Gruppe und vertiefter Prüfung', () => {
    expect(rows[1]).toMatchObject({ code: 'A12', letter: 'E', status: 'erledigt', visum: 'MS', analysis: 'Fälligkeitsanalyse' });
    expect(rows[1]!.findings).toEqual([{ text: 'Delkredere begründen', status: 'erledigt' }]);
    expect(rows[0]!.findings.map(f => f.text)).toEqual(['Bankbestätigung PostFinance fehlt']);
    expect(rows[2]!.findings.map(f => f.text)).toEqual(['Abschreibungssatz prüfen']);
  });

  it('Prüfungshandlungen: Katalog je Gebiet, Entscheide, ausgeblendete und eigene Handlungen', async () => {
    const { areaProcedures } = await import('../src/analysis/areas.js');
    const { proceduresFor, DEFAULT_PROCEDURES } = await import('../src/analysis/procedures.js');
    // jedes Gebiet der Bilanz und die Erfolgsrechnung hat Handlungen, eindeutige Nummern
    for (const [code, list] of Object.entries(DEFAULT_PROCEDURES)) {
      expect(list.length, code).toBeGreaterThan(1);
      expect(new Set(list.map(x => x.id)).size, code).toBe(list.length);
    }
    expect(proceduresFor('A24').length).toBeGreaterThan(0); // allgemeine Handlungen
    const h = areaProcedures('A10', {
      procedures: { A10: { removed: ['fw'], custom: [{ id: 'c1', text: 'Festgeld mit Bestätigung abstimmen' }], items: { bank: { done: true, note: 'CS und RB bestätigt', ref: 'B.1, B.2', visum: 'MS' }, c1: { done: false, note: 'angefordert' } } } },
    });
    expect(h.map(x => x.id)).toEqual(['bank', 'kasse', 'vorjahr', 'verfuegung', 'c1']);
    expect(h[0]).toMatchObject({ done: true, note: 'CS und RB bestätigt', ref: 'B.1, B.2', visum: 'MS', custom: false });
    expect(h.at(-1)).toMatchObject({ text: 'Festgeld mit Bestätigung abstimmen', note: 'angefordert', custom: true });
  });
});
