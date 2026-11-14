import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { bsb } from '../bridge';
import { chf, date } from '../format';
import { AutoTextarea, useToast } from '../components/ui';
import type { GroupsInfo, ProcedureDef, ProcedureState, ReviewDecisions } from '../../electron/shared';
import type { ViewAccount, ViewDoc } from '../review';
import type { AreaRow } from '../areas';
import { accountAuto, type AutoResults } from '../procedureAuto';
import { Receivables, FIXED, ACCRUALS } from './AuditAreas';
import { FixedAssets } from './FixedAssets';
import { Accruals } from './Accruals';
import { IncomeAnalysisView } from './IncomeAnalysis';

type Update = (fn: (d: ReviewDecisions) => ReviewDecisions) => void;
const uid = () => Math.random().toString(36).slice(2, 10);
const DOT: Record<string, string> = { BELEGT: 'ok', PRUEFEN: 'warn', KEIN_NACHWEIS: 'bad', NULLSALDO: 'grey', NICHT_IM_UMFANG: 'grey' };
const ANALYSIS: Record<string, string> = { A12: 'Fälligkeitsanalyse', A15: 'Abgrenzungen', P13: 'Abgrenzungen', A21: 'Anlagespiegel', A22: 'Anlagespiegel', A23: 'Anlagespiegel', ER: 'Analyse' };
const SHORT = (n: string) => n.replace(/ und nicht fakturierte Dienstleistungen| aus Lieferungen und Leistungen| \(Konzern, Beteiligte, Nahestehende\)| mit Börsenkurs|, Abschreibungen, Finanzergebnis/g, (m) => (m.includes('Lieferungen') ? ' L+L' : ''));

export interface FocusExamProps {
  areas: AreaRow[]; area: string; setArea: (code: string) => void;
  account: string | null; setAccount: (n: string | null) => void;
  groups: GroupsInfo | null; decisions: ReviewDecisions; update: Update; visum: string; needVisum: () => string;
  historyId: string; docs: ViewDoc[]; closingDate: string | null; rates: Record<string, number>;
  onMoveGroup: (n: string, g: string | null, quiet?: boolean) => void;
  onAddEvidence: (num: string, files: { path: string; name: string }[]) => Promise<void>;
  renderAccount: (num: string) => ReactNode;
  onExit: () => void;
}

