/**
 * Anzeige-Logik der Durchsicht: wendet die Entscheide der Prüferin / des Prüfers auf das
 * Analyse-Ergebnis an (gleiche Regeln wie die Engine beim Abschluss).
 */
import type { ReviewDecisions } from '../electron/shared';
import type { AccountRow, AuditResult, AutoGroup, DocRow, Status } from './types';

/** Zuordnung „Allgemeine Prüfungen“ (Register A) für Belege ohne Konto */
export const GENERAL_ACCOUNT = '@allgemein';
/** Konten einer manuellen Zuordnung (ein Beleg kann mehrere Konten belegen) */
export const targetsOf = (x: { accountNumber: string | null; accountNumbers?: string[] }) =>
  x.accountNumbers?.length ? x.accountNumbers : x.accountNumber ? [x.accountNumber] : [];
export const accountLabel = (n: string) => (n === GENERAL_ACCOUNT ? 'Allgemeine Prüfungen' : `Konto ${n}`);

export type Manual = 'akzeptiert' | 'zugeordnet' | null;
export interface ViewAccount extends AccountRow {
  autoStatus: Status;
  manual: Manual;
  /** Beleg (docId), der für das Konto massgebend ist */
  docId: string | null;
}
export interface ViewDoc extends DocRow {
  accounts: string[];
  manualAssignment: boolean;
  irrelevant: boolean;
  register: string | null;
}
export interface View {
  accounts: ViewAccount[];
  docs: ViewDoc[];
  counts: Record<Status, number>;
  coverage: number;
  confirmedAbsTotal: number;
  inScopeAbsTotal: number;
  open: { pruefen: number; unassignedDocs: number };
}

/** Gruppe des KMU-Kontenrahmens (für das Verschieben von Konten) */
export interface GroupDef { code: string; name: string; category: string }

/**
 * Vom Prüfer verschobene Konten: neue Gruppe (gleiche Regeln wie die Engine beim Abschluss).
 * Ohne Verschiebung gilt die automatische Gruppe – auch wenn das Ergebnis bereits eine verschobene Gruppe enthält.
 */
export function regroup<T extends AccountRow>(a: T, d: ReviewDecisions, groups: GroupDef[]): T {
  const auto: AutoGroup = a.autoGroup ?? { code: a.groupCode ?? null, name: a.groupName, category: a.category, source: a.groupSource === 'manuell' ? null : a.groupSource ?? null };
  const o = d.groupOverrides?.[a.accountNumber];
  const g = o ? groups.find(x => x.code === o.groupCode) : undefined;
  if (g && g.code !== auto.code) return { ...a, groupCode: g.code, groupName: g.name, category: g.category, groupSource: 'manuell', autoGroup: auto };
  if (!a.autoGroup) return a;
  return { ...a, groupCode: auto.code, groupName: auto.name, category: auto.category, groupSource: auto.source, autoGroup: null };
}

