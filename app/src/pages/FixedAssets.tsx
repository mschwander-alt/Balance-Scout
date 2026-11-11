import { Fragment, useEffect, useState } from 'react';
import { bsb } from '../bridge';
import { chf } from '../format';
import { Spinner, WarnIcon, useToast } from '../components/ui';
import type { FixedAssetsDecision, FixedAssetsResult, MoveClass, ReviewDecisions } from '../../electron/shared';

const CLS: [MoveClass, string][] = [['zugang', 'Zugang'], ['abgang', 'Abgang'], ['abschreibung', 'Abschreibung'], ['umbuchung', 'Umbuchung']];
const pct = (x: number | null) => (x === null ? '–' : `${(x * 100).toFixed(1)} %`);

/** Prüfgebiet Sachanlagen: Anlagespiegel aus den Kontoblättern, Abschreibungen vs. ESTV-Normalsätze */
export function FixedAssets({ historyId, decisions, update }: { historyId: string; decisions: ReviewDecisions; update: (fn: (d: ReviewDecisions) => ReviewDecisions) => void }) {
  const toast = useToast();
  const saved = decisions.analyses?.fixedAssets;
  const [params, setParams] = useState<FixedAssetsDecision>(saved ?? { findings: [] });
  const [started, setStarted] = useState(!!saved);
  const [r, setR] = useState<FixedAssetsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [newFinding, setNewFinding] = useState('');

  useEffect(() => {
    setBusy(true);
    const t = setTimeout(() => {
      bsb().review.fixedAssets(historyId, { accounts: params.accounts, categories: params.categories, classes: params.classes }).then(setR, e => toast('error', (e as Error).message)).finally(() => setBusy(false));
    }, r ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyId, params.accounts, params.categories, params.classes]);
  useEffect(() => {
    if (started) update(d => ({ ...d, analyses: { ...d.analyses, fixedAssets: params } }));
  }, [started, params, update]);

  if (!r) return <Spinner label="Kontoblätter werden ausgewertet …" />;
  if (!r.available) return <div className="card">{r.reason} Danach die Prüfung mit „Neu prüfen …“ bzw. als neue Prüfung starten.</div>;
  const selected = params.accounts ?? r.candidates.filter(c => c.inLedger).map(c => c.accountNumber);
  const start = () => {
    setStarted(true);
    if (!params.findings.length) setParams(p => ({ ...p, findings: r.suggestions.map(text => ({ text, status: 'offen' as const })) }));
  };
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="card setup-card">
        <div className="small muted">Anlagekonten (aus Saldobilanz und Kontoblättern vorgeschlagen)</div>
        <div className="acc-chips">
          {r.candidates.map(c => (
            <label key={c.accountNumber} className={`pick-line ${c.inLedger ? '' : 'muted'}`} title={c.inLedger ? '' : 'Kein Kontoblatt zu diesem Konto'}>
              <input type="checkbox" disabled={!c.inLedger} checked={selected.includes(c.accountNumber)} onChange={e => setParams(p => ({ ...p, accounts: e.target.checked ? [...selected, c.accountNumber] : selected.filter(x => x !== c.accountNumber) }))} />
              <span>{c.accountNumber} {c.accountName}{c.wbFor && <span className="small muted"> · Wertberichtigung zu {c.wbFor}</span>}</span><span className="small muted">CHF {chf(c.balance)}</span>
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="small muted">Zugänge, Abgänge und Abschreibungen werden aus Gegenkonto bzw. Buchungstext abgeleitet und sind je Buchung korrigierbar. Wertberichtigungskonten (indirekte Abschreibung) werden mit dem Anlagekonto zusammengefasst.</span>
          <span className="ml-auto" />
          {busy && <Spinner />}
          {!started ? <button className="btn btn-primary" disabled={!selected.length} onClick={start}>Anlagespiegel erstellen</button> : (
            <>
              <button className="link small" onClick={() => { setStarted(false); update(d => { const { fixedAssets: _x, ...rest } = d.analyses ?? {}; return { ...d, analyses: rest }; }); }}>Analyse verwerfen</button>
              <button className="btn" onClick={async () => { const f = await bsb().review.exportFixedAssets(historyId, params, 'Analyse_Anlagespiegel.xlsx'); if (f) toast('ok', 'Anlagespiegel gespeichert.'); }}>Excel herunterladen</button>
            </>
          )}
        </div>
      </div>

      {started && (
        <>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="grid clickable anlagen">
              <thead><tr><th>Konto</th><th>Bezeichnung</th><th className="num">Anfangsbestand</th><th className="num">Zugänge</th><th className="num">Abgänge</th><th className="num">Abschreibungen</th><th className="num">Endbestand</th><th>Kategorie (ESTV)</th><th className="num">ESTV</th><th className="num">effektiv</th></tr></thead>
              <tbody>
                {r.rows.map(x => {
                  const over = x.flags.some(f => /über dem ESTV-Normalsatz/.test(f));
                  return (
                    <Fragment key={x.accountNumber}>
                      <tr data-anlage={x.accountNumber} className={open === x.accountNumber ? 'selected' : ''} onClick={() => setOpen(open === x.accountNumber ? null : x.accountNumber)}>
                        <td>{x.accountNumber}{x.wbAccount && <div className="fx-sub" title="Wertberichtigungskonto (indirekte Abschreibung)">+ {x.wbAccount} WB</div>}</td>
                        <td title={x.accountName}>{x.accountName}{x.flags.length > 0 && <WarnIcon text={x.flags.join('\n')} />}</td>
                        <td className="num">{chf(x.opening)}</td>
                        <td className="num">{x.additions ? chf(x.additions) : '–'}</td>
                        <td className="num">{x.disposals ? chf(-x.disposals) : '–'}</td>
                        <td className="num">{x.depreciation ? chf(-x.depreciation) : '–'}</td>
                        <td className="num">{chf(x.closing)}{x.tbDiff ? <div className="fx-sub warn">SaBi Δ {chf(x.tbDiff)}</div> : null}</td>
                        <td onClick={e => e.stopPropagation()}>
                          <select className="assign" value={x.category ?? ''} onChange={e => setParams(p => ({ ...p, categories: { ...p.categories, [x.accountNumber]: e.target.value } }))}>
                            <option value="">– wählen –</option>
                            {r.categories.map(c => <option key={c.key} value={c.key}>{c.label} ({c.rate} %)</option>)}
                          </select>
                        </td>
                        <td className="num">{x.estvRate === null ? '–' : `${x.estvRate} %`}</td>
                        <td className={`num ${over ? 'delta-big' : ''}`} title={x.linearRate !== null ? 'Satz vom Buchwert (degressiv) bzw. vom Anschaffungswert (linear, ESTV halber Satz)' : 'Satz vom Buchwert (degressiv)'}>{pct(x.effectiveRate)}{x.linearRate !== null && <div className="fx-sub">AW {pct(x.linearRate)}</div>}</td>
                      </tr>
                      {open === x.accountNumber && (
                        <tr className="sub-row"><td colSpan={10}>
                          {x.flags.length > 0 && <div className="problem" style={{ marginBottom: 6 }}><ul>{x.flags.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
                          {x.wbAccount && (
                            <table className="grid small brutto" style={{ marginBottom: 8 }}>
                              <thead><tr><th /><th className="num">Anfang</th><th className="num">Zugänge</th><th className="num">Abgänge</th><th className="num">Abschreibungen</th><th className="num">Übrige</th><th className="num">Ende</th></tr></thead>
                              <tbody>
                                <tr><td>Anschaffungswerte ({x.accountNumber})</td><td className="num">{chf(x.awOpening)}</td><td className="num">{chf(x.awAdditions)}</td><td className="num">{chf(-x.awDisposals)}</td><td className="num">–</td><td className="num">{chf(x.awTransfers)}</td><td className="num">{chf(x.awClosing)}</td></tr>
                                <tr><td>Kum. Abschreibungen ({x.wbAccount})</td><td className="num">{chf(x.kumOpening)}</td><td className="num">–</td><td className="num">{chf(x.kumDisposals)}</td><td className="num">{chf(-x.depreciation)}</td><td className="num">{chf(x.kumOther)}</td><td className="num">{chf(x.kumClosing)}</td></tr>
                                <tr className="total-row"><td>Buchwert</td><td className="num">{chf(x.opening)}</td><td className="num">{chf(x.additions)}</td><td className="num">{chf(-x.disposals)}</td><td className="num">{chf(-x.depreciation)}</td><td className="num">{chf(x.transfers)}</td><td className="num">{chf(x.closing)}</td></tr>
                              </tbody>
                            </table>
                          )}
                          <table className="grid small">
                            <thead><tr>{x.wbAccount && <th>Konto</th>}<th>Datum</th><th>Text</th><th>Gegenkonto</th><th className="num">Betrag</th><th>Klassierung</th></tr></thead>
                            <tbody>
                              {x.postings.map(pz => (
                                <tr key={pz.key}>
                                  {x.wbAccount && <td>{pz.key.split('|')[0]}</td>}
                                  <td>{pz.date.split('-').reverse().join('.')}</td><td title={pz.why}>{pz.text}</td><td>{pz.contra ?? ''}</td>
                                  <td className="num">{chf(pz.amount)}</td>
                                  <td>
                                    <select className="assign" value={pz.cls} onChange={e => setParams(p => ({ ...p, classes: { ...p.classes, [pz.key]: e.target.value as MoveClass } }))}>
                                      {CLS.map(([k, l]) => <option key={k} value={k}>{l}{k === pz.auto ? ' (Vorschlag)' : ''}</option>)}
                                    </select>
                                    {pz.cls !== pz.auto && <span className="manual"> ✓ manuell</span>}
                                  </td>
                                </tr>
                              ))}
                              {!x.postings.length && <tr><td colSpan={6} className="muted">Keine Buchungen im Geschäftsjahr.</td></tr>}
                            </tbody>
                          </table>
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
                <tr className="total-row">
                  <td colSpan={2}>Total</td>
                  <td className="num">{chf(r.totals.opening)}</td><td className="num">{chf(r.totals.additions)}</td><td className="num">{chf(-r.totals.disposals)}</td>
                  <td className="num">{chf(-r.totals.depreciation)}</td><td className="num">{chf(r.totals.closing)}</td><td colSpan={3} />
                </tr>
              </tbody>
            </table>
          </div>
          {r.expense && (
            <div className="card small expense-check" data-expense-diff={r.expense.diff}>
              <strong>Abstimmung Abschreibungen ↔ Aufwand:</strong> Anlagespiegel CHF {chf(r.totals.depreciation)} · Saldobilanz CHF {chf(r.expense.total)} ({r.expense.accounts.map(a => a.accountNumber).join(', ')}) · {Math.abs(r.expense.diff) > 100 ? <span className="delta-big">Differenz CHF {chf(r.expense.diff)}</span> : <span className="ok-text">✓ stimmt überein</span>}
            </div>
          )}
          <p className="small muted">ESTV-Normalsätze gemäss Merkblatt A 1995 (degressiv vom Buchwert; linear vom Anschaffungswert = halber Satz). Effektiver Satz = Abschreibung / (Anfangsbestand + Zugänge − Abgänge); bei indirekter Abschreibung zusätzlich der Satz vom Anschaffungswert (AW).</p>

          <div className="card stack" style={{ gap: 6 }}>
            <h3>Feststellungen und Notiz</h3>
            {params.findings.map((f, i) => (
              <label key={i} className={`finding ${f.status}`}>
                <input type="checkbox" checked={f.status === 'erledigt'} onChange={e => setParams(p => ({ ...p, findings: p.findings.map((y, j) => (j === i ? { ...y, status: e.target.checked ? 'erledigt' : 'offen' } : y)) }))} />
                <span className="grow">{f.text}</span>
                <button className="icon-btn" aria-label="entfernen" onClick={e => { e.preventDefault(); setParams(p => ({ ...p, findings: p.findings.filter((_, j) => j !== i) })); }}>✕</button>
              </label>
            ))}
            <div className="row">
              <input className="grow" placeholder="Neue Feststellung" value={newFinding} onChange={e => setNewFinding(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newFinding.trim()) { setParams(p => ({ ...p, findings: [...p.findings, { text: newFinding.trim(), status: 'offen' }] })); setNewFinding(''); } }} />
              <button className="btn" disabled={!newFinding.trim()} onClick={() => { setParams(p => ({ ...p, findings: [...p.findings, { text: newFinding.trim(), status: 'offen' }] })); setNewFinding(''); }}>+ Feststellung erfassen</button>
            </div>
            <label className="field note-field"><span>Notiz zum Prüfgebiet</span>
              <textarea rows={3} value={params.note ?? ''} onChange={e => setParams(p => ({ ...p, note: e.target.value }))} placeholder="z. B. a.o. Abschreibung Betriebsgebäude gemäss VR-Beschluss vom …" />
            </label>
            <p className="small muted">Der Anlagespiegel wird beim Abschliessen als „Analyse_Anlagespiegel.xlsx“ abgelegt (mit Register, falls für Sachanlagen ein Buchstabe vergeben ist).</p>
          </div>
        </>
      )}
    </div>
  );
}
