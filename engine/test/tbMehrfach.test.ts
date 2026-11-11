import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadTrialBalance } from '../src/domain/trialBalance/load.js';
import { splitCombined } from '../src/domain/trialBalance/parser.js';

const DIR = path.resolve(import.meta.dirname, 'fixtures', 'tb_mehrfach');

describe('Saldobilanz: mehrere Blätter, Nummer+Bezeichnung in einer Zelle, Doppel', () => {
  it('mehrere Blätter mit denselben Konten: nur das vollständige Blatt, keine Doppel', async () => {
    const r = await loadTrialBalance([path.join(DIR, 'Saldobilanz_mehrere_Blaetter.xlsx')]);
    expect(r.rows.map(x => x.accountNumber)).toEqual(['1000', '1020', '1100', '2000', '2800', '3200', '4000', '6000']);
    expect(r.rows.reduce((s, x) => s + x.balanceCurrentYear, 0)).toBe(0);
    const bil = r.parts.find(p => p.sheet === 'Bilanz')!;
    expect([bil.status, bil.reason]).toEqual(['ignoriert', 'enthält dieselben Konten wie „Saldobilanz_mehrere_Blaetter.xlsx › Saldobilanz“']);
    expect(r.issues.some(i => i.code === 'PART_DUPLICATE')).toBe(true);
    // Prüfer kann das Blatt trotzdem einschliessen bzw. ein Blatt abwählen
    const forced = await loadTrialBalance([path.join(DIR, 'Saldobilanz_mehrere_Blaetter.xlsx')], { forceParts: [bil.id] });
    expect(forced.rows.length).toBe(8); // Doppel werden trotzdem nur einmal übernommen
    expect(forced.excluded.filter(e => /^doppelt/.test(e.reason)).length).toBe(5);
  });

  it('Nummer und Bezeichnung in einer Zelle; doppelte Zeilen werden ausgewiesen', async () => {
    const r = await loadTrialBalance([path.join(DIR, 'Saldenliste_Nummer_und_Name.xlsx')]);
    expect(r.rows.map(x => [x.accountNumber, x.accountName])).toContainEqual(['1020', 'Bank UBS']);
    expect(r.rows.length).toBe(8);
    expect(r.rows.find(x => x.accountNumber === '6000')).toMatchObject({ balanceCurrentYear: 4349950, balancePreviousYear: 5380000 });
    expect(r.excluded.map(e => e.reason)).toEqual(['doppelt – bereits Zeile 4 (gleicher Saldo)', 'doppelt – bereits Zeile 5 (anderer Saldo – prüfen!)']);
    expect(r.issues.some(i => i.code === 'DUPLICATE_DIFFERENT' && /1100/.test(i.message))).toBe(true);
  });

  it('splitCombined', () => {
    expect(splitCombined('1020 - Bank UBS')).toEqual({ no: '1020', name: 'Bank UBS' });
    expect(splitCombined('1020: Bank')).toEqual({ no: '1020', name: 'Bank' });
    expect(splitCombined('Bank 1020')).toBeNull();
    expect(splitCombined('1020')).toBeNull();
  });
});
