import { Fragment, useEffect, useState } from 'react';
import { accrualsAuto, type AutoResults } from '../procedureAuto';
import { bsb } from '../bridge';
import { chf, date, parseChf } from '../format';
import { AutoTextarea, Spinner, useToast } from '../components/ui';
import type { AccrualAccount, AccrualAttachment, AccrualClass, AccrualPosition, AccrualsDecision, AccrualsResult, ReviewDecisions } from '../../electron/shared';

const CLS: [AccrualClass, string][] = [['vorjahr', 'Vorjahr (Auflösung)'], ['laufend', 'laufendes Jahr (Bildung)'], ['unterjaehrig', 'unterjährig']];
const uid = () => Math.random().toString(36).slice(2, 10);
const amountText = (c: number) => (c / 100).toFixed(2);

/**
 * Prüfgebiet Rechnungsabgrenzungen: Vorjahresvergleich aus den Kontoblättern (aktive und passive Abgrenzungen),
 * mit manuellen Positionen, Korrekturen und angehängten Belegen (beim Abschluss <Buchstabe>.100.1, .100.2 …).
 */
export function Accruals({ historyId, decisions, update, closingDate, visum, side, refLetter = '', onSummary }: {
  historyId: string; decisions: ReviewDecisions; update: (fn: (d: ReviewDecisions) => ReviewDecisions) => void; closingDate: string | null; visum?: string;
  /** Ergebnis für die Prüfungshandlungen der aktiven bzw. passiven Abgrenzungen */
  side?: 'aktiv' | 'passiv'; refLetter?: string; onSummary?: (s: AutoResults) => void;
}) {
  const toast = useToast();
  const saved = decisions.analyses?.accruals;
  const [params, setParams] = useState<AccrualsDecision>(saved ?? {});
  const [started, setStarted] = useState(!!saved);
  const [r, setR] = useState<AccrualsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const overridesKey = JSON.stringify(decisions.groupOverrides ?? {});
  useEffect(() => { if (r && started && side && onSummary) onSummary(accrualsAuto(r, refLetter ? `${refLetter}.100` : '', side)); }, [r, started, side, refLetter, onSummary]);
  const calcKey = JSON.stringify([params.accounts, params.classes, params.manual, params.edits]);
  useEffect(() => {
    setBusy(true);
    const t = setTimeout(() => {
      bsb().review.analysis(historyId, 'accruals', { accounts: params.accounts, classes: params.classes, manual: params.manual, edits: params.edits, groupOverrides: decisions.groupOverrides })
        .then(setR, e => toast('error', (e as Error).message)).finally(() => setBusy(false));
    }, r ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyId, calcKey, overridesKey]);
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
  // Anhänge: Dateien wählen bzw. hineinziehen (je Konto oder Position)
  const attach = (account: string, position: string | null, files: { path: string; name: string }[]) => {
    if (!files.length) return;
    setParams(p => ({ ...p, attachments: [...(p.attachments ?? []), ...files.map(f => ({ id: uid(), name: f.name, path: f.path, account, position }))] }));
    toast('ok', `${files.length} Datei${files.length > 1 ? 'en' : ''} angehängt – beim Abschliessen als Beilage zur Aufstellung abgelegt.`);
  };
  const pickFiles = async (account: string, position: string | null) => {
    const files = (await bsb().pick.evidence('files')).filter(f => !f.isDirectory);
    attach(account, position, files);
  };
  const dropFiles = async (e: React.DragEvent, account: string, position: string | null) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); e.stopPropagation();
    const picked = await Promise.all([...e.dataTransfer.files].map(f => bsb().pick.pathOf(f)));
    attach(account, position, picked.filter((x): x is NonNullable<typeof x> => !!x && !x.isDirectory));
  };
  const removeAttachment = (id: string) => setParams(p => ({ ...p, attachments: (p.attachments ?? []).filter(a => a.id !== id) }));
  const attachmentsOf = (account: string, position: string | null) => (params.attachments ?? []).filter(a => a.account === account && (a.position ?? null) === position);

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
          <span className="small muted">Vorjahr = Auflösungen zu Beginn der Periode, laufendes Jahr = Bildung Ende Jahr. Positionen lassen sich korrigieren (✎), ergänzen (+ Position) und mit Belegen versehen (📎 oder Datei auf die Zeile ziehen).</span>
          <span className="ml-auto" />
          {busy && <Spinner />}
          {started && <button className="link small" onClick={() => { setStarted(false); update(d => { const { accruals: _x, ...rest } = d.analyses ?? {}; return { ...d, analyses: rest }; }); }}>Analyse verwerfen</button>}
          <button className="btn" disabled={!selected.length} onClick={() => void exportExcel()}>Excel herunterladen</button>
          {!started && <button className="btn btn-primary" disabled={!selected.length} onClick={() => setStarted(true)}>Vorjahresvergleich erstellen</button>}
        </div>
      </div>

      {started && r.accounts.map(a => (
        <AccountCard key={a.accountNumber} a={a} cd={cd} pd={pd} params={params} setParams={setParams} open={open === a.accountNumber}
          onToggle={() => setOpen(open === a.accountNumber ? null : a.accountNumber)} setNote={setNote}
          attachmentsOf={attachmentsOf} pickFiles={pickFiles} dropFiles={dropFiles} removeAttachment={removeAttachment} />
      ))}
      {started && (
        <div className="card stack" style={{ gap: 6 }}>
          <h3>Feststellungen und nächste Schritte</h3>
          {r.suggestions.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{r.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul>}
          <label className="field note-field"><span>Notiz zum Prüfgebiet</span>
            <AutoTextarea minRows={3} value={params.note ?? ''} onChange={e => setParams(p => ({ ...p, note: e.target.value }))} placeholder="z. B. Abgrenzungen mit Verträgen und Rechnungen abgestimmt" />
          </label>
          <p className="small muted">Beim Abschliessen wird die Aufstellung als „&lt;Buchstabe&gt;.100_Analyse_Rechnungsabgrenzungen.xlsx“ abgelegt, angehängte Dateien als „&lt;Buchstabe&gt;.100.1_…“, „.100.2_…“ (im Excel bei der Position vermerkt).</p>
        </div>
      )}
    </div>
  );
}

