import { useEffect, useState } from 'react';
import { bsb } from '../bridge';
import { chf, dateTime } from '../format';
import { AutoTextarea, useToast } from '../components/ui';
import type { ReviewDecisions } from '../../electron/shared';
import type { ViewAccount, ViewDoc } from '../review';
import { targetsOf } from '../review';
import { Receivables, FIXED, ACCRUALS } from './AuditAreas';
import { FixedAssets } from './FixedAssets';
import { Accruals } from './Accruals';
import { IncomeAnalysisView } from './IncomeAnalysis';
import { AreaStatusControl, GroupFindings } from './GroupWorkspace';

type Group = { code: string; name: string; items: ViewAccount[] };
const DOT: Record<string, string> = { BELEGT: 'ok', PRUEFEN: 'warn', KEIN_NACHWEIS: 'bad', NULLSALDO: 'grey', NICHT_IM_UMFANG: 'grey' };
const uid = () => Math.random().toString(36).slice(2, 10);
const isER = (a: ViewAccount) => a.category === 'aufwand' || a.category === 'ertrag';

/** Eingeklappte Bilanz: schmale Kontoleiste mit Gruppen, Kontonummern und Statuspunkt */
export function FocusRail({ groups, open, setOpen, letters, onExit }: {
  groups: Group[]; open: string | null; setOpen: (n: string) => void; letters: Record<string, string>; onExit: () => void;
}) {
  return (
    <nav className="focus-rail" aria-label="Konten">
      <button className="focus-exit" onClick={onExit}>⇥ Bilanz einblenden</button>
      <div className="focus-rail-list">
        {groups.map(g => (
          <div key={g.code || 'alle'} className="rail-group">
            <div className="rail-head" title={g.name}>{letters[g.code] ? <span className="register">{letters[g.code]}</span> : null}<span>{g.name}</span></div>
            {g.items.map(a => (
              <button key={a.accountNumber} className={`rail-acc ${open === a.accountNumber ? 'active' : ''}`} onClick={() => setOpen(a.accountNumber)}
                title={`${a.accountNumber} ${a.accountName} · CHF ${chf(a.balance)}`} data-konto={a.accountNumber}>
                <span className={`dot ${DOT[a.status] ?? 'grey'}`} />{a.accountNumber}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="rail-foot small muted">↑ ↓ nächstes Konto</div>
    </nav>
  );
}

/** Linke Fläche: vertiefte Prüfung der Gruppe des Kontos, sonst Vergleich der Gruppe mit dem Vorjahr */
export function GroupAnalysis({ sel, group, historyId, decisions, update, docs, letter, rates, visum, closingDate, onMoveGroup }: {
  sel: ViewAccount; group: Group | undefined; historyId: string; decisions: ReviewDecisions; update: (fn: (d: ReviewDecisions) => ReviewDecisions) => void;
  docs: ViewDoc[]; letter: string; rates: Record<string, number>; visum: string; closingDate: string | null;
  onMoveGroup: (n: string, g: string | null, quiet?: boolean) => void;
}) {
  const code = sel.groupCode ?? '';
  const title = isER(sel) ? 'Analyse der Erfolgsrechnung' : code === 'A12' ? 'Fälligkeitsanalyse' : FIXED.includes(code) ? 'Anlagespiegel und Abschreibungen' : ACCRUALS.includes(code) ? 'Vorjahresvergleich der Abgrenzungen' : 'Vorjahresvergleich der Gruppe';
  return (
    <section className="focus-analysis" aria-label="Vertiefte Prüfung">
      <div className="focus-analysis-head">
        {letter && <span className="register">{letter}</span>}
        <strong>{group?.name ?? sel.groupName ?? 'Ohne Gruppe'}</strong>
        <span className="muted small">· {title}</span>
      </div>
      <div className="focus-analysis-body">
        {isER(sel) ? <IncomeAnalysisView historyId={historyId} decisions={decisions} update={update} visum={visum} closingDate={closingDate} onMoveGroup={onMoveGroup} />
          : code === 'A12' ? <Receivables historyId={historyId} docs={docs} decisions={decisions} update={update} letter={letter} defaultRates={rates} />
          : FIXED.includes(code) ? <FixedAssets historyId={historyId} decisions={decisions} update={update} />
          : ACCRUALS.includes(code) ? <Accruals historyId={historyId} decisions={decisions} update={update} closingDate={closingDate} visum={visum} />
          : <GroupComparison group={group} sel={sel} />}
      </div>
    </section>
  );
}

function GroupComparison({ group, sel }: { group: Group | undefined; sel: ViewAccount }) {
  const items = group?.items ?? [sel];
  const cy = items.reduce((s, a) => s + a.balance, 0);
  const py = items.reduce((s, a) => s + (a.balancePreviousYear ?? 0), 0);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="small muted">Für diese Gruppe gibt es keine eigene vertiefte Analyse – Vorjahresvergleich der Konten. Nachweise und Feststellungen unten erfassen.</p>
      <table className="grid small">
        <thead><tr><th>Konto</th><th>Bezeichnung</th><th className="num">Aktuell</th><th className="num">Vorjahr</th><th className="num">Veränderung</th><th>Status</th></tr></thead>
        <tbody>
          {items.map(a => {
            const d = a.balancePreviousYear === null ? null : a.balance - a.balancePreviousYear;
            return (
              <tr key={a.accountNumber} className={a.accountNumber === sel.accountNumber ? 'selected' : ''}>
                <td>{a.accountNumber}</td><td>{a.accountName}</td><td className="num">{chf(a.balance)}</td><td className="num">{a.balancePreviousYear === null ? '' : chf(a.balancePreviousYear)}</td>
                <td className="num">{d === null ? '' : chf(d)}</td><td>{a.status === 'BELEGT' ? 'Belegt' : a.status === 'PRUEFEN' ? 'Prüfen' : a.status === 'KEIN_NACHWEIS' ? 'Kein Nachweis' : 'Nullsaldo'}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr className="total-row"><td colSpan={2}>Total</td><td className="num">{chf(cy)}</td><td className="num">{chf(py)}</td><td className="num">{chf(cy - py)}</td><td /></tr></tfoot>
      </table>
    </div>
  );
}

type BottomTab = 'kommentar' | 'dateien' | 'verlauf';

/** Unten: Notiz zum Konto, Feststellungen der Gruppe, Nachweise & Dateien (Upload), Verlauf */
export function FocusBottom({ sel, groupCode, letter, decisions, update, docs, visum, onNote, onAddEvidence }: {
  sel: ViewAccount; groupCode: string; letter: string; decisions: ReviewDecisions; update: (fn: (d: ReviewDecisions) => ReviewDecisions) => void;
  docs: ViewDoc[]; visum: string; onNote: (text: string) => void; onAddEvidence: (paths: { path: string; name: string }[]) => Promise<void>;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<BottomTab>('kommentar');
  const [noteText, setNoteText] = useState(decisions.notes?.[sel.accountNumber]?.text ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setNoteText(decisions.notes?.[sel.accountNumber]?.text ?? ''), [sel.accountNumber, decisions.notes]);
  const findings = decisions.groupFindings?.[groupCode] ?? [];
  const evidence = docs.filter(d => d.accounts.includes(sel.accountNumber));
  const attachments = decisions.groupAttachments?.[groupCode] ?? [];
  const accrualAtts = ACCRUALS.includes(groupCode) ? (decisions.analyses?.accruals?.attachments ?? []).filter(f => f.account === sel.accountNumber) : [];
  const addAttachments = (files: { path: string; name: string }[]) => {
    if (!files.length) return;
    update(d => ({ ...d, groupAttachments: { ...d.groupAttachments, [groupCode]: [...(d.groupAttachments?.[groupCode] ?? []), ...files.map(f => ({ id: uid(), name: f.name, path: f.path, account: sel.accountNumber }))] } }));
    toast('ok', `${files.length} Beilage${files.length > 1 ? 'n' : ''} angehängt – beim Abschliessen ${letter ? `als ${letter}.100.n ` : ''}abgelegt.`);
  };
  const pick = async () => (await bsb().pick.evidence('files')).filter(f => !f.isDirectory).map(f => ({ path: f.path, name: f.name }));
  const dropped = async (e: React.DragEvent) => {
    e.preventDefault();
    const list = await Promise.all([...e.dataTransfer.files].map(f => bsb().pick.pathOf(f)));
    return list.filter((x): x is NonNullable<typeof x> => !!x && !x.isDirectory).map(f => ({ path: f.path, name: f.name }));
  };
  const asEvidence = async (files: { path: string; name: string }[]) => {
    if (!files.length) return;
    setBusy(true);
    try { await onAddEvidence(files); } finally { setBusy(false); }
  };
  // Verlauf: Entscheide zu Konto und Gruppe, neueste zuerst
  const events: { at: string; visum: string; text: string }[] = [];
  const acc = decisions.accepted?.[sel.accountNumber];
  if (acc) events.push({ at: acc.at, visum: acc.visum, text: 'Konto akzeptiert (Belegt)' });
  for (const [docId, x] of Object.entries(decisions.assignments ?? {})) {
    if (!targetsOf(x).includes(sel.accountNumber)) continue;
    events.push({ at: x.at, visum: x.visum, text: `Beleg ${docs.find(d => d.id === docId)?.filename ?? docId} zugeordnet` });
  }
  const n = decisions.notes?.[sel.accountNumber];
  if (n?.text) events.push({ at: n.at, visum: n.visum, text: 'Notiz erfasst' });
  const go = decisions.groupOverrides?.[sel.accountNumber];
  if (go) events.push({ at: go.at, visum: go.visum, text: `Gruppe geändert (${go.groupCode})` });
  for (const f of findings) if (f.at) events.push({ at: f.at, visum: f.visum ?? '', text: `Feststellung: ${f.text}` });
  events.sort((a, b) => b.at.localeCompare(a.at));

  return (
    <section className="focus-bottom" aria-label="Kommentare und Dateien">
      <nav className="tabs sub focus-bottom-tabs" role="tablist">
        {([['kommentar', 'Notiz & Feststellungen'], ['dateien', `Nachweise & Dateien (${evidence.length + attachments.length + accrualAtts.length})`], ['verlauf', 'Verlauf']] as [BottomTab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
        <span className="ml-auto small muted">gilt für: <strong>Konto {sel.accountNumber}</strong> · Gruppe {letter || groupCode || '–'}</span>
      </nav>
      {tab === 'kommentar' && (
        <div className="focus-bottom-grid">
          <label className="field note-field"><span>Notiz zum Konto</span>
            <AutoTextarea minRows={3} maxLength={500} value={noteText} onChange={e => setNoteText(e.target.value)} onBlur={() => noteText !== (decisions.notes?.[sel.accountNumber]?.text ?? '') && onNote(noteText)} placeholder="z. B. Saldo mit Bankbestätigung abgestimmt." aria-label="Notiz zum Konto" />
          </label>
          <div className="stack" style={{ gap: 5 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">Feststellungen der Gruppe</span>
              <AreaStatusControl compact code={groupCode} decisions={decisions} update={update} visum={visum} />
            </div>
            <GroupFindings code={groupCode} decisions={decisions} update={update} visum={visum} />
          </div>
        </div>
      )}
      {tab === 'dateien' && (
        <div className="focus-bottom-grid">
          <div className="stack" style={{ gap: 4 }}>
            {evidence.map(d => (
              <div key={d.id} className="file-line">
                <span className={`register ${d.register ? '' : 'empty'}`}>{d.register ?? '–'}</span>
                <button className="link small grow" title={d.relPath} onClick={() => void bsb().app.openPath(d.absPath)}>{d.filename}</button>
                <span className="small muted">Nachweis · {d.relPath.startsWith('Nachweise Prüfer/') ? 'hochgeladen' : 'Kunde'}</span>
              </div>
            ))}
            {[...accrualAtts.map(f => ({ ...f, kind: 'Beilage Abgrenzung' })), ...attachments.map(f => ({ ...f, kind: 'Beilage Analyse' }))].map(f => (
              <div key={f.id} className="file-line">
                <span className="register outline">{letter ? `${letter}.100` : 'Beil.'}</span>
                <button className="link small grow" title={f.path} onClick={() => void bsb().app.openPath(f.path)}>{f.name}</button>
                <span className="small muted">{f.kind}</span>
                {f.kind === 'Beilage Analyse' && <button className="icon-btn" aria-label={`Beilage ${f.name} entfernen`} onClick={() => update(d => ({ ...d, groupAttachments: { ...d.groupAttachments, [groupCode]: (d.groupAttachments?.[groupCode] ?? []).filter(x => x.id !== f.id) } }))}>✕</button>}
              </div>
            ))}
            {!evidence.length && !attachments.length && !accrualAtts.length && <p className="small muted">Noch keine Nachweise oder Beilagen.</p>}
          </div>
          <div className="drop-zones">
            <div className="drop small" onDragOver={e => e.preventDefault()} onDrop={async e => void asEvidence(await dropped(e))}>
              <strong>Nachweis zum Konto</strong><br />z. B. Bank- oder Saldobestätigung – erscheint im Belegverzeichnis, Register {letter ? `${letter}.n` : 'wie Belege'}, Konto gilt als belegt
              <div style={{ marginTop: 6 }}><button className="btn btn-sm" disabled={busy} onClick={async () => void asEvidence(await pick())}>{busy ? 'Wird gelesen …' : 'Nachweis hochladen …'}</button></div>
            </div>
            <div className="drop small" onDragOver={e => e.preventDefault()} onDrop={async e => addAttachments(await dropped(e))}>
              <strong>Beilage zur Analyse</strong><br />z. B. Vertrag, Korrespondenz – abgelegt als {letter ? `${letter}.100.n` : 'Beilage n'}
              <div style={{ marginTop: 6 }}><button className="btn btn-sm" onClick={async () => addAttachments(await pick())}>Beilage anhängen …</button></div>
            </div>
          </div>
        </div>
      )}
      {tab === 'verlauf' && (
        <ul className="history-list">
          {events.map((e, i) => <li key={i}><strong>{e.visum || '–'}</strong> · {dateTime(e.at)} · {e.text}</li>)}
          {!events.length && <li className="muted">Noch keine Entscheide zu diesem Konto.</li>}
        </ul>
      )}
    </section>
  );
}
