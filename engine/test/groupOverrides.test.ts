import { describe, it, expect } from 'vitest';
import { applyGroupOverrides, KMU_GROUPS, type Category } from '../src/domain/trialBalance/accountGroups.js';

const acc = (accountNumber: string, groupCode: string | null, groupSource: 'nummer' | 'bezeichnung' | null = 'nummer') => {
  const g = KMU_GROUPS.find(x => x.code === groupCode);
  return { accountNumber, accountName: `Konto ${accountNumber}`, groupCode, groupName: g?.name ?? null, category: (g?.category ?? 'unbekannt') as Category, groupSource: groupCode ? groupSource : null };
};

describe('applyGroupOverrides – Konto vom Prüfer in eine andere Gruppe verschoben', () => {
  it('Konto ohne Gruppe wird einer Gruppe zugeordnet (Name und Kategorie aus dem Kontenrahmen)', () => {
    const [a] = applyGroupOverrides([acc('2161', null)], { '2161': { groupCode: 'P13' } });
    const p13 = KMU_GROUPS.find(x => x.code === 'P13')!;
    expect(a).toMatchObject({ groupCode: 'P13', groupName: p13.name, category: 'passiven', groupSource: 'manuell', autoGroup: { code: null, name: null, category: 'unbekannt', source: null } });
  });

  it('ohne Verschiebung bleibt das Konto unverändert (gleiches Objekt)', () => {
    const list = [acc('1000', 'A10')];
    expect(applyGroupOverrides(list, undefined)[0]).toBe(list[0]);
    expect(applyGroupOverrides(list, { '9999': { groupCode: 'A12' } })[0]).toBe(list[0]);
  });

  it('unbekannte Zielgruppe wird ignoriert', () => {
    expect(applyGroupOverrides([acc('1000', 'A10')], { '1000': { groupCode: 'XYZ' } })[0]).toMatchObject({ groupCode: 'A10', groupSource: 'nummer' });
  });

  it('Verschiebung in die automatische Gruppe = keine Verschiebung', () => {
    const [a] = applyGroupOverrides([acc('1000', 'A10')], { '1000': { groupCode: 'A10' } });
    expect(a).toMatchObject({ groupCode: 'A10', groupSource: 'nummer' });
    expect(a!.autoGroup).toBeUndefined();
  });

  it('zweimal anwenden ist stabil; aufgehoben → automatische Gruppe inkl. Herkunft', () => {
    const once = applyGroupOverrides([acc('2030', 'P10', 'bezeichnung')], { '2030': { groupCode: 'P13' } });
    const twice = applyGroupOverrides(once, { '2030': { groupCode: 'P13' } });
    expect(twice[0]).toEqual(once[0]);
    const moved = applyGroupOverrides(once, { '2030': { groupCode: 'P11' } });
    expect(moved[0]).toMatchObject({ groupCode: 'P11', autoGroup: { code: 'P10', source: 'bezeichnung' } });
    const back = applyGroupOverrides(moved, {});
    expect(back[0]).toEqual(acc('2030', 'P10', 'bezeichnung'));
  });

  it('Verschiebung zwischen Bilanz und Erfolgsrechnung ändert die Kategorie', () => {
    const er = KMU_GROUPS.find(x => x.category === 'aufwand')!;
    expect(applyGroupOverrides([acc('1000', 'A10')], { '1000': { groupCode: er.code } })[0]!.category).toBe('aufwand');
  });
});