function AccountCard({ a, cd, pd, params, setParams, open, onToggle, setNote, attachmentsOf, pickFiles, dropFiles, removeAttachment }: {
  a: AccrualAccount; cd: string; pd: string; params: AccrualsDecision; setParams: (fn: (p: AccrualsDecision) => AccrualsDecision) => void;
  open: boolean; onToggle: () => void; setNote: (key: string, text: string) => void;
  attachmentsOf: (account: string, position: string | null) => AccrualAttachment[];
  pickFiles: (account: string, position: string | null) => Promise<void>;
  dropFiles: (e: React.DragEvent, account: string, position: string | null) => Promise<void>;
  removeAttachment: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ label: '', contra: '', cy: '', py: '' });
  const [neu, setNeu] = useState({ label: '', contra: '', cy: '', py: '' });
  const num = a.accountNumber;
  const startEdit = (x: AccrualPosition) => { setEditing(x.key); setForm({ label: x.label, contra: x.contra ?? '', cy: amountText(x.cy), py: amountText(x.py) }); };
  const saveEdit = (x: AccrualPosition) => {
    const cy = parseChf(form.cy), py = parseChf(form.py);
    if (cy === null || py === null) return;
    if (x.status === 'manuell') {
      const id = x.key.slice(2);
      setParams(p => ({ ...p, manual: { ...p.manual, [num]: (p.manual?.[num] ?? []).map(m => (m.id === id ? { ...m, label: form.label.trim() || m.label, contra: form.contra.trim() || null, cy, py } : m)) } }));
    } else {
      setParams(p => ({ ...p, edits: { ...p.edits, [`${num}|${x.key}`]: { label: form.label.trim(), cy, py } } }));
    }
    setEditing(null);
  };
  const resetEdit = (x: AccrualPosition) => setParams(p => { const { [`${num}|${x.key}`]: _x, ...rest } = p.edits ?? {}; return { ...p, edits: rest }; });
  const removeManual = (x: AccrualPosition) => setParams(p => ({ ...p, manual: { ...p.manual, [num]: (p.manual?.[num] ?? []).filter(m => `M:${m.id}` !== x.key) } }));
  const addManual = () => {
    const cy = parseChf(neu.cy || '0'), py = parseChf(neu.py || '0');
    if (!neu.label.trim() || cy === null || py === null) return;
    setParams(p => ({ ...p, manual: { ...p.manual, [num]: [...(p.manual?.[num] ?? []), { id: uid(), label: neu.label.trim(), contra: neu.contra.trim() || null, cy, py }] } }));
    setNeu({ label: '', contra: '', cy: '', py: '' });
  };
  const files = (position: string | null) => attachmentsOf(num, position);
  const fileList = (list: AccrualAttachment[]) => list.length > 0 && (
    <div className="att-list">{list.map(f => (
      <span key={f.id} className="att"><button className="link small" title={f.path} onClick={() => void bsb().app.openPath(f.path)}>📎 {f.name}</button><button className="icon-btn" aria-label={`Anhang ${f.name} entfernen`} onClick={() => removeAttachment(f.id)}>✕</button></span>
    ))}</div>
  );
  return (
    <div className="card" style={{ padding: 0 }} data-abgrenzung={num} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => void dropFiles(e, num, null)}>
      <div className="row cust-head"><h3>{a.side === 'aktiv' ? 'Transitorische Aktiven' : 'Transitorische Passiven'} – {num} {a.accountName}</h3>
        <span className="small muted">{a.positions.length} Positionen{a.intraYear ? ` · ${a.intraYear} unterjährige Buchungen` : ''}</span>
        <span className="ml-auto" />
        <button className="link small" onClick={() => void pickFiles(num, null)}>📎 Datei zum Konto anhängen</button>
        <button className="link small" onClick={onToggle}>{open ? 'Buchungen ausblenden' : `Buchungen (${a.postings.length})`}</button>
      </div>
      {files(null).length > 0 && <div style={{ padding: '0 12px 6px' }}>{fileList(files(null))}</div>}
      {a.flags.length > 0 && <div className="problem" style={{ margin: '0 12px 8px' }}><ul>{a.flags.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
      <table className="grid accruals">
        <thead><tr><th>Position</th><th>Konto</th><th className="num">{cd}</th><th className="num">{pd}</th><th className="num">Veränderung</th><th>Bemerkung</th><th /></tr></thead>
        <tbody>
          {a.positions.map(x => {
            const nk = `${num}|${x.key}`;
            if (editing === x.key) return (
              <tr key={x.key} className="acr-edit">
                <td><input aria-label="Bezeichnung" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} /></td>
                <td><input className="w-sm" aria-label="Gegenkonto" value={form.contra} disabled={x.status !== 'manuell'} onChange={e => setForm(f => ({ ...f, contra: e.target.value }))} /></td>
                <td className="num"><input className="w-sm num" aria-label="Betrag laufendes Jahr" value={form.cy} onChange={e => setForm(f => ({ ...f, cy: e.target.value }))} /></td>
                <td className="num"><input className="w-sm num" aria-label="Betrag Vorjahr" value={form.py} onChange={e => setForm(f => ({ ...f, py: e.target.value }))} /></td>
                <td colSpan={3}><button className="btn btn-sm btn-primary" disabled={parseChf(form.cy) === null || parseChf(form.py) === null} onClick={() => saveEdit(x)}>Übernehmen</button> <button className="btn btn-sm" onClick={() => setEditing(null)}>Abbrechen</button></td>
              </tr>
            );
            return (
              <tr key={x.key} className={`${x.status !== 'beide' ? `acr-${x.status}` : ''} ${x.edited ? 'acr-edited' : ''}`}
                onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => void dropFiles(e, num, x.key)}>
                <td title={x.label}>{x.label}
                  {x.status !== 'beide' && <span className={`flag ${x.status === 'neu' || x.status === 'manuell' ? 'note' : ''}`} style={{ marginLeft: 6 }}>{x.status}</span>}
                  {x.edited && <span className="flag moved" style={{ marginLeft: 6 }}>korrigiert</span>}
                  {fileList(files(x.key))}
                </td>
                <td className="mono">{x.contra ?? ''}</td>
                <td className="num cur">{x.cy ? chf(x.cy) : '–'}</td><td className="num">{x.py ? chf(x.py) : '–'}</td>
                <td className={`num ${x.py && Math.abs(x.diff) >= 100_000 && Math.abs(x.diff / x.py) >= 0.25 ? 'delta-big' : ''}`}>{x.diff ? chf(x.diff) : '–'}</td>
                <td className="note-cell">
                  <AutoTextarea className="inline-note" defaultValue={params.notes?.[nk]?.text ?? ''} placeholder="Bemerkung …" aria-label={`Bemerkung ${x.label}`} submitOnEnter
                    onBlur={e => { if (e.target.value !== (params.notes?.[nk]?.text ?? '')) setNote(nk, e.target.value); }} />
                </td>
                <td className="acr-actions">
                  <button className="icon-btn" title="Position korrigieren" aria-label={`Korrigieren ${x.label}`} onClick={() => startEdit(x)}>✎</button>
                  <button className="icon-btn" title="Beleg anhängen (oder Datei auf die Zeile ziehen)" aria-label={`Anhängen ${x.label}`} onClick={() => void pickFiles(num, x.key)}>📎</button>
                  {x.edited && <button className="icon-btn" title="Korrektur zurücksetzen" aria-label={`Zurücksetzen ${x.label}`} onClick={() => resetEdit(x)}>↺</button>}
                  {x.status === 'manuell' && <button className="icon-btn" title="Manuelle Position löschen" aria-label={`Löschen ${x.label}`} onClick={() => removeManual(x)}>✕</button>}
                </td>
              </tr>
            );
          })}
          {(a.unexplained.cy !== 0 || a.unexplained.py !== 0) && (
            <tr className="acr-unexplained"><td colSpan={2}>nicht aufgeschlüsselt (Differenz zum Saldo – Klassierung bzw. manuelle Positionen prüfen)</td><td className="num">{chf(a.unexplained.cy)}</td><td className="num">{chf(a.unexplained.py)}</td><td className="num">{chf(a.unexplained.cy - a.unexplained.py)}</td><td colSpan={2} /></tr>
          )}
          <tr className="acr-new">
            <td><input placeholder="+ Position hinzufügen (Bezeichnung)" aria-label={`Neue Position ${num}`} value={neu.label} onChange={e => setNeu(n => ({ ...n, label: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') addManual(); }} /></td>
            <td><input className="w-sm" placeholder="Konto" aria-label="Neue Position Gegenkonto" value={neu.contra} onChange={e => setNeu(n => ({ ...n, contra: e.target.value }))} /></td>
            <td className="num"><input className="w-sm num" placeholder="0.00" aria-label="Neue Position laufendes Jahr" value={neu.cy} onChange={e => setNeu(n => ({ ...n, cy: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') addManual(); }} /></td>
            <td className="num"><input className="w-sm num" placeholder="0.00" aria-label="Neue Position Vorjahr" value={neu.py} onChange={e => setNeu(n => ({ ...n, py: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') addManual(); }} /></td>
            <td colSpan={3}><button className="btn btn-sm" disabled={!neu.label.trim() || parseChf(neu.cy || '0') === null || parseChf(neu.py || '0') === null} onClick={addManual}>+ Hinzufügen</button></td>
          </tr>
        </tbody>
        <tfoot>
          <tr className="total-row"><td colSpan={2}>Total{a.tbBalance !== null && Math.abs(a.tbBalance - a.closing) > 1 ? <span className="flag" style={{ marginLeft: 6 }}>Saldobilanz {chf(a.tbBalance)}</span> : null}</td><td className="num">{chf(a.totals.cy + a.unexplained.cy)}</td><td className="num">{chf(a.totals.py + a.unexplained.py)}</td><td className="num">{chf(a.totals.cy + a.unexplained.cy - a.totals.py - a.unexplained.py)}</td><td colSpan={2} className="small muted">= Saldo laut Kontoblatt</td></tr>
        </tfoot>
      </table>
      {open && (
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
  );
}