export function deriveView(r: AuditResult, d: ReviewDecisions, groups: GroupDef[] = []): View {
  const asg = d.assignments ?? {};
  const accounts: ViewAccount[] = r.accounts.map(a0 => regroup(a0, d, groups)).map(a => ({ ...a, autoStatus: a.status, manual: null, docId: a.best && (a.status === 'BELEGT' || a.status === 'PRUEFEN') ? a.best.documentId : null }));
  const byNum = new Map(accounts.map(a => [a.accountNumber, a]));
  for (const [docId, x] of Object.entries(asg)) {
    const targets = targetsOf(x);
    // Ein vom Prüfer anders zugeordneter Beleg ist nicht mehr Fundstelle eines "Prüfen"-Kontos
    for (const a of accounts) if (a.docId === docId && !targets.includes(a.accountNumber) && a.status === 'PRUEFEN') {
      a.status = 'KEIN_NACHWEIS';
      a.docId = null;
    }
    for (const num of targets) {
      const a = byNum.get(num);
      if (!a) continue;
      if (a.status === 'BELEGT' && a.docId && a.docId !== docId) continue; // zusätzlicher Beleg
      if (a.status !== 'BELEGT') a.manual = 'zugeordnet';
      a.status = 'BELEGT';
      a.docId = docId;
    }
  }
  for (const [num] of Object.entries(d.accepted ?? {})) {
    const a = byNum.get(num);
    if (a && a.status === 'PRUEFEN') {
      a.status = 'BELEGT';
      a.manual = 'akzeptiert';
    }
  }
  const docAcc = new Map<string, string[]>();
  for (const a of accounts) if (a.docId && (a.status === 'BELEGT' || a.status === 'PRUEFEN')) docAcc.set(a.docId, [...(docAcc.get(a.docId) ?? []), a.accountNumber]);
  for (const [docId, x] of Object.entries(asg)) docAcc.set(docId, targetsOf(x));
  const docs: ViewDoc[] = r.documents.map(doc => {
    const acc = docAcc.get(doc.id) ?? [];
    return { ...doc, accounts: acc, assigned: acc.length > 0, manualAssignment: !!asg[doc.id], irrelevant: !!asg[doc.id] && targetsOf(asg[doc.id]!).length === 0, register: null };
  });
  // Register: Buchstabe der Gruppe des kleinsten Kontos + laufende Nummer (Reihenfolge: Konto, Dateiname)
  const letters = d.groupLetters ?? {};
  const groupOf = new Map(accounts.map(a => [a.accountNumber, a.groupCode ?? null]));
  const items: { doc: ViewDoc; letter: string; key: string }[] = [];
  for (const doc of docs) {
    if (!doc.assigned) continue;
    const acc = [...doc.accounts].sort((x, y) => x.localeCompare(y, 'de', { numeric: true }))[0]!;
    const g = acc === GENERAL_ACCOUNT ? 'ALLG' : groupOf.get(acc);
    const letter = (g && letters[g]?.trim()) || '';
    if (letter) items.push({ doc, letter, key: `${acc.padStart(12, '0')} ${doc.filename.toLowerCase()}` });
  }
  const byLetter = new Map<string, typeof items>();
  for (const it of items) byLetter.set(it.letter, [...(byLetter.get(it.letter) ?? []), it]);
  for (const [letter, list] of byLetter) {
    list.sort((x, y) => x.key.localeCompare(y.key, 'de'));
    list.forEach((it, i) => (it.doc.register = `${letter}.${i + 1}`));
  }

  const counts = { BELEGT: 0, PRUEFEN: 0, KEIN_NACHWEIS: 0, NULLSALDO: 0, NICHT_IM_UMFANG: 0 } as Record<Status, number>;
  let inScope = 0;
  let ok = 0;
  for (const a of accounts) {
    counts[a.status]++;
    if (a.status !== 'NICHT_IM_UMFANG') inScope += Math.abs(a.balance);
    if (a.status === 'BELEGT') ok += Math.abs(a.balance);
  }
  return {
    accounts, docs, counts, coverage: inScope ? ok / inScope : 0, confirmedAbsTotal: ok, inScopeAbsTotal: inScope,
    open: { pruefen: counts.PRUEFEN, unassignedDocs: docs.filter(x => !x.assigned && !x.irrelevant).length },
  };
}

/** Gruppen in Reihenfolge des KMU-Kontenrahmens mit Zwischentotal */
export function groupAccounts<T extends { groupCode?: string | null; groupName: string | null; balance: number }>(list: T[], order: string[]): { code: string; name: string; items: T[]; total: number }[] {
  const map = new Map<string, { code: string; name: string; items: T[]; total: number }>();
  for (const a of list) {
    const code = a.groupCode ?? '~';
    const g = map.get(code) ?? { code, name: a.groupName ?? 'Ohne Gruppe (nicht im KMU-Kontenrahmen)', items: [], total: 0 };
    g.items.push(a);
    g.total += a.balance;
    map.set(code, g);
  }
  const rank = (c: string) => (order.indexOf(c) < 0 ? 999 : order.indexOf(c));
  return [...map.values()].sort((x, y) => rank(x.code) - rank(y.code));
}
