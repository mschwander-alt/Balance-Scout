import { useCallback, useEffect, useMemo, useState } from 'react';
import { bsb } from '../bridge';
import type { AuditResult, Best, Status } from '../types';
import type { GroupsInfo, ReviewDecisions } from '../../electron/shared';
import { chf, date, pct } from '../format';
import { FLAG_LABEL, Modal, Spinner, StatusBadge, useToast } from '../components/ui';
import { DocumentPreview } from '../components/DocumentPreview';
import { deriveView, groupAccounts, type ViewAccount, type ViewDoc } from '../review';

type Tab = 'konten' | 'belege' | 'saldobilanz' | 'diagnose';

export function Result({ result: initial, onRepeat }: { result: AuditResult; onRepeat?: () => void }) {
  const toast = useToast();
  const [result, setResult] = useState(initial);
  const [decisions, setDecisions] = useState<ReviewDecisions>(initial.decisions ?? {});
  const [groups, setGroups] = useState<GroupsInfo | null>(null);
  const [visum, setVisum] = useState('');
  const [tab, setTab] = useState<Tab>('konten');
  const [filter, setFilter] = useState<Status | 'ALLE'>('ALLE');
  const [grouped, setGrouped] = useState(true);
  const [docFilter, setDocFilter] = useState<'alle' | 'zu' | 'offen' | 'probleme'>('alle');
  const [open, setOpen] = useState<string | null>(null);
  const [showFinalize, setShowFinalize] = useState(false);
  const [showLetters, setShowLetters] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = result.historyId;

  useEffect(() => {
    void bsb().review.groups().then(g => {
      setGroups(g);
      // Registerbuchstaben: aus der Prüfung, sonst aus den Einstellungen, sonst Vorschlag
      void bsb().app.settings().then(s => {
        setVisum(s.visum ?? '');
        setDecisions(d => (d.groupLetters ? d : { ...d, groupLetters: s.groupLetters ?? g.letters }));
      });
    });
  }, []);
  // Entscheide laufend speichern
  const update = useCallback((fn: (d: ReviewDecisions) => ReviewDecisions) => {
    setDecisions(d => {
      const next = fn(d);
      if (id) void bsb().review.save(id, next);
      return next;
    });
  }, [id]);

  const view = useMemo(() => deriveView(result, decisions), [result, decisions]);
  const order = groups?.groups.map(g => g.code) ?? [];
  const accounts = view.accounts.filter(a => filter === 'ALLE' || a.status === filter);
  const docs = useMemo(
    () => view.docs.filter(d => docFilter === 'alle' || (docFilter === 'zu' ? d.assigned : docFilter === 'offen' ? !d.assigned && !d.irrelevant : d.status !== 'ok')),
    [view.docs, docFilter],
  );
  const sel = view.accounts.find(a => a.accountNumber === open) ?? null;
  const filed = (docId: string | null) => (docId ? result.filed?.[docId] : undefined);

  useEffect(() => {
    if (tab !== 'konten') return;
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') return setOpen(null);
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const list = grouped ? groupAccounts(accounts, order).flatMap(g => g.items) : accounts;
      const i = list.findIndex(a => a.accountNumber === open);
      const next = list[Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        setOpen(next.accountNumber);
        document.querySelector(`[data-konto="${next.accountNumber}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tab, accounts, open, grouped, order]);

  const now = () => new Date().toISOString();
  const needVisum = () => visum.trim();
  const visumField = (
    <label className="field inline visum"><span>Visum</span>
      <input className="w-xs" value={visum} placeholder="z. B. MS" aria-label="Visum" onChange={e => setVisum(e.target.value.toUpperCase().slice(0, 6))} onBlur={() => void bsb().app.saveSettings({ visum: visum.trim() })} />
    </label>
  );
  const accept = (a: ViewAccount, comment?: string) => update(d => ({ ...d, accepted: { ...d.accepted, [a.accountNumber]: { at: now(), visum: needVisum(), comment: comment || undefined } } }));
  const unaccept = (a: ViewAccount) => update(d => {
    const { [a.accountNumber]: _x, ...rest } = d.accepted ?? {};
    return { ...d, accepted: rest };
  });
  const assign = (docId: string, accountNumber: string | null | undefined) => update(d => {
    const { [docId]: _x, ...rest } = d.assignments ?? {};
    return { ...d, assignments: accountNumber === undefined ? rest : { ...rest, [docId]: { accountNumber, at: now(), visum: needVisum() } } };
  });
  const setNote = (num: string, text: string) => update(d => {
    const { [num]: _x, ...rest } = d.notes ?? {};
    return { ...d, notes: text.trim() ? { ...rest, [num]: { text, at: now(), visum: needVisum() } } : rest };
  });

  const finalize = async () => {
    if (!id) return;
    setBusy(true);
    try {
      const r = (await bsb().review.finalize(id, decisions)) as AuditResult;
      setResult({ ...r, historyId: id });
      setShowFinalize(false);
      toast('ok', 'Abgeschlossen: Belege abgelegt und Excel-Dokumentation erstellt.');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ocrDocs = result.documents.filter(d => d.ocrPages > 0).length;
  const problemDocs = result.documents.filter(d => d.status !== 'ok').length;
  const inScope = view.accounts.filter(a => a.status !== 'NICHT_IM_UMFANG' && a.status !== 'NULLSALDO');

  return (
    <div className="page stack">
      {!result.finalized ? (
        <div className="draft-bar row">
          <div className="grow">
            <strong>Durchsicht</strong> – Konten mit „Prüfen“ akzeptieren, nicht zugeordnete Belege zuordnen, Notizen erfassen.
            <div className="small muted">Ablage und Excel-Dokumentation entstehen erst beim Abschliessen. Offen: {view.open.pruefen} × Prüfen · {view.open.unassignedDocs} Belege ohne Zuordnung.</div>
          </div>
          {visumField}
          <button className="btn" onClick={() => setShowLetters(true)}>Register …</button>
          <button className="btn btn-primary" onClick={() => setShowFinalize(true)}>Abschliessen …</button>
        </div>
      ) : (
        <div className="row">
          <button className="btn btn-primary" onClick={() => bsb().app.openPath(result.excelPath)}>Excel-Dokumentation öffnen</button>
          <button className="btn" onClick={() => bsb().app.showInFolder(result.excelPath)}>Zielordner anzeigen</button>
          {visumField}
          <button className="btn" onClick={() => setShowLetters(true)}>Register …</button>
          <button className="btn" onClick={() => setShowFinalize(true)} title="Nach weiteren Änderungen: neue Version der Dokumentation">Erneut abschliessen …</button>
          {onRepeat && <button className="btn" onClick={onRepeat}>Erneut prüfen …</button>}
          <span className="muted small ml-auto" title={result.excelPath}>{result.excelPath}</span>
        </div>
      )}

      <div className="kpis">
        <Kpi label="Abdeckung (belegt)" value={pct(view.coverage)} sub={`${chf(view.confirmedAbsTotal)} von ${chf(view.inScopeAbsTotal)}`} />
        <Kpi label="Belegt" value={view.counts.BELEGT} tone="ok" onClick={() => { setTab('konten'); setFilter('BELEGT'); }} />
        <Kpi label="Prüfen" value={view.counts.PRUEFEN} tone="warn" onClick={() => { setTab('konten'); setFilter('PRUEFEN'); }} />
        <Kpi label="Kein Nachweis" value={view.counts.KEIN_NACHWEIS} tone="bad" onClick={() => { setTab('konten'); setFilter('KEIN_NACHWEIS'); }} />
        <Kpi label="Belege zugeordnet" value={`${view.docs.filter(d => d.assigned).length} / ${result.documents.length}`} sub={`${view.open.unassignedDocs} ohne Zuordnung · ${ocrDocs} mit Texterkennung${problemDocs ? ` · ${problemDocs} mit Hinweis` : ''}`} onClick={() => { setTab('belege'); setDocFilter('offen'); }} />
      </div>

      <nav className="tabs" role="tablist" style={{ padding: 0 }}>
        {([['konten', 'Konten'], ['belege', 'Belegverzeichnis'], ['saldobilanz', 'Saldobilanz-Prüfung'], ['diagnose', 'Diagnosebericht']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === 'konten' && (
        <div className={`result-layout ${sel ? 'withpreview' : 'nopanel'}`}>
          <div className="stack">
            <div className="row filter">
              {(['ALLE', 'BELEGT', 'PRUEFEN', 'KEIN_NACHWEIS', 'NULLSALDO', 'NICHT_IM_UMFANG'] as const).map(f => (
                <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f === 'ALLE' ? `Alle (${view.accounts.length})` : <StatusBadge status={f} />}</button>
              ))}
              <label className="small ml-auto"><input type="checkbox" checked={grouped} onChange={e => setGrouped(e.target.checked)} /> nach KMU-Kontenrahmen gruppieren</label>
            </div>
            <div className="table-wrap">
              <table className="grid clickable">
                <thead><tr><th>Konto</th><th>Bezeichnung</th><th className="num">Saldo</th><th>Status</th><th>Datei</th><th>Seite</th><th>Hinweise</th></tr></thead>
                <tbody>
                  {(grouped ? groupAccounts(accounts, order) : [{ code: '', name: '', items: accounts, total: 0 }]).map(g => (
                    <GroupRows key={g.code || 'alle'} g={g} grouped={grouped} letter={decisions.groupLetters?.[g.code]} open={open} setOpen={setOpen} docs={view.docs} notes={decisions.notes ?? {}} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {sel && (
            <AccountPanel
              key={sel.accountNumber} a={sel} docs={view.docs} filedPath={filed(sel.docId)?.placement?.newPath ?? null}
              note={decisions.notes?.[sel.accountNumber]?.text ?? ''} accepted={decisions.accepted?.[sel.accountNumber]}
              onAccept={c => accept(sel, c)} onUnaccept={() => unaccept(sel)} onNote={t => setNote(sel.accountNumber, t)}
              onAssign={docId => assign(docId, sel.accountNumber)} onUnassign={docId => assign(docId, undefined)} onClose={() => setOpen(null)}
            />
          )}
        </div>
      )}

      {tab === 'belege' && (
        <div className="stack">
          <div className="row filter">
            {([['alle', `Alle (${view.docs.length})`], ['zu', 'Zugeordnet'], ['offen', `Ohne Zuordnung (${view.open.unassignedDocs})`], ['probleme', 'Mit Hinweis']] as const).map(([k, l]) => (
              <button key={k} className={`chip ${docFilter === k ? 'active' : ''}`} onClick={() => setDocFilter(k)}>{l}</button>
            ))}
            {result.finalized && result.input?.targetDir && <button className="btn btn-sm ml-auto" onClick={() => bsb().app.openPath(result.input!.targetDir!)}>Ablage öffnen</button>}
          </div>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Datei</th><th>Belegart</th><th>Stichtag</th><th>Gelesen</th><th>Zuordnung</th><th>Ablage</th><th /></tr></thead>
              <tbody>{docs.map(d => <DocLine key={d.id} d={d} accounts={inScope} filedInfo={filed(d.id)} onAssign={n => assign(d.id, n)} />)}</tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'saldobilanz' && (
        <div className="card stack">
          {result.trialBalance && result.trialBalance.parts.length > 0 && (
            <p className="small">Gelesen: {result.trialBalance.parts.map(p => `${p.label} (${p.status === 'ok' ? `${p.accountCount} Konten` : p.status})`).join(' · ')}
              {result.input?.accountDigits && <> · Kontonummern mit {result.input.accountDigits.min === result.input.accountDigits.max ? result.input.accountDigits.min : `${result.input.accountDigits.min}–${result.input.accountDigits.max}`} Ziffern</>}</p>
          )}
          <ul className="checks">{result.validation.checks.map(c => <li key={c.name} className={c.passed ? 'ok' : 'fail'}><strong>{c.passed ? '✓' : '✗'} {c.name}</strong> – {c.message}</li>)}</ul>
          {result.validation.issues.length > 0 && <ul className="issues">{result.validation.issues.map((i, n) => <li key={n} className={i.severity}>{i.source ? `${i.source}, ` : ''}{i.rowIndex ? `Zeile ${i.rowIndex}: ` : ''}{i.message}</li>)}</ul>}
          {result.trialBalance?.excluded.length ? (
            <details><summary className="small">Ausgeblendete Zeilen (Gruppen, Zwischensummen): {result.trialBalance.excluded.length}</summary>
              <ExcludedTable rows={result.trialBalance.excluded} />
            </details>
          ) : null}
        </div>
      )}

      {tab === 'diagnose' && (
        <div className="card stack">
          <p className="small muted">Dieser Bericht enthält <strong>keine</strong> Beträge, Namen oder Dateinamen. Sie können ihn zur Fehlersuche weitergeben.</p>
          <div><button className="btn btn-sm" onClick={async () => { await bsb().app.copyText(result.diagnostics); toast('ok', 'Diagnosebericht kopiert.'); }}>In Zwischenablage kopieren</button></div>
          <pre className="diag">{result.diagnostics}</pre>
        </div>
      )}

      {showLetters && groups && (
        <LettersDialog groups={groups} letters={decisions.groupLetters ?? groups.letters} onClose={() => setShowLetters(false)}
          onApply={(l, asDefault) => { update(d => ({ ...d, groupLetters: l })); if (asDefault) void bsb().app.saveSettings({ groupLetters: l }); setShowLetters(false); }} />
      )}
      {showFinalize && (
        <Modal title={result.finalized ? 'Erneut abschliessen' : 'Prüfung abschliessen'} onClose={() => !busy && setShowFinalize(false)} footer={<>
          <button className="btn" disabled={busy} onClick={() => setShowFinalize(false)}>Zurück zur Durchsicht</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void finalize()}>{busy ? 'Wird abgelegt …' : 'Ablegen und Excel erstellen'}</button>
        </>}>
          {busy && <Spinner label="Belege werden abgelegt …" />}
          <ul>
            <li>{view.counts.BELEGT} Konten belegt ({decisions.accepted ? Object.keys(decisions.accepted).length : 0} manuell akzeptiert), <strong className={view.counts.PRUEFEN ? 'warn' : ''}>{view.counts.PRUEFEN} noch „Prüfen“</strong>, {view.counts.KEIN_NACHWEIS} ohne Nachweis.</li>
            <li>{view.docs.filter(d => d.assigned).length} Belege zugeordnet, {view.docs.filter(d => d.irrelevant).length} nicht relevant, <strong className={view.open.unassignedDocs ? 'warn' : ''}>{view.open.unassignedDocs} ohne Zuordnung</strong>.</li>
            <li>{Object.keys(decisions.notes ?? {}).length} Notizen (als erste Seite im PDF bzw. als separates Notiz-PDF).</li>
            <li>Ablage: {result.input?.fileMode === 'none' ? 'keine (nur Excel)' : <>{result.input?.fileMode === 'move' ? 'verschieben' : 'kopieren'} nach <code>{result.input?.targetDir}</code>; Dateinamen mit Register, z. B. <code>B.1_Kontoauszug.pdf</code></>}</li>
          </ul>
          {result.finalized && <p className="small muted">Es entsteht eine neue Version der Excel-Dokumentation („… (2).xlsx“); die bisherige bleibt unverändert.</p>}
          {(view.counts.PRUEFEN > 0 || view.open.unassignedDocs > 0) && <p className="warn-box small">Es gibt noch offene Punkte. Sie können trotzdem abschliessen – sie erscheinen im Excel unter „Offene Punkte“ bzw. im Ordner 02_Nicht_zugeordnet.</p>}
        </Modal>
      )}
    </div>
  );
}

function GroupRows({ g, grouped, letter, open, setOpen, docs, notes }: {
  g: { code: string; name: string; items: ViewAccount[]; total: number }; grouped: boolean; letter?: string; open: string | null;
  setOpen: (n: string) => void; docs: ViewDoc[]; notes: Record<string, unknown>;
}) {
  const docBy = new Map(docs.map(d => [d.id, d]));
  return (
    <>
      {grouped && (
        <tr className="group-row">
          <td colSpan={2}>{letter ? <span className="register">{letter}</span> : null}{g.name}</td>
          <td className="num mono">{chf(g.total)}</td>
          <td colSpan={4} className="small muted">{g.items.length} Konten</td>
        </tr>
      )}
      {g.items.map(a => {
        const doc = a.docId ? docBy.get(a.docId) : undefined;
        const hasDoc = a.status === 'BELEGT' || a.status === 'PRUEFEN';
        return (
          <tr key={a.accountNumber} data-konto={a.accountNumber} className={open === a.accountNumber ? 'selected' : ''} onClick={() => setOpen(a.accountNumber)}>
            <td className="mono">{a.accountNumber}</td>
            <td>{a.accountName}{a.groupSource === 'bezeichnung' && <span className="flag" title="Gruppe aus der Bezeichnung abgeleitet – bitte prüfen">Gruppe?</span>}</td>
            <td className="num mono">{chf(a.balance)}</td>
            <td><StatusBadge status={a.status} />{a.manual && <span className="manual" title={a.manual === 'akzeptiert' ? 'manuell akzeptiert' : 'Beleg manuell zugeordnet'}>✓ manuell</span>}</td>
            <td className="small">{hasDoc && doc ? <>{doc.register && <span className="register sm">{doc.register}</span>}{doc.filename}</> : <span className="muted">–</span>}</td>
            <td className="small">{a.best && hasDoc && a.docId === a.best.documentId ? a.best.pageLabel ?? a.best.page : ''}</td>
            <td>{a.best?.flags.map(f => <span key={f} className="flag">{FLAG_LABEL[f] ?? f}</span>)}{notes[a.accountNumber] ? <span className="flag note" title="Notiz vorhanden">Notiz</span> : null}</td>
          </tr>
        );
      })}
    </>
  );
}

function Kpi({ label, value, sub, tone, onClick }: { label: string; value: string | number; sub?: string; tone?: 'ok' | 'warn' | 'bad'; onClick?: () => void }) {
  return (
    <button className={`kpi ${tone ?? ''}`} onClick={onClick} disabled={!onClick}>
      <span className="kpi-label">{label}</span><span className="kpi-value">{value}</span>{sub && <span className="kpi-sub">{sub}</span>}
    </button>
  );
}

function AccountSelect({ accounts, value, onChange, irrelevantOption = true }: { accounts: ViewAccount[]; value: string; onChange: (v: string | null | undefined) => void; irrelevantOption?: boolean }) {
  return (
    <select className="assign" value={value} onClick={e => e.stopPropagation()} onChange={e => onChange(e.target.value === '' ? undefined : e.target.value === '__none' ? null : e.target.value)}>
      <option value="">– automatisch / nicht zugeordnet –</option>
      {irrelevantOption && <option value="__none">Nicht relevant (keinem Konto)</option>}
      {accounts.map(a => <option key={a.accountNumber} value={a.accountNumber}>{a.accountNumber} {a.accountName}{a.status === 'KEIN_NACHWEIS' ? ' (ohne Nachweis)' : ''}</option>)}
    </select>
  );
}

function DocLine({ d, accounts, filedInfo, onAssign }: { d: ViewDoc; accounts: ViewAccount[]; filedInfo?: { placement: { status: string; newPath: string | null; message: string | null } | null; notePath: string | null; register: string | null; irrelevant: boolean }; onAssign: (n: string | null | undefined) => void }) {
  const read = d.status === 'ok' ? 'Ja' : d.status === 'partial' ? 'Teilweise' : d.status === 'unsupported' ? 'nicht unterstützt' : 'Nein';
  const value = d.manualAssignment ? (d.irrelevant ? '__none' : d.accounts[0] ?? '') : '';
  const pl = filedInfo?.placement;
  return (
    <tr data-beleg={d.relPath}>
      <td>{d.register && <span className="register sm">{d.register}</span>}{d.filename}<div className="muted small" title={d.relPath}>{d.relPath}</div>{d.warnings.length > 0 && <div className="small warn">{d.warnings.join(' · ')}</div>}</td>
      <td className="small">{d.docType}</td>
      <td className="small">{date(d.balanceDate)}</td>
      <td className="small">{read}{d.ocrPages > 0 && <div className="muted">Scan, {d.ocrConfidence ?? '–'} %</div>}</td>
      <td className="small">
        {d.assigned ? <span className="badge badge-belegt">Konto {d.accounts.join(', ')}</span> : d.irrelevant ? <span className="badge badge-nullsaldo">nicht relevant</span> : <span className="badge badge-kein_nachweis">ohne Zuordnung</span>}
        {d.manualAssignment && <span className="manual">✓ manuell</span>}
        <div><AccountSelect accounts={accounts} value={value} onChange={onAssign} /></div>
      </td>
      <td className="small">{pl ? <>{pl.status}{pl.message ? `: ${pl.message}` : ''}{pl.newPath && <div className="muted" title={pl.newPath}>{pl.newPath.split(/[\\/]/).slice(-2).join('/')}</div>}{filedInfo?.notePath && <div className="muted">+ Notiz-PDF</div>}</> : <span className="muted">beim Abschliessen</span>}</td>
      <td className="actions"><button className="btn btn-sm" onClick={() => bsb().app.openPath(pl?.newPath ?? d.absPath)}>Öffnen</button></td>
    </tr>
  );
}

function AccountPanel({ a, docs, filedPath, note, accepted, onAccept, onUnaccept, onNote, onAssign, onUnassign, onClose }: {
  a: ViewAccount; docs: ViewDoc[]; filedPath: string | null; note: string; accepted?: { visum: string; at: string; comment?: string };
  onAccept: (comment: string) => void; onUnaccept: () => void; onNote: (t: string) => void; onAssign: (docId: string) => void; onUnassign: (docId: string) => void; onClose: () => void;
}) {
  const found = a.autoStatus === 'BELEGT' || a.autoStatus === 'PRUEFEN';
  const all: Best[] = found && a.best ? [a.best, ...a.candidates] : a.candidates;
  const [idx, setIdx] = useState(0);
  const [comment, setComment] = useState(accepted?.comment ?? '');
  const [noteText, setNoteText] = useState(note);
  const manualDoc = a.manual === 'zugeordnet' ? docs.find(d => d.id === a.docId) : undefined;
  const c = manualDoc ? undefined : all[idx];
  const file = manualDoc ? manualDoc.absPath : c ? c.newPath ?? c.absPath : null;
  const candidatesToAssign = docs.filter(d => !d.assigned && !d.irrelevant);
  return (
    <aside className="panel preview-panel">
      <header className="panel-head">
        <div>
          <h3>{a.accountNumber} {a.accountName}</h3>
          <p className="mono">{chf(a.balance)}{a.balancePreviousYear !== null && <span className="muted small"> · VJ {chf(a.balancePreviousYear)}</span>} <StatusBadge status={a.status} />{a.manual && <span className="manual">✓ manuell</span>}</p>
          {a.groupName && <p className="small muted">{a.groupName}{a.groupSource === 'bezeichnung' ? ' (aus Bezeichnung abgeleitet)' : ''}{a.source ? ` · ${a.source}` : ''}</p>}
        </div>
        <button className="icon-btn" aria-label="Schliessen (Esc)" onClick={onClose}>✕</button>
      </header>

      {/* Entscheid der Prüferin / des Prüfers */}
      {a.autoStatus === 'PRUEFEN' && a.manual !== 'zugeordnet' && (
        <div className={`decision ${a.manual === 'akzeptiert' ? 'done' : ''}`}>
          {a.manual === 'akzeptiert' ? (
            <div className="row"><span className="grow small">✓ Als belegt akzeptiert ({accepted?.visum}, {date(accepted?.at.slice(0, 10) ?? null)}){accepted?.comment ? ` – ${accepted.comment}` : ''}</span><button className="btn btn-sm" onClick={onUnaccept}>Rückgängig</button></div>
          ) : (
            <div className="row">
              <input className="grow" placeholder="Kommentar (optional), z. B. Original eingesehen" value={comment} onChange={e => setComment(e.target.value)} />
              <button className="btn btn-sm btn-ok" onClick={() => onAccept(comment)}>Akzeptieren → Belegt</button>
            </div>
          )}
        </div>
      )}
      {manualDoc && (
        <div className="decision done row"><span className="grow small">✓ Beleg manuell zugeordnet: {manualDoc.filename}</span><button className="btn btn-sm" onClick={() => onUnassign(manualDoc.id)}>Zuordnung aufheben</button></div>
      )}
      {a.status === 'KEIN_NACHWEIS' && !manualDoc && candidatesToAssign.length > 0 && (
        <div className="decision row">
          <span className="small">Beleg zuordnen:</span>
          <select className="assign grow" value="" onChange={e => e.target.value && onAssign(e.target.value)}>
            <option value="">– Beleg ohne Zuordnung wählen –</option>
            {candidatesToAssign.map(d => <option key={d.id} value={d.id}>{d.relPath}</option>)}
          </select>
        </div>
      )}

      {a.reasons.length > 0 && !manualDoc && <ul className="reasons small">{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      {!manualDoc && all.length > 1 && (
        <div className="row filter">
          {all.map((x, i) => (
            <button key={i} className={`chip ${i === idx ? 'active' : ''}`} onClick={() => setIdx(i)} title={x.line}>
              {i === 0 && found ? 'Fundstelle' : `Weitere ${found ? i : i + 1}`} · {x.filename} S.{x.page}
            </button>
          ))}
        </div>
      )}
      {file ? (
        <>
          {c && (
            <>
              <div className="cand-head small">
                <span title={c.relPath ?? ''}>{c.relPath ?? c.filename} · {c.pageLabel ?? `S. ${c.page}`} · Z. {c.lineNo}{c.source !== 'text-layer' ? ' · Texterkennung' : ''}</span>
                <span className="score" title="Punktzahl">{c.score}</span>
              </div>
              <div className="small">
                Beleg <strong className="mono">{chf(c.evidenceCents)}</strong> · Differenz <span className="mono">{chf(c.differenceCents)}</span>
                {c.flags.map(f => <span key={f} className="flag" style={{ marginLeft: 6 }}>{FLAG_LABEL[f] ?? f}</span>)}
              </div>
            </>
          )}
          <DocumentPreview file={file} page={c?.page ?? 1} lineNo={c?.lineNo ?? 0} bbox={c?.bbox} line={c?.line ?? ''} />
          <div className="row">
            <button className="btn btn-sm" onClick={() => bsb().app.openPath(filedPath ?? file)}>Beleg öffnen</button>
            {c && <details className="small"><summary>Begründung</summary><ul className="reasons">{c.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></details>}
          </div>
        </>
      ) : (
        <p className="muted">{a.status === 'KEIN_NACHWEIS' ? 'Kein passender Betrag in den Unterlagen gefunden.' : 'Für dieses Konto ist kein Nachweis nötig.'}</p>
      )}

      <label className="field note-field">
        <span>Notiz {a.docId ? '(wird dem Beleg als erste Seite vorangestellt bzw. als Notiz-PDF abgelegt)' : '(erscheint in der Excel-Dokumentation)'}</span>
        <textarea rows={2} value={noteText} onChange={e => setNoteText(e.target.value)} onBlur={() => noteText !== note && onNote(noteText)} placeholder="z. B. Saldo mit Bankbestätigung abgestimmt." />
      </label>
      <p className="small muted">↑/↓ nächstes Konto · Esc schliessen</p>
    </aside>
  );
}

function ExcludedTable({ rows }: { rows: { rowIndex: number; source?: string; accountNumber: string; accountName: string; balance: number | null; reason: string }[] }) {
  return (
    <div className="table-wrap" style={{ maxHeight: 300 }}>
      <table className="grid small"><thead><tr><th>Herkunft</th><th>Zeile</th><th>Nr.</th><th>Bezeichnung</th><th className="num">Betrag</th><th>Grund</th></tr></thead>
        <tbody>{rows.map((e, i) => <tr key={i}><td>{e.source ?? ''}</td><td>{e.rowIndex}</td><td className="mono">{e.accountNumber}</td><td>{e.accountName}</td><td className="num mono">{e.balance === null ? '' : chf(e.balance)}</td><td>{e.reason}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
export { ExcludedTable };

function LettersDialog({ groups, letters, onClose, onApply }: { groups: GroupsInfo; letters: Record<string, string>; onClose: () => void; onApply: (l: Record<string, string>, asDefault: boolean) => void }) {
  const [l, setL] = useState(letters);
  const [asDefault, setAsDefault] = useState(true);
  return (
    <Modal title="Register: Buchstaben je Gruppe" wide onClose={onClose} footer={<>
      <label className="small grow"><input type="checkbox" checked={asDefault} onChange={e => setAsDefault(e.target.checked)} /> als Standard für künftige Prüfungen speichern</label>
      <button className="btn" onClick={() => setL(groups.letters)}>Vorschlag</button>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn btn-primary" onClick={() => onApply(l, asDefault)}>Übernehmen</button>
    </>}>
      <p className="small muted">Abgelegte Belege erhalten vorne Buchstabe und Zähler der Gruppe, z. B. <code>B.1_Kontoauszug Bank A.pdf</code>, <code>B.2_Kontoauszug Bank B.pdf</code>. Leer = ohne Präfix.</p>
      <div className="letters">
        {groups.groups.filter(g => g.category !== 'abschluss').map(g => (
          <label key={g.code} className="letter-row">
            <input className="w-xs mono" maxLength={4} value={l[g.code] ?? ''} onChange={e => setL({ ...l, [g.code]: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} aria-label={`Buchstabe ${g.name}`} />
            <span>{g.name}</span><span className="muted small">{g.subcategory}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
