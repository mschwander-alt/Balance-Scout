import { Fragment, useEffect, useState } from 'react';
import { bsb } from '../bridge';
import { chf, date } from '../format';
import { Spinner, useToast } from '../components/ui';
import type { AccrualClass, AccrualsDecision, AccrualsResult, ReviewDecisions } from '../../electron/shared';

const CLS: [AccrualClass, string][] = [['vorjahr', 'Vorjahr (Auflösung)'], ['laufend', 'laufendes Jahr (Bildung)'], ['unterjaehrig', 'unterjährig']];

/** Prüfgebiet Rechnungsabgrenzungen: Vorjahresvergleich aus den Kontoblättern (aktive und passive Abgrenzungen) */
export function Accruals({ historyId, decisions, update, closingDate, visum }: {
  historyId: string; decisions: ReviewDecisions; update: (fn: (d: ReviewDecisions) => ReviewDecisions) => void; closingDate: string | null; visum?: string;
}) {
  const toast = useToast();
  const saved = decisions.analyses?.accruals;
  const [params, setParams] = useState<AccrualsDecision>(saved ?? {});
  const [started, setStarted] = useState(!!saved);
  const [r, setR] = useState<AccrualsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const overridesKey = JSON.stringify(decisions.groupOverrides ?? {});
  useEffect(() => {
    setBusy(true);
    const t = setTimeout(() => {
      bsb().review.analysis(historyId, 'accruals', { accounts: params.accounts, classes: params.classes, groupOverrides: decisions.groupOverrides })
        .then(setR, e => toast('error', (e as Error).message)).finally(() => setBusy(false));
    }, r ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyId, params.accounts, params.classes, overridesKey]);
  useEffect(() => {
    if (started) update(d => ({ ...d, analyses: { ...d.analyses, accruals: { ...params, visum } } }));
  }, [started, params, update, visum]);

  if (!r) return <Spinner label="Kontoblätter werden ausgewertet …" />;
  if (!r.available) return <div className="card">{r.reason} Danach die Prüfung als neue Prüfung starten.</div>;
  const selected = params.accounts ?? r.candidates.filter(c => c.suggested && c.inLedger).map(c => c.accountNumber);
  const cd = date(closingDate);
  const pd = closingDate ? date(`${Number(closingDate.slice(0, 4)) - 1}${closingDate.slice(4)}`) : 'Vorjahr';
  const exportExcel = async () => {
    const f = await bsb().review.exportAnalysis(historyId, 'accruals', { ...params, groupOverrides: decisions.groupOverrides, visum }, 'Analyse_Rechnungsabgrenzungen.xlsx');
    if (f) toast('ok', 'Vorjahresvergleich gespeichert.');
  };
  const setNote = (key: string, text: string) => setParams(p => {
    const { [key]: _x, ...rest } = p.notes ?? {};
    return { ...p, notes: text.trim() ? { ...rest, [key]: { text } } : rest };
  });
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="card setup-card">
        <div className="small muted">Abgrenzungskonten (aktive und passive Rechnungsabgrenzungen, aus Saldobilanz und Kontoblättern vorgeschlagen)</div>
        <div className="acc-chips">
          {r.candidates.map(c => (
            <label key={c.accountNumber} className={`pick-line ${c.inLedger ? '' : 'muted'}`} title={c.inLedger ? '' : 'Kein Kontoblatt zu diesem Konto'}>
              <input type="checkbox" disabled={!c.inLedger} checked={selected.includes(c.accountNumber)} onChange={e => setParams(p => ({ ...p, accounts: e.target.checked ? [...selected, c.accountNumber] : selected.filter(x => x !== c.accountNumber) }))} />
              <span>{c.accountNumber} {c.accountName} <span className="small muted">({c.side})</span></span><span className="small muted">CHF {chf(Math.abs(c.balance))}</span>
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="small muted">Vorjahr = Auflösungen zu Beginn der Periode (bis das Konto auf null steht), laufendes Jahr = Bildung Ende Jahr. Positionen werden über Gegenkonto und Text zugeordnet; jede Buchung ist umklassierbar.</span>
          <span className="ml-auto" />
          {busy && <Spinner />}
          {started && <button className="link small" onClick={() => { setStarted(false); update(d => { const { accruals: _x, ...rest } = d.analyses ?? {}; return { ...d, analyses: rest }; }); }}>Analyse verwerfen</button>}
          <button className="btn" disabled={!selected.length} onClick={() => void exportExcel()}>Excel herunterladen</button>
          {!started && <button className="btn btn-primary" disabled={!selected.length} onClick={() => setStarted(true)}>Vorjahresvergleich erstellen</button>}
        </div>
      </div>

      {started && r.accounts.map(a => (
        <div key={a.accountNumber} className="card" style={{ padding: 0 }} data-abgrenzung={a.accountNumber}>
          <div className="row cust-head"><h3>{a.side === 'aktiv' ? 'Transitorische Aktiven' : 'Transitorische Passiven'} – {a.accountNumber} {a.accountName}</h3>
            <span className="small muted">{a.positions.length} Positionen{a.intraYear ? ` · ${a.intraYear} unterjährige Buchungen` : ''}</span>
            <span className="ml-auto" />
            <button className="link small" onClick={() => setOpen(open === a.accountNumber ? null : a.accountNumber)}>{open === a.accountNumber ? 'Buchungen ausblenden' : `Buchungen (${a.postings.length})`}</button>
          </div>
          {a.flags.length > 0 && <div className="problem" style={{ margin: '0 12px 8px' }}><ul>{a.flags.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
          <table className="grid accruals">
            <thead><tr><th>Position</th><th>Konto</th><th className="num">{cd}</th><th className="num">{pd}</th><th className="num">Veränderung</th><th>Bemerkung</th></tr></thead>
            <tbody>
              {a.positions.map(x => {
                const nk = `${a.accountNumber}|${x.key}`;
                return (
                  <tr key={x.key} className={x.status !== 'beide' ? `acr-${x.status}` : ''}>
                    <td title={x.label}>{x.label}{x.status !== 'beide' && <span className={`flag ${x.status === 'neu' ? 'note' : ''}`} style={{ marginLeft: 6 }}>{x.status}</span>}</td>
                    <td className="mono">{x.contra ?? ''}</td>
                    <td className="num cur">{x.cy ? chf(x.cy) : '–'}</td><td className="num">{x.py ? chf(x.py) : '–'}</td>
                    <td className={`num ${x.py && Math.abs(x.diff) >= 100_000 && Math.abs(x.diff / x.py) >= 0.25 ? 'delta-big' : ''}`}>{x.diff ? chf(x.diff) : '–'}</td>
                    <td className="note-cell">
                      <input className="inline-note" defaultValue={params.notes?.[nk]?.text ?? ''} placeholder="Bemerkung …" aria-label={`Bemerkung ${x.label}`}
                        onBlur={e => { if (e.target.value !== (params.notes?.[nk]?.text ?? '')) setNote(nk, e.target.value); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                    </td>
                  </tr>
                );
              })}
              {(a.unexplained.cy !== 0 || a.unexplained.py !== 0) && (
                <tr className="acr-unexplained"><td colSpan={2}>nicht aufgeschlüsselt (Differenz zum Saldo – Klassierung prüfen)</td><td className="num">{chf(a.unexplained.cy)}</td><td className="num">{chf(a.unexplained.py)}</td><td className="num">{chf(a.unexplained.cy - a.unexplained.py)}</td><td /></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="total-row"><td colSpan={2}>Total (= Saldo){a.tbBalance !== null && Math.abs(a.tbBalance - a.closing) > 1 ? <span className="flag" style={{ marginLeft: 6 }}>Saldobilanz {chf(a.tbBalance)}</span> : null}</td><td className="num">{chf(a.closing)}</td><td className="num">{chf(a.opening)}</td><td className="num">{chf(a.closing - a.opening)}</td><td /></tr>
            </tfoot>
          </table>
          {open === a.accountNumber && (
            <table className="grid small" style={{ borderTop: '1px solid var(--line)' }}>
              <thead><tr><th>Datum</th><th>Text</th><th>Gegenkonto</th><th className="num">Betrag</th><th>Klassierung</th></tr></thead>
              <tbody>
                {a.postings.map(pz => (
                  <Fragment key={pz.key}>
                    <tr>
                      <td>{date(pz.date)}</td><td title={pz.why}>{pz.text}</td><td>{pz.contra ?? ''}</td><td className="num">{chf(pz.amount)}</td>
                      <td>
                        <select className="assign" value={pz.cls} aria-label={`Klassierung ${pz.text}`} onChange={e => setParams(p => ({ ...p, classes: { ...p.classes, [pz.key]: e.target.value as AccrualClass } }))}>
                          {CLS.map(([k, l]) => <option key={k} value={k}>{l}{k === pz.auto ? ' (Vorschlag)' : ''}</option>)}
                        </select>
                        {pz.cls !== pz.auto && <span className="manual"> ✓ manuell</span>}
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {started && r.suggestions.length > 0 && (
        <div className="card stack" style={{ gap: 6 }}>
          <h3>Feststellungen und nächste Schritte</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{r.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul>
          <label className="field note-field"><span>Notiz zum Prüfgebiet</span>
            <textarea rows={3} value={params.note ?? ''} onChange={e => setParams(p => ({ ...p, note: e.target.value }))} placeholder="z. B. Abgrenzungen mit Verträgen und Rechnungen abgestimmt" />
          </label>
          <p className="small muted">Der Vergleich wird beim Abschliessen als „Analyse_Rechnungsabgrenzungen.xlsx“ abgelegt.</p>
        </div>
      )}
    </div>
  );
}
