import { Fragment, useEffect, useState } from 'react';
import { bsb } from '../bridge';
import { chf } from '../format';
import { Spinner, useToast } from '../components/ui';
import type { IncomeAccount, IncomeAmounts, IncomeAnalysis, ReviewDecisions } from '../../electron/shared';

const pct = (x: number | null) => (x === null ? '' : `${(x * 100).toFixed(1)} %`);
const dpct = (x: number | null) => (x === null ? '' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)} %`);

/**
 * Analyse der Erfolgsrechnung: Staffel nach KMU-Kontenrahmen mit Margen, Anteil am Betriebsertrag,
 * Vorjahresvergleich und Bemerkungen je Konto, Untergruppe, Gruppe oder Ergebnis.
 */
export function IncomeAnalysisView({ historyId, decisions, update, visum, closingDate }: {
  historyId: string; decisions: ReviewDecisions; update: (fn: (d: ReviewDecisions) => ReviewDecisions) => void; visum: string; closingDate: string | null;
}) {
  const toast = useToast();
  const [a, setA] = useState<IncomeAnalysis | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const notes = decisions.incomeNotes ?? {};
  const overridesKey = JSON.stringify(decisions.groupOverrides ?? {});

  useEffect(() => {
    void bsb().review.analysis(historyId, 'income', { groupOverrides: decisions.groupOverrides }).then(setA, e => toast('error', (e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyId, overridesKey, toast]);

  const setNote = (key: string, text: string) => update(d => {
    const { [key]: _old, ...rest } = d.incomeNotes ?? {};
    return { ...d, incomeNotes: text.trim() ? { ...rest, [key]: { text, at: new Date().toISOString(), visum: visum.trim() } } : rest };
  });
  const toggle = (k: string) => setOpen(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allSubs = a ? a.rows.flatMap(r => (r.kind === 'section' ? r.subs.map(s => s.key) : [])) : [];
  const exportExcel = async () => {
    const f = await bsb().review.exportAnalysis(historyId, 'income', { groupOverrides: decisions.groupOverrides, notes, visum }, 'Analyse_Erfolgsrechnung.xlsx');
    if (f) toast('ok', 'Analyse der Erfolgsrechnung gespeichert.');
  };
  if (!a) return <Spinner label="Erfolgsrechnung wird analysiert …" />;
  const year = closingDate?.slice(0, 4) ?? 'Aktuell';
  const prev = closingDate ? String(Number(closingDate.slice(0, 4)) - 1) : 'Vorjahr';
  const nNotes = Object.values(notes).filter(n => n.text.trim()).length;

  const cells = (x: IncomeAmounts) => (
    <>
      <td className="num cur">{chf(x.cy)}</td><td className="num pct">{pct(x.pctCy)}</td>
      {a.hasPreviousYear && <><td className="num">{chf(x.py ?? 0)}</td><td className="num pct">{pct(x.pctPy)}</td><td className="num">{x.diff ? chf(x.diff) : '–'}</td><td className="num pct">{dpct(x.diffPct)}</td></>}
    </>
  );
  const note = (key: string, label: string) => (
    <td className="note-cell" onClick={e => e.stopPropagation()}>
      <input className="inline-note" defaultValue={notes[key]?.text ?? ''} placeholder="Bemerkung …" aria-label={`Bemerkung ${label}`} key={`${key}:${notes[key]?.text ?? ''}`}
        onBlur={e => { if (e.target.value !== (notes[key]?.text ?? '')) setNote(key, e.target.value); }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </td>
  );
  const accountRow = (ac: IncomeAccount) => (
    <tr key={ac.key} className={`inc-account ${ac.big ? 'inc-big' : ''}`} data-inc={ac.key}>
      <td className="mono">{ac.accountNumber}</td><td title={ac.accountName}>{ac.accountName}</td>{cells(ac)}{note(ac.key, ac.accountName)}
    </tr>
  );
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row small">
        <span className="muted">Staffel nach KMU-Kontenrahmen · Ertrag positiv, Aufwand negativ · % = Anteil am Betriebsertrag{!a.hasPreviousYear && ' · Saldobilanz ohne Vorjahr'}</span>
        <span className="ml-auto" />
        <button className="link small" onClick={() => setOpen(s => (s.size ? new Set() : new Set(allSubs)))}>{open.size ? 'Konten zuklappen' : 'Alle Konten aufklappen'}</button>
        <button className="btn btn-sm" onClick={() => void exportExcel()}>Excel herunterladen</button>
      </div>
      <div className="table-wrap">
        <table className="grid income">
          <thead><tr>
            <th>Konto</th><th>Bezeichnung</th><th className="num">{year}</th><th className="num">%</th>
            {a.hasPreviousYear && <><th className="num">{prev}</th><th className="num">%</th><th className="num">Differenz</th><th className="num">Differenz %</th></>}
            <th>Bemerkungen</th>
          </tr></thead>
          <tbody>
            {a.rows.map(r => r.kind === 'result' ? (
              <tr key={r.key} className="inc-result" data-inc={r.key}><td colSpan={2}>{r.label}</td>{cells(r)}{note(r.key, r.label)}</tr>
            ) : (
              <Fragment key={r.key}>
                <tr className="inc-section" data-inc={r.key}><td colSpan={2}>{r.label}</td>{cells(r)}{note(r.key, r.label)}</tr>
                {r.subs.map(s => (
                  <Fragment key={s.key}>
                    <tr className="inc-sub clickable-row" data-inc={s.key} onClick={() => toggle(s.key)} aria-expanded={open.has(s.key)}>
                      <td><span className="caret">{open.has(s.key) ? '⌄' : '›'}</span></td><td>{s.label} <span className="muted small">({s.accounts.length})</span></td>{cells(s)}{note(s.key, s.label)}
                    </tr>
                    {open.has(s.key) && s.accounts.map(accountRow)}
                  </Fragment>
                ))}
                {r.accounts.map(accountRow)}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Gliederung: Gruppe des Kontos (vom Prüfer verschobene Konten berücksichtigt), innerhalb der Gruppe nach den ersten zwei Ziffern der Kontonummer.
        Auffällige Veränderungen (≥ 25 % und ≥ CHF 1'000) sind markiert. {nNotes ? `${nNotes} Bemerkung${nNotes > 1 ? 'en' : ''} erfasst – ` : ''}Beim Abschliessen wird die Analyse als „Analyse_Erfolgsrechnung.xlsx“ abgelegt, sobald Bemerkungen erfasst sind.
      </p>
    </div>
  );
}