/** Schritt 2 · Fokus-Prüfung: Positionen links, Lead Schedule bzw. Analyse und Prüfungshandlungen in der Mitte, Konto rechts */
export function FocusExam(p: FocusExamProps) {
  const row = p.areas.find(a => a.code === p.area) ?? p.areas[0];
  const [view, setView] = useState<'lead' | 'analyse'>('analyse');
  const [full, setFull] = useState(false);
  const [auto, setAuto] = useState<AutoResults>({});
  const code = row?.code ?? '';
  const hasAnalysis = !!ANALYSIS[code];
  useEffect(() => { setAuto({}); setFull(false); }, [code]);
  const onSummary = useCallback((s: AutoResults) => setAuto(a => ({ ...a, ...s })), []);
  // Konto rechts: gewählt oder erstes der Position
  const acc = row?.items.find(a => a.accountNumber === p.account) ?? null;
  useEffect(() => { if (row && !acc && row.items[0] && code !== 'ER') p.setAccount(row.items[0].accountNumber); }, [row, acc, code, p]);
  // Tastatur: ↑ ↓ Konto der Position, Bild ↑ / Bild ↓ Position
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') { if (full) setFull(false); else p.onExit(); return; }
      if (!row) return;
      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        const i = p.areas.findIndex(a => a.code === code);
        const n = p.areas[i + (e.key === 'PageDown' ? 1 : -1)];
        if (n) p.setArea(n.code);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = row.items.findIndex(a => a.accountNumber === p.account);
        const n = row.items[Math.min(row.items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (n) { p.setAccount(n.accountNumber); document.querySelector(`[data-lead="${n.accountNumber}"]`)?.scrollIntoView({ block: 'nearest' }); }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [row, code, p, full]);
  if (!row) return <div className="card muted">Keine Positionen im Prüfumfang.</div>;
  const letters = p.decisions.groupLetters ?? p.groups?.letters ?? {};
  const letter = (letters[code] ?? '').trim();
  const allAuto: AutoResults = { ...accountAuto(row.items, p.docs), ...auto };
  const showAnalysis = hasAnalysis && view === 'analyse';
  const big = showAnalysis;
  // Erfolgsrechnung: ohne gewähltes Konto über die ganze Breite
  const wide = full || (code === 'ER' && !acc);

  return (
    <div className={`exam ${wide ? 'full' : ''}`}>
      <nav className="exam-rail" aria-label="Positionen">
        <button className="exam-back" onClick={p.onExit}>⇤ zur Abstimmung</button>
        <div className="exam-rail-list">
          {p.areas.map(a => (
            <button key={a.code} className={`exam-pos ${a.code === code ? 'active' : ''}`} onClick={() => p.setArea(a.code)} title={a.name} data-position={a.code}>
              {a.letter ? <span className="register">{a.letter}</span> : <span className="register empty">–</span>}
              <span className="grow">{SHORT(a.name)}</span>
              {a.status === 'erledigt' ? <span className="ok-text" aria-label="geprüft">✓</span> : a.status === 'in_arbeit' ? <span className="warn" aria-label="in Arbeit">◐</span> : null}
            </button>
          ))}
        </div>
        <div className="exam-rail-foot small muted">↑ ↓ Konto · Bild ↑↓ Position</div>
      </nav>

      <div className="exam-main">
        <section className={`exam-top ${big ? 'big' : ''}`}>
          <div className="exam-head">
            {letter && <span className="register">{letter}</span>}
            <strong>{row.name}</strong>
            <nav className="exam-switch" role="tablist">
              <button role="tab" aria-selected={!showAnalysis} className={!showAnalysis ? 'on' : ''} onClick={() => setView('lead')}>Lead Schedule</button>
              {hasAnalysis && <button role="tab" aria-selected={showAnalysis} className={showAnalysis ? 'on' : ''} onClick={() => setView('analyse')}>{ANALYSIS[code]}</button>}
            </nav>
            <span className="ml-auto" />
            {showAnalysis && <button className="btn btn-sm" onClick={() => setFull(f => !f)} title="Analyse über die ganze Breite – Konto rechts ausgeblendet">{full ? '⤡ Konto einblenden' : '⤢ Vollbild'}</button>}
          </div>
          <div className="exam-top-body">
            {!showAnalysis && <LeadSchedule items={row.items} docs={p.docs} sel={p.account} onSel={p.setAccount} />}
            {showAnalysis && code === 'A12' && <Receivables historyId={p.historyId} docs={p.docs} decisions={p.decisions} update={p.update} letter={letter} defaultRates={p.rates} onSummary={onSummary} />}
            {showAnalysis && FIXED.includes(code) && <FixedAssets historyId={p.historyId} decisions={p.decisions} update={p.update} refLetter={letter} onSummary={onSummary} />}
            {showAnalysis && ACCRUALS.includes(code) && <Accruals historyId={p.historyId} decisions={p.decisions} update={p.update} closingDate={p.closingDate} visum={p.visum} side={code === 'A15' ? 'aktiv' : 'passiv'} refLetter={letter} onSummary={onSummary} />}
            {showAnalysis && code === 'ER' && <IncomeAnalysisView historyId={p.historyId} decisions={p.decisions} update={p.update} visum={p.visum} closingDate={p.closingDate} onMoveGroup={p.onMoveGroup} onSummary={onSummary} />}
          </div>
        </section>
        <Procedures code={code} row={row} defs={procedureDefs(code, p.groups)} auto={allAuto} decisions={p.decisions} update={p.update} visum={p.visum} needVisum={p.needVisum}
          letter={letter} account={acc} docs={p.docs} onAddEvidence={p.onAddEvidence} />
      </div>

      {!wide && (
        <div className="exam-account">
          {acc ? p.renderAccount(acc.accountNumber) : <div className="card muted small">Konto im Lead Schedule anklicken, um Beleg und Kontoblatt zu sehen.</div>}
        </div>
      )}
    </div>
  );
}

export function procedureDefs(code: string, groups: GroupsInfo | null): ProcedureDef[] {
  return groups?.procedures?.[code] ?? (code === 'ER' ? [] : groups?.genericProcedures ?? []);
}

/** Lead Schedule: Konten der Position mit Vorjahr und Veränderung – höchstens 6 Zeilen, danach scrollbar */
function LeadSchedule({ items, docs, sel, onSel }: { items: ViewAccount[]; docs: ViewDoc[]; sel: string | null; onSel: (n: string) => void }) {
  const cy = items.reduce((s, a) => s + a.balance, 0);
  const py = items.reduce((s, a) => s + (a.balancePreviousYear ?? 0), 0);
  const pctOf = (c: number, v: number | null) => (v ? `${c >= v ? '+' : ''}${(((c - v) / Math.abs(v)) * 100).toFixed(0)} %` : c ? 'neu' : '');
  return (
    <div className="lead">
      <table className="grid small clickable">
        <thead><tr><th>Konto</th><th>Bezeichnung</th><th className="num">Aktuell</th><th className="num">Vorjahr</th><th className="num">Δ CHF</th><th className="num">Δ %</th><th>Beleg</th></tr></thead>
        <tbody>
          {items.map(a => {
            const d = a.balance - (a.balancePreviousYear ?? 0);
            const big = Math.abs(d) >= 1_000_000 && (!a.balancePreviousYear || Math.abs(d / a.balancePreviousYear) >= 0.2);
            const reg = docs.find(x => x.id === a.docId)?.register;
            return (
              <tr key={a.accountNumber} data-lead={a.accountNumber} className={sel === a.accountNumber ? 'selected' : ''} onClick={() => onSel(a.accountNumber)}>
                <td>{a.accountNumber}</td><td>{a.accountName}</td><td className="num">{chf(a.balance)}</td>
                <td className="num">{a.balancePreviousYear === null ? '' : chf(a.balancePreviousYear)}</td>
                <td className="num">{chf(d)}</td><td className={`num ${big ? 'warn' : ''}`}>{pctOf(a.balance, a.balancePreviousYear)}</td>
                <td><span className={`dot ${DOT[a.status] ?? 'grey'}`} /> {reg ?? (a.status === 'BELEGT' ? 'ok' : a.status === 'NULLSALDO' || a.status === 'NICHT_IM_UMFANG' ? '' : 'fehlt')}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr className="total-row"><td /><td>Total · {items.length} Konten</td><td className="num">{chf(cy)}</td><td className="num">{chf(py)}</td><td className="num">{chf(cy - py)}</td><td className="num">{pctOf(cy, py || null)}</td><td /></tr></tfoot>
      </table>
    </div>
  );
}

/** Tabelle Prüfungshandlungen: Empfehlung, Notiz/Ergebnis daneben, Referenz, Visum; eigene Handlungen; Position abschliessen */
function Procedures({ code, row, defs, auto, decisions, update, visum, needVisum, letter, account, docs, onAddEvidence }: {
  code: string; row: AreaRow; defs: ProcedureDef[]; auto: AutoResults; decisions: ReviewDecisions; update: Update; visum: string; needVisum: () => string;
  letter: string; account: ViewAccount | null; docs: ViewDoc[]; onAddEvidence: (num: string, files: { path: string; name: string }[]) => Promise<void>;
}) {
  const toast = useToast();
  const ap = decisions.procedures?.[code];
  const removed = new Set(ap?.removed ?? []);
  const list = useMemo(() => [...defs.filter(d => !removed.has(d.id)).map(d => ({ ...d, custom: false })), ...(ap?.custom ?? []).map(c => ({ ...c, auto: undefined, custom: true }))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [defs, ap?.custom, ap?.removed]);
  const [newText, setNewText] = useState('');
  const [files, setFiles] = useState(false);
  const status = decisions.areaStatus?.[code];
  const setAp = (fn: (x: NonNullable<ReviewDecisions['procedures']>[string]) => NonNullable<ReviewDecisions['procedures']>[string]) =>
    update(d => ({ ...d, procedures: { ...d.procedures, [code]: fn(d.procedures?.[code] ?? {}) } }));
  const markInWork = (d: ReviewDecisions): ReviewDecisions => (d.areaStatus?.[code] ? d : { ...d, areaStatus: { ...d.areaStatus, [code]: { status: 'in_arbeit', at: new Date().toISOString(), visum: visum.trim() } } });
  const setItem = (id: string, patch: Partial<ProcedureState>) => {
    const v = needVisum();
    update(d => markInWork({ ...d, procedures: { ...d.procedures, [code]: { ...d.procedures?.[code], items: { ...d.procedures?.[code]?.items, [id]: { ...stateOf(d, id), ...patch, auto: false, visum: v, at: new Date().toISOString() } } } } }));
  };
  const stateOf = (d: ReviewDecisions, id: string): ProcedureState => {
    const st = d.procedures?.[code]?.items?.[id];
    const def = list.find(x => x.id === id);
    const s = def?.auto ? auto[def.auto] : undefined;
    return st && !st.auto ? st : s ? { done: s.done, note: s.note, ref: s.ref } : st ?? { done: false, note: '' };
  };
  // automatische Ergebnisse übernehmen (solange nicht vom Prüfer bearbeitet) – damit sie auch im Excel stehen
  const autoKey = JSON.stringify(auto);
  useEffect(() => {
    const writes: Record<string, ProcedureState> = {};
    for (const d of list) {
      const s = d.auto ? auto[d.auto] : undefined;
      if (!s) continue;
      const st = ap?.items?.[d.id];
      if (st && !st.auto) continue;
      if (st && st.done === s.done && st.note === s.note && (st.ref ?? '') === (s.ref ?? '')) continue;
      writes[d.id] = { done: s.done, note: s.note, ref: s.ref, auto: true, at: new Date().toISOString() };
    }
    if (Object.keys(writes).length) update(d => ({ ...d, procedures: { ...d.procedures, [code]: { ...d.procedures?.[code], items: { ...d.procedures?.[code]?.items, ...writes } } } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey, code, list]);

  const rows = list.map(d => ({ d, st: stateOf(decisions, d.id) }));
  const done = rows.filter(r => r.st.done).length;
  const closeArea = () => {
    const v = needVisum();
    update(d => ({ ...d, areaStatus: { ...d.areaStatus, [code]: { status: status?.status === 'erledigt' ? 'in_arbeit' : 'erledigt', at: new Date().toISOString(), visum: v } } }));
    if (status?.status !== 'erledigt' && done < rows.length) toast('ok', `Position abgeschlossen – ${rows.length - done} Handlung${rows.length - done > 1 ? 'en' : ''} offen.`);
  };
  const addCustom = () => {
    if (!newText.trim()) return;
    const id = `eigen-${uid()}`;
    setAp(x => ({ ...x, custom: [...(x.custom ?? []), { id, text: newText.trim() }] }));
    setNewText('');
  };
  const remove = (id: string, custom: boolean) => setAp(x => {
    const { [id]: _x, ...items } = x.items ?? {};
    return custom ? { ...x, items, custom: (x.custom ?? []).filter(c => c.id !== id) } : { ...x, items, removed: [...(x.removed ?? []), id] };
  });

  return (
    <section className="exam-proc" aria-label="Prüfungshandlungen">
      <div className="exam-head">
        <strong>Prüfungshandlungen</strong>
        <span className="muted small">{done} von {rows.length} erledigt</span>
        <span className="ml-auto" />
        <span className="files-anchor">
          <button className="btn btn-sm" onClick={() => setFiles(f => !f)} aria-expanded={files}>📎 Dateien{fileCount(decisions, code, row, docs) ? ` (${fileCount(decisions, code, row, docs)})` : ''}</button>
          {files && <FilesPopover code={code} row={row} letter={letter} account={account} docs={docs} decisions={decisions} update={update} onAddEvidence={onAddEvidence} onClose={() => setFiles(false)} />}
        </span>
        <button className={`btn btn-sm ${status?.status === 'erledigt' ? 'done' : 'accent'}`} onClick={closeArea}
          title={status?.status === 'erledigt' ? `abgeschlossen von ${status.visum || '–'} am ${date(status.at.slice(0, 10))} – Klick öffnet wieder` : 'Position als geprüft markieren (mit Visum)'}>
          {status?.status === 'erledigt' ? `✓ Geprüft ${status.visum}` : 'Position abschliessen ✓'}
        </button>
      </div>
      <div className="proc-wrap">
        <table className="grid small proc">
          <colgroup><col style={{ width: 30 }} /><col style={{ width: '44%' }} /><col /><col style={{ width: 92 }} /><col style={{ width: 54 }} /><col style={{ width: 30 }} /></colgroup>
          <thead><tr><th /><th>Empfohlene Prüfungshandlung</th><th>Notiz / Ergebnis</th><th>Ref.</th><th>Visum</th><th /></tr></thead>
          <tbody>
            {rows.map(({ d, st }) => {
              const isAuto = !!d.auto && !!auto[d.auto] && (!decisions.procedures?.[code]?.items?.[d.id] || decisions.procedures[code]!.items![d.id]!.auto);
              return (
                <tr key={d.id} data-handlung={d.id} className={st.done ? 'done' : ''}>
                  <td><input type="checkbox" checked={st.done} aria-label={`erledigt: ${d.text}`} onChange={e => setItem(d.id, { done: e.target.checked, note: st.note, ref: st.ref })} /></td>
                  <td>{d.text}{isAuto && <span className="auto-tag" title="Vorschlag aus der Auswertung – mit einer eigenen Eingabe übersteuert">automatisch</span>}{d.custom && <span className="muted small"> · eigene</span>}</td>
                  <td><NoteCell value={st.note} label={`Notiz: ${d.text}`} onSave={t => setItem(d.id, { note: t, done: st.done, ref: st.ref })} /></td>
                  <td><input className="ref-input" value={st.ref ?? ''} aria-label={`Referenz: ${d.text}`} placeholder="–" onChange={e => setItem(d.id, { ref: e.target.value, done: st.done, note: st.note })} /></td>
                  <td className="small">{isAuto ? <span className="muted">auto</span> : decisions.procedures?.[code]?.items?.[d.id]?.visum || <span className="muted">–</span>}</td>
                  <td><button className="icon-btn" aria-label={`Handlung entfernen: ${d.text}`} title={d.custom ? 'Eigene Handlung löschen' : 'Für dieses Mandat ausblenden'} onClick={() => remove(d.id, d.custom)}>✕</button></td>
                </tr>
              );
            })}
            <tr className="proc-new">
              <td>+</td>
              <td colSpan={5}><AutoTextarea placeholder="Eigene Prüfungshandlung erfassen (Enter)" aria-label="Eigene Prüfungshandlung" value={newText} onChange={e => setNewText(e.target.value)} submitOnEnter onSubmit={addCustom} /></td>
            </tr>
          </tbody>
        </table>
        {removed.size > 0 && <button className="link small" onClick={() => setAp(x => ({ ...x, removed: [] }))}>{removed.size} ausgeblendete Empfehlung{removed.size > 1 ? 'en' : ''} wieder anzeigen</button>}
      </div>
    </section>
  );
}

function NoteCell({ value, label, onSave }: { value: string; label: string; onSave: (t: string) => void }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  return <AutoTextarea className="note-cell" value={t} aria-label={label} placeholder="Notiz erfassen …" onChange={e => setT(e.target.value)} onBlur={() => t !== value && onSave(t)} />;
}

const fileCount = (d: ReviewDecisions, code: string, row: AreaRow, docs: ViewDoc[]) =>
  (d.groupAttachments?.[code]?.length ?? 0) + docs.filter(x => x.relPath.startsWith('Nachweise Prüfer/') && x.accounts.some(n => row.items.some(a => a.accountNumber === n))).length;

/** 📎 Dateien: Nachweis zum Konto (zählt als Beleg) oder Beilage zur Analyse (<Buchstabe>.100.n) */
function FilesPopover({ code, row, letter, account, docs, decisions, update, onAddEvidence, onClose }: {
  code: string; row: AreaRow; letter: string; account: ViewAccount | null; docs: ViewDoc[]; decisions: ReviewDecisions; update: Update;
  onAddEvidence: (num: string, files: { path: string; name: string }[]) => Promise<void>; onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const atts = decisions.groupAttachments?.[code] ?? [];
  const uploaded = docs.filter(x => x.relPath.startsWith('Nachweise Prüfer/') && x.accounts.some(n => row.items.some(a => a.accountNumber === n)));
  const pick = async () => (await bsb().pick.evidence('files')).filter(f => !f.isDirectory).map(f => ({ path: f.path, name: f.name }));
  const dropped = async (e: React.DragEvent) => {
    e.preventDefault();
    const l = await Promise.all([...e.dataTransfer.files].map(f => bsb().pick.pathOf(f)));
    return l.filter((x): x is NonNullable<typeof x> => !!x && !x.isDirectory).map(f => ({ path: f.path, name: f.name }));
  };
  const evidence = async (f: { path: string; name: string }[]) => {
    if (!f.length || !account) return;
    setBusy(true);
    try { await onAddEvidence(account.accountNumber, f); } finally { setBusy(false); }
  };
  const attach = (f: { path: string; name: string }[]) => {
    if (!f.length) return;
    update(d => ({ ...d, groupAttachments: { ...d.groupAttachments, [code]: [...(d.groupAttachments?.[code] ?? []), ...f.map(x => ({ id: uid(), name: x.name, path: x.path, account: account?.accountNumber ?? null }))] } }));
    toast('ok', `${f.length} Beilage${f.length > 1 ? 'n' : ''} angehängt${letter ? ` – Ablage als ${letter}.100.n` : ''}.`);
  };
  return (
    <div className="files-pop" role="dialog" aria-label="Dateien">
      <div className="row" style={{ justifyContent: 'space-between' }}><strong>Dateien zur Position</strong><button className="icon-btn" aria-label="Schliessen" onClick={onClose}>✕</button></div>
      {[...uploaded.map(x => ({ id: x.id, name: x.filename, path: x.absPath, kind: `Nachweis ${x.register ?? ''}`, del: null as null | (() => void) })),
        ...atts.map(x => ({ id: x.id, name: x.name, path: x.path, kind: 'Beilage', del: () => update(d => ({ ...d, groupAttachments: { ...d.groupAttachments, [code]: (d.groupAttachments?.[code] ?? []).filter(y => y.id !== x.id) } })) }))].map(f => (
        <div key={f.id} className="file-line">
          <button className="link small grow" title={f.path} onClick={() => void bsb().app.openPath(f.path)}>{f.name}</button>
          <span className="small muted">{f.kind}</span>
          {f.del && <button className="icon-btn" aria-label={`Beilage ${f.name} entfernen`} onClick={f.del}>✕</button>}
        </div>
      ))}
      <div className="drop small" onDragOver={e => e.preventDefault()} onDrop={async e => void evidence(await dropped(e))}>
        <strong>Nachweis zum Konto {account?.accountNumber ?? ''}</strong> – zählt als Beleg
        <div><button className="btn btn-sm" disabled={busy || !account} onClick={async () => void evidence(await pick())}>{busy ? 'Wird gelesen …' : 'Nachweis hochladen …'}</button></div>
      </div>
      <div className="drop small" onDragOver={e => e.preventDefault()} onDrop={async e => attach(await dropped(e))}>
        <strong>Beilage zur Prüfung</strong> – Vertrag, Korrespondenz{letter ? ` (${letter}.100.n)` : ''}
        <div><button className="btn btn-sm" onClick={async () => attach(await pick())}>Beilage anhängen …</button></div>
      </div>
    </div>
  );
}
