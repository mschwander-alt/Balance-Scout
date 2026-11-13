import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bsb } from '../bridge';
import type { AccountRow, AuditResult, Best, DocRow, Status } from '../types';
import type { GroupsInfo, ReviewDecisions } from '../../electron/shared';
import { chf, date, pct } from '../format';
import { AutoTextarea, FLAG_LABEL, Info, Modal, Spinner, StatusBadge, WarnIcon, useToast } from '../components/ui';
import { DocumentPreview } from '../components/DocumentPreview';
import { Documents } from './Documents';
import { AuditAreas } from './AuditAreas';
import { IncomeAnalysisView } from './IncomeAnalysis';
import { useDragAutoScroll } from '../components/dragScroll';
import { LedgerView } from '../components/LedgerView';
import { FocusRail, GroupAnalysis, FocusBottom } from './FocusMode';
import { GroupPanel } from './GroupWorkspace';
import { AREA_ANALYSIS, areaStateLabel } from '../areas';
import { GENERAL_ACCOUNT, accountLabel, targetsOf, deriveView, groupAccounts, type ViewAccount, type ViewDoc } from '../review';

type Tab = 'konten' | 'erfolg' | 'belege' | 'gebiete' | 'saldobilanz' | 'diagnose';
const isER = (a: { category: string }) => a.category === 'aufwand' || a.category === 'ertrag' || a.category === 'abschluss';

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
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Erfolgsrechnung: Konten (wie Bilanz) oder Analyse (Staffel mit Margen, Vorjahr, Bemerkungen)
  const [erView, setErView] = useState<'konten' | 'analyse'>('analyse');
  // Reiter im Konto-Panel – bleibt beim Blättern ‹ › stehen (z. B. Konto für Konto durch die Kontoblätter)
  const [panelTab, setPanelTab] = useState<PanelTab>('beleg');
  // Fokus-Modus: Bilanz eingeklappt zur Kontoleiste – links vertiefte Prüfung, rechts das Konto, unten Kommentare und Dateien
  const [focus, setFocus] = useState(false);
  // Gruppen-Arbeitsbereich (Klick auf eine Gruppenzeile) und vorgewähltes Prüfgebiet im Reiter Prüfgebiete
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [areaPick, setAreaPick] = useState<string | null>(null);
  // Drag & Drop: Konto in eine andere Gruppe verschieben
  const [dragAcc, setDragAcc] = useState<string | null>(null);
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  // Beim Ziehen am Rand der Kontentabelle automatisch scrollen (auch von ganz oben nach ganz unten)
  const tableWrap = useRef<HTMLDivElement>(null);
  useDragAutoScroll(tableWrap, !!dragAcc);
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

  const view = useMemo(() => deriveView(result, decisions, groups?.groups ?? []), [result, decisions, groups]);
  const matchesSearch = (a: ViewAccount) => {
    const t = search.trim().toLowerCase();
    return !t || a.accountNumber.includes(t) || a.accountName.toLowerCase().includes(t) || (a.groupName ?? '').toLowerCase().includes(t);
  };
  const order = groups?.groups.map(g => g.code) ?? [];
  const er = tab === 'erfolg';
  const accounts = view.accounts.filter(a => (er ? isER(a) : !isER(a)) && (er || filter === 'ALLE' || a.status === filter) && matchesSearch(a));
  const erCount = view.accounts.filter(isER).length;
  const docs = useMemo(
    () => view.docs.filter(d => docFilter === 'alle' || (docFilter === 'zu' ? d.assigned : docFilter === 'offen' ? !d.assigned && !d.irrelevant : d.status !== 'ok')),
    [view.docs, docFilter],
  );
  const sel = view.accounts.find(a => a.accountNumber === open) ?? null;
  const openGroupInfo = openGroup ? (() => {
    const items = view.accounts.filter(a => a.groupCode === openGroup);
    const g = groups?.groups.find(x => x.code === openGroup);
    return g && items.length ? { code: g.code, name: g.name, items } : null;
  })() : null;
  const flatList = () => (grouped ? groupAccounts(accounts, order).flatMap(g => g.items) : accounts);
  const navInfo = (num: string) => {
    const list = flatList();
    const i = list.findIndex(a => a.accountNumber === num);
    const go = (d: number) => {
      const n = list[i + d];
      if (n) {
        setOpen(n.accountNumber);
        document.querySelector(`[data-konto="${n.accountNumber}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    return { pos: i + 1, count: list.length, prev: () => go(-1), next: () => go(1) };
  };
  const filed = (docId: string | null) => (docId ? result.filed?.[docId] : undefined);

  useEffect(() => {
    if (tab !== 'konten' && tab !== 'erfolg') return;
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') { if (focus) return setFocus(false); if (!open) return setOpenGroup(null); return setOpen(null); }
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
  }, [tab, accounts, open, grouped, order, focus]);

  const now = () => new Date().toISOString();
  const needVisum = () => visum.trim();
  const visumField = (
    <label className="field inline visum"><span>Visum</span>
      <input className="w-xs" value={visum} placeholder="Kürzel" aria-label="Visum" onChange={e => setVisum(e.target.value.toUpperCase().slice(0, 6))} onBlur={() => void bsb().app.saveSettings({ visum: visum.trim() })} />
    </label>
  );
  const accept = (a: ViewAccount) => update(d => ({ ...d, accepted: { ...d.accepted, [a.accountNumber]: { at: now(), visum: needVisum() } } }));
  const unaccept = (a: ViewAccount) => update(d => {
    const { [a.accountNumber]: _x, ...rest } = d.accepted ?? {};
    return { ...d, accepted: rest };
  });
  // Zuordnung: ein Konto, mehrere Konten (Array), null = nicht relevant, undefined = aufheben
  const assign = (docId: string, acc: string | string[] | null | undefined) => update(d => {
    const { [docId]: _x, ...rest } = d.assignments ?? {};
    if (acc === undefined || (Array.isArray(acc) && !acc.length)) return { ...d, assignments: rest };
    const list = Array.isArray(acc) ? acc : acc === null ? [] : [acc];
    return { ...d, assignments: { ...rest, [docId]: { accountNumber: list[0] ?? null, ...(list.length > 1 ? { accountNumbers: list } : {}), at: now(), visum: needVisum() } } };
  });
  // Vom Konto aus: Beleg zusätzlich diesem Konto zuordnen (bestehende manuelle Zuordnung bleibt)
  const assignAlso = (docId: string, num: string) => {
    const cur = decisions.assignments?.[docId];
    const prev = cur ? targetsOf(cur) : [];
    assign(docId, [...new Set([...prev, num])]);
  };
  const unassignFrom = (docId: string, num: string) => {
    const cur = decisions.assignments?.[docId];
    const next = cur ? targetsOf(cur).filter(n => n !== num) : [];
    assign(docId, next.length ? next : undefined);
  };
  /** Konto in eine Gruppe verschieben (Code) oder auf die automatische Gruppe zurücksetzen (null); Belege folgen dem Konto */
  const moveAccount = (num: string, code: string | null, quiet = false) => {
    const a = view.accounts.find(x => x.accountNumber === num);
    if (!a) return;
    const auto = a.autoGroup ? a.autoGroup.code : a.groupCode ?? null;
    // „Ohne Gruppe“ ('~') ist keine Gruppe des Kontenrahmens: nur als Rückkehr zur automatischen Gruppe möglich
    if (code === '~') {
      if (auto !== null) { toast('error', '„Ohne Gruppe“ ist keine Gruppe des KMU-Kontenrahmens – bitte eine Gruppe wählen.'); return; }
      code = null;
    }
    const target = code ?? auto;
    if (target === (a.groupCode ?? null)) return;
    const g = groups?.groups.find(x => x.code === target);
    update(d => {
      const { [num]: _old, ...rest } = d.groupOverrides ?? {};
      const next = code === null || code === auto ? rest : { ...rest, [num]: { groupCode: code, at: now(), visum: needVisum() } };
      return { ...d, groupOverrides: next };
    });
    const nDocs = view.docs.filter(x => x.accounts.includes(num)).length;
    if (!quiet) toast('ok', `Konto ${num} → ${g?.name ?? 'Ohne Gruppe'}${code === null || code === auto ? ' (automatische Gruppe)' : ''}${nDocs ? ` · ${nDocs} Beleg${nDocs > 1 ? 'e' : ''} mitgenommen` : ''}`);
  };
  const dnd: Dnd = {
    enabled: grouped && !!groups, dragging: dragAcc, over: dropGroup,
    start: num => setDragAcc(num), end: () => { setDragAcc(null); setDropGroup(null); },
    overGroup: code => setDropGroup(code),
    drop: code => { if (dragAcc) moveAccount(dragAcc, code); setDragAcc(null); setDropGroup(null); },
  };
  const setNote = (num: string, text: string) => update(d => {
    const { [num]: _x, ...rest } = d.notes ?? {};
    return { ...d, notes: text.trim() ? { ...rest, [num]: { text, at: now(), visum: needVisum() } } : rest };
  });

  /** Nachweis zum Konto hochladen: Datei lesen (inkl. Texterkennung), ins Belegverzeichnis aufnehmen und dem Konto zuordnen */
  const addEvidence = async (num: string, files: { path: string; name: string }[]) => {
    if (!id) return;
    needVisum();
    let n = 0;
    for (const f of files) {
      try {
        const doc = await bsb().review.addDocument(id, f.path);
        setResult(r => ({ ...r, documents: [...r.documents.filter(d => d.id !== doc.id), doc as unknown as AuditResult['documents'][number]] }));
        update(d => ({ ...d, assignments: { ...d.assignments, [doc.id]: { accountNumber: num, at: now(), visum: needVisum() } } }));
        n++;
      } catch (e) {
        toast('error', `${f.name}: ${(e as Error).message}`);
      }
    }
    if (n) toast('ok', `${n} Nachweis${n > 1 ? 'e' : ''} hochgeladen und Konto ${num} zugeordnet.`);
  };

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

  const sumItem = (k: Status | 'ALLE', dot: string, label: string, n: number | string) => (
    <button className={`sum-item ${filter === k && tab === 'konten' ? 'active' : ''}`} data-k={k} onClick={() => { setTab('konten'); setFilter(filter === k ? 'ALLE' : k); }}>
      {dot && <span className={`dot ${dot}`} />}<strong>{n}</strong> {label}
    </button>
  );

  return (
    <div className="page stack">
      <div className="review-head">
        <div className="title">
          <h1>{result.finalized ? 'Ergebnis' : 'Durchsicht'}</h1>
          <p>{result.finalized
            ? <>Abgeschlossen{result.finalizedAt ? ` am ${date(result.finalizedAt.slice(0, 10))}` : ''} · <span title={result.excelPath}>{result.excelPath.split(/[\\/]/).pop()}</span></>
            : 'Konten prüfen, Belege zuordnen, Notizen erfassen. Ablage und Excel entstehen beim Abschliessen.'}</p>
        </div>
        {visumField}
        <button className="btn" onClick={() => setShowLetters(true)}>Register …</button>
        {result.finalized ? (
          <>
            <button className="btn" onClick={() => bsb().app.showInFolder(result.excelPath)}>Zielordner</button>
            <button className="btn" onClick={() => setShowFinalize(true)} title="Nach weiteren Änderungen: neue Version der Dokumentation">Erneut abschliessen …</button>
            <button className="btn btn-primary" onClick={() => bsb().app.openPath(result.excelPath)}>Excel-Dokumentation öffnen</button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => setShowFinalize(true)}>Abschliessen …</button>
        )}
        {onRepeat && result.finalized && <button className="btn" onClick={onRepeat} title="Mit geänderten Unterlagen neu prüfen">Neu prüfen …</button>}
      </div>

      <div className="summary-line">
        {sumItem('ALLE', '', 'Konten', view.accounts.length)}
        <span className="sep" />
        {sumItem('BELEGT', 'ok', 'belegt', view.counts.BELEGT)}
        {sumItem('PRUEFEN', 'warn', 'prüfen', view.counts.PRUEFEN)}
        {sumItem('KEIN_NACHWEIS', 'bad', 'ohne Nachweis', view.counts.KEIN_NACHWEIS)}
        <span className="sep" />
        <button className="sum-item" data-k="belege" onClick={() => { setTab('belege'); setDocFilter(view.open.unassignedDocs ? 'offen' : 'alle'); }}>
          <strong>{view.docs.filter(d => d.assigned || d.irrelevant).length} / {view.docs.length}</strong> Belege zugeordnet
          {view.open.unassignedDocs > 0 && <span className="warn">({view.open.unassignedDocs} offen)</span>}
        </button>
        <span className="sep" />
        <span className="sum-item" style={{ cursor: 'default' }} title={`${chf(view.confirmedAbsTotal)} von ${chf(view.inScopeAbsTotal)}`}>Abdeckung <strong>{pct(view.coverage)}</strong>
          <Info label="Details zur Abdeckung"><dl><dt>Belegt</dt><dd>{chf(view.confirmedAbsTotal)}</dd><dt>Prüfumfang</dt><dd>{chf(view.inScopeAbsTotal)}</dd><dt>Texterkennung</dt><dd>{ocrDocs} Belege</dd><dt>Leseprobleme</dt><dd>{problemDocs} Belege</dd></dl></Info>
        </span>
        <input className="search" type="search" placeholder="Konto, Bezeichnung oder Gruppe suchen …" value={search} onChange={e => { setSearch(e.target.value); setTab('konten'); }} aria-label="Suchen" />
      </div>

      <nav className="tabs" role="tablist" style={{ padding: 0 }}>
        {([['konten', 'Bilanz'], ...(erCount ? [['erfolg', `Erfolgsrechnung`]] : []), ['belege', 'Belegverzeichnis'], ['gebiete', 'Prüfgebiete'], ['saldobilanz', 'Saldobilanz-Prüfung'], ['diagnose', 'Diagnosebericht']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => { if (k !== tab) setOpen(null); setTab(k); }}>{l}</button>
        ))}
      </nav>

      {tab === 'erfolg' && (
        <div className="seg er-view" role="tablist" aria-label="Ansicht Erfolgsrechnung">
          <button role="tab" className={erView === 'analyse' ? 'active' : ''} onClick={() => setErView('analyse')}>Analyse (Staffel, Margen, Vorjahr)</button>
          <button role="tab" className={erView === 'konten' ? 'active' : ''} onClick={() => setErView('konten')}>Konten</button>
        </div>
      )}
      {tab === 'erfolg' && erView === 'analyse' && id && (
        <IncomeAnalysisView historyId={id} decisions={decisions} update={update} visum={visum} closingDate={result.input?.closingDate ?? null} onMoveGroup={moveAccount} />
      )}
      {(tab === 'konten' || (tab === 'erfolg' && erView === 'konten')) && focus && sel && id && (
        <div className="focus-layout">
          <FocusRail groups={grouped ? groupAccounts(accounts, order) : [{ code: '', name: 'Alle Konten', items: accounts }]} open={open} setOpen={setOpen}
            letters={decisions.groupLetters ?? groups?.letters ?? {}} onExit={() => setFocus(false)} />
          <GroupAnalysis sel={sel} group={groupAccounts(view.accounts.filter(a => isER(a) === isER(sel)), order).find(g => g.code === (sel.groupCode ?? ''))}
            historyId={id} decisions={decisions} update={update} docs={view.docs} letter={(decisions.groupLetters ?? groups?.letters ?? {})[sel.groupCode ?? ''] ?? ''}
            rates={result.fxRates?.rates ?? result.input?.fxRates?.rates ?? {}} visum={visum} closingDate={result.input?.closingDate ?? null} onMoveGroup={moveAccount} />
          <AccountPanel
            key={sel.accountNumber} a={sel} docs={view.docs} filedPath={filed(sel.docId)?.placement?.newPath ?? null}
            note={decisions.notes?.[sel.accountNumber]} accepted={decisions.accepted?.[sel.accountNumber]}
            nav={navInfo(sel.accountNumber)}
            onAccept={() => accept(sel)} onUnaccept={() => unaccept(sel)} onNote={t => setNote(sel.accountNumber, t)}
            onAssign={docId => assignAlso(docId, sel.accountNumber)} onUnassign={docId => unassignFrom(docId, sel.accountNumber)} onClose={() => setFocus(false)}
            groupOptions={groups?.groups ?? []} onGroup={code => moveAccount(sel.accountNumber, code)}
            tab={panelTab} onTab={setPanelTab} historyId={id} focus onFocus={() => setFocus(false)} hideNote
          />
          <FocusBottom sel={sel} groupCode={sel.groupCode ?? ''} letter={(decisions.groupLetters ?? groups?.letters ?? {})[sel.groupCode ?? ''] ?? ''}
            decisions={decisions} update={update} docs={view.docs} visum={visum} onNote={t => setNote(sel.accountNumber, t)}
            onAddEvidence={files => addEvidence(sel.accountNumber, files)} />
        </div>
      )}
      {(tab === 'konten' || (tab === 'erfolg' && erView === 'konten')) && !(focus && sel && id) && (
        <div className={`result-layout ${sel || openGroupInfo ? 'withpreview' : 'nopanel'}`}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row small" style={{ justifyContent: 'space-between' }}>
              <span className="muted">{er ? `${accounts.length} Konten der Erfolgsrechnung – Analyse von Vorjahr und Veränderung (keine Saldennachweise nötig)` : filter !== 'ALLE' || search ? `${accounts.length} von ${view.accounts.filter(a => !isER(a)).length} Konten` : ''}{!er && filter !== 'ALLE' && <> · <button className="link" onClick={() => setFilter('ALLE')}>Filter aufheben</button></>}</span>
              <span className="row" style={{ gap: 12 }}>
                {grouped && !er && <span className="muted small" title="Konto mit der Maus auf eine andere Gruppe ziehen – zugeordnete Belege werden mitgenommen. Im Konto rechts auch über „Gruppe“ wählbar.">Konto per Drag &amp; Drop in eine andere Gruppe ziehen</span>}
                {grouped && <button className="link small" onClick={() => setCollapsed(c => (c.size ? new Set() : new Set(groupAccounts(accounts, order).map(g => g.code))))}>{collapsed.size ? 'Alle aufklappen' : 'Alle zuklappen'}</button>}
                <label className="muted"><input type="checkbox" checked={grouped} onChange={e => setGrouped(e.target.checked)} /> nach KMU-Kontenrahmen gruppieren</label>
              </span>
            </div>
            <div className="table-wrap" ref={tableWrap}>
              <table className={`grid clickable konten ${er ? 'er' : ''}`}>
                <thead><tr><th>Konto</th><th>Bezeichnung</th><th className="num">Aktuell</th><th className="num">Vorjahr</th><th className="num dchf" title="Veränderung des Betrags (bei Passiven und Ertrag: Zunahme = +)">Δ CHF</th><th className="num">Δ %</th><th>Status</th><th>Beleg</th></tr></thead>
                <tbody>
                  {(grouped ? withTotals(groupAccounts(accounts, order)) : [{ code: '', name: '', items: accounts, total: 0 }]).map(g =>
                    'totalOf' in g ? (
                      <tr key={`t-${g.totalOf}`} className="total-row">
                        <td colSpan={2}>{g.name}</td>
                        <td className="num">{chf(g.cy)}</td><td className="num">{chf(g.vj)}</td>
                        <Delta cy={g.cy} vj={g.vj} />
                        <td colSpan={2} />
                      </tr>
                    ) : (
                      <GroupRows key={g.code || 'alle'} g={g} grouped={grouped} collapsed={collapsed.has(g.code)}
                        onToggle={() => setCollapsed(c => { const n = new Set(c); if (n.has(g.code)) n.delete(g.code); else n.add(g.code); return n; })}
                        letter={decisions.groupLetters?.[g.code]} open={open} setOpen={setOpen} docs={view.docs} notes={decisions.notes ?? {}} dnd={dnd}
                        groupOpen={openGroup === g.code && !sel} onOpenGroup={() => { setOpen(null); setOpenGroup(g.code); }} areaState={decisions.areaStatus?.[g.code]?.status} hasAnalysis={!!AREA_ANALYSIS[g.code]} />
                    ),
                  )}
                </tbody>
              </table>
            </div>
          </div>
          {sel && (
            <AccountPanel
              key={sel.accountNumber} a={sel} docs={view.docs} filedPath={filed(sel.docId)?.placement?.newPath ?? null}
              note={decisions.notes?.[sel.accountNumber]} accepted={decisions.accepted?.[sel.accountNumber]}
              nav={navInfo(sel.accountNumber)}
              onAccept={() => accept(sel)} onUnaccept={() => unaccept(sel)} onNote={t => setNote(sel.accountNumber, t)}
              onAssign={docId => assignAlso(docId, sel.accountNumber)} onUnassign={docId => unassignFrom(docId, sel.accountNumber)} onClose={() => setOpen(null)}
              groupOptions={groups?.groups ?? []} onGroup={code => moveAccount(sel.accountNumber, code)}
              tab={panelTab} onTab={setPanelTab} historyId={id} onFocus={id ? () => setFocus(true) : undefined}
            />
          )}
          {!sel && openGroupInfo && (
            <GroupPanel key={openGroupInfo.code} code={openGroupInfo.code} name={openGroupInfo.name} items={openGroupInfo.items} allAccounts={view.accounts} docs={view.docs}
              decisions={decisions} update={update} visum={visum} onOpenAccount={n => setOpen(n)} onClose={() => setOpenGroup(null)}
              onDeepen={id && openGroupInfo.items.length ? () => { setOpen(openGroupInfo.items[0]!.accountNumber); setFocus(true); } : undefined}
              onAreas={() => { setAreaPick(openGroupInfo.code); setOpen(null); setTab('gebiete'); }} />
          )}
        </div>
      )}

      {tab === 'belege' && (
        <Documents docs={view.docs} accounts={view.accounts} filed={result.filed} initialFilter={docFilter === 'offen' ? 'offen' : undefined} onAssign={(id, n) => assign(id, n)} />
      )}

      {tab === 'gebiete' && (
        <AuditAreas key={areaPick ?? 'uebersicht'} historyId={id} accounts={view.accounts} docs={view.docs} groups={groups} decisions={decisions} update={update} closingDate={result.input?.closingDate ?? null} rates={result.fxRates?.rates ?? result.input?.fxRates?.rates}
          initialArea={areaPick} visum={visum}
          onOpenGroup={code => { setAreaPick(null); setOpen(null); if (code === 'ER') { setTab('erfolg'); setErView('analyse'); } else { setTab('konten'); setOpenGroup(code); setCollapsed(c => { const n = new Set(c); n.delete(code); return n; }); setTimeout(() => document.querySelector(`[data-gruppe="${code}"]`)?.scrollIntoView({ block: 'center' }), 50); } }} />
      )}

      {tab === 'saldobilanz' && (
        <div className="card stack">
          {result.trialBalance && result.trialBalance.parts.length > 0 && (
            <p className="small">Gelesen: {result.trialBalance.parts.map(p => `${p.label} (${p.status === 'ok' ? `${p.accountCount} Konten` : p.status})`).join(' · ')}
              {result.ledger && <> · Kontoblätter: {result.ledger.accounts} Konten ({result.ledger.fxAccounts} in Fremdwährung)</>}
              {result.fxRates && <> · Kurse: {result.fxRates.source}</>}
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

type Group = { code: string; name: string; items: ViewAccount[]; total: number };
type TotalRow = { totalOf: string; name: string; cy: number; vj: number };
const TOTAL_LABEL: Record<string, string> = { aktiven: 'Total Aktiven', passiven: 'Total Passiven', erfolg: 'Jahresergebnis' };
const catOf = (g: Group) => { const c = g.items[0]?.category ?? ''; return c === 'aufwand' || c === 'ertrag' ? 'erfolg' : c; };
/** Nach den Gruppen einer Kategorie eine Totalzeile einfügen (Aktiven, Passiven, Erfolgsrechnung) */
function withTotals(groups: Group[]): (Group | TotalRow)[] {
  const out: (Group | TotalRow)[] = [];
  groups.forEach((g, i) => {
    out.push(g);
    const c = catOf(g);
    const next = groups[i + 1];
    if (TOTAL_LABEL[c] && (!next || catOf(next) !== c)) {
      const items = groups.filter(x => catOf(x) === c).flatMap(x => x.items);
      const cy0 = groups.filter(x => catOf(x) === c).flatMap(x => x.items).reduce((a, x) => a + x.balance, 0);
      const label = c === 'erfolg' ? (cy0 < 0 ? 'Jahresgewinn (Haben-Saldo)' : cy0 > 0 ? 'Jahresverlust (Soll-Saldo)' : 'Jahresergebnis') : TOTAL_LABEL[c]!;
      out.push({ totalOf: c, name: label, cy: items.reduce((a, x) => a + x.balance, 0), vj: items.reduce((a, x) => a + (x.balancePreviousYear ?? 0), 0) });
    }
  });
  return out;
}

function Delta({ cy, vj }: { cy: number; vj: number | null }) {
  if (vj === null) return <><td className="num muted dchf">–</td><td className="num muted">–</td></>;
  // Veränderung des Betrags: bei Haben-Salden (Passiven, Ertrag) bedeutet ein grösserer negativer Saldo eine Zunahme
  const sameSign = (cy <= 0 && vj <= 0) || (cy >= 0 && vj >= 0);
  const d = sameSign ? Math.abs(cy) - Math.abs(vj) : cy - vj;
  const p = vj !== 0 ? d / Math.abs(vj) : null;
  // Auffällig nur bei grosser relativer UND absoluter Veränderung
  const big = p !== null && Math.abs(p) >= 0.25 && Math.abs(d) >= 1_000_00;
  return (
    <>
      <td className="num dchf">{d === 0 ? '–' : `${d > 0 ? '+' : ''}${chf(d)}`}</td>
      <td className={`num ${big ? 'delta-big' : ''}`} title={d === 0 ? '' : `Veränderung ${d > 0 ? '+' : ''}${chf(d)}`}>{p === null ? (d === 0 ? '–' : 'neu') : `${p > 0 ? '+' : ''}${(p * 100).toFixed(1)} %`}</td>
    </>
  );
}

/** Fremdwährung: Hinweis nur bei Problemen (Kurs fehlt, Bewertungsdifferenz, Kontoblatt ≠ Saldobilanz) */
function fxProblem(a: { fx?: AccountRow['fx'] }): string | null {
  const f = a.fx;
  if (!f) return null;
  if (f.currency !== 'CHF' && f.rate === null) return `Konto in ${f.currency} – Kurs per Stichtag fehlt`;
  if (f.valuationDiff !== null && Math.abs(f.valuationDiff) >= 100) return `Bewertungsdifferenz CHF ${chf(f.valuationDiff)} (Buchwert − ${f.currency} ${chf(f.closing ?? 0)} × ${f.rate})`;
  if (f.tbDiff) return `Kontoblatt weicht von der Saldobilanz ab: CHF ${chf(f.tbDiff)}`;
  return null;
}

const GROUP_CATS: [string, string][] = [['aktiven', 'Aktiven'], ['passiven', 'Passiven'], ['aufwand', 'Aufwand'], ['ertrag', 'Ertrag'], ['abschluss', 'Abschluss']];

const PROBLEM_FLAGS = new Set(['SIGN_CONFLICT', 'AMBIGUOUS', 'CURRENCY_MISMATCH', 'DATE_MISMATCH']);

/** Drag & Drop der Konten zwischen Gruppen */
type Dnd = { enabled: boolean; dragging: string | null; over: string | null; start: (num: string) => void; end: () => void; overGroup: (code: string) => void; drop: (code: string) => void };

function GroupRows({ g, grouped, collapsed, onToggle, letter, open, setOpen, docs, notes, dnd, groupOpen = false, onOpenGroup, areaState, hasAnalysis = false }: {
  g: Group; grouped: boolean; collapsed: boolean; onToggle: () => void; letter?: string; open: string | null;
  setOpen: (n: string) => void; docs: ViewDoc[]; notes: Record<string, unknown>; dnd?: Dnd;
  /** Gruppen-Arbeitsbereich offen / öffnen; Status des Prüfgebiets */
  groupOpen?: boolean; onOpenGroup?: () => void; areaState?: import('../../electron/shared').AreaState; hasAnalysis?: boolean;
}) {
  // Ziel: Gruppenzeile und alle Konten der Gruppe
  const target = dnd?.enabled && dnd.dragging ? {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dnd.over !== g.code) dnd.overGroup(g.code); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); dnd.drop(g.code); },
  } : {};
  const isOver = !!dnd?.dragging && dnd.over === g.code;
  const docBy = new Map(docs.map(d => [d.id, d]));
  const vj = g.items.reduce((a, x) => a + (x.balancePreviousYear ?? 0), 0);
  const hasVj = g.items.some(x => x.balancePreviousYear !== null);
  const nDocs = new Set(g.items.map(a => (a.status === 'BELEGT' || a.status === 'PRUEFEN' ? a.docId : null)).filter(Boolean)).size;
  return (
    <>
      {grouped && (
        <tr className={`group-row ${isOver ? 'drop-target' : ''} ${groupOpen ? 'selected' : ''}`} onClick={onOpenGroup ?? onToggle} aria-expanded={!collapsed} data-gruppe={g.code} {...target}
          title={onOpenGroup ? 'Klick: Gruppen-Arbeitsbereich öffnen · Pfeil: auf-/zuklappen' : undefined}>
          <td colSpan={2}><button className="caret" aria-label={collapsed ? `${g.name} aufklappen` : `${g.name} zuklappen`} onClick={e => { e.stopPropagation(); onToggle(); }}>{collapsed ? '›' : '⌄'}</button>{letter ? <span className="register">{letter}</span> : null} {g.name}</td>
          <td className="num">{chf(g.total)}</td>
          <td className="num">{hasVj ? chf(vj) : ''}</td>
          <Delta cy={g.total} vj={hasVj ? vj : null} />
          <td className="small muted" title={`${g.items.length} Konten, ${nDocs} Belege`}>{areaState || hasAnalysis ? <span className={`area-chip st-${areaState ?? 'offen'}`} data-areastatus={areaState ?? 'offen'}>{hasAnalysis ? 'Analyse · ' : ''}{areaStateLabel(areaState ?? 'offen')}</span> : g.items.length}</td>
          <td className="small muted">{nDocs || ''}</td>
        </tr>
      )}
      {!collapsed && g.items.map(a => {
        const doc = a.docId ? docBy.get(a.docId) : undefined;
        const hasDoc = (a.status === 'BELEGT' || a.status === 'PRUEFEN') && doc;
        const problems = (a.best?.flags ?? []).filter(f => PROBLEM_FLAGS.has(f)).map(f => FLAG_LABEL[f] ?? f);
        const quiet = a.status === 'NULLSALDO' || a.status === 'NICHT_IM_UMFANG';
        return (
          <tr key={a.accountNumber} data-konto={a.accountNumber} className={`${open === a.accountNumber ? 'selected' : ''} ${quiet ? 'muted-row' : ''} ${isOver ? 'drop-target' : ''} ${dnd?.dragging === a.accountNumber ? 'dragging' : ''}`} onClick={() => setOpen(a.accountNumber)}
            draggable={dnd?.enabled || undefined} {...target}
            onDragStart={dnd?.enabled ? e => { e.dataTransfer.setData('text/plain', a.accountNumber); e.dataTransfer.effectAllowed = 'move'; dnd.start(a.accountNumber); } : undefined}
            onDragEnd={dnd?.enabled ? () => dnd.end() : undefined}>
            <td>{a.accountNumber}</td>
            <td title={a.accountName}>{a.accountName}{notes[a.accountNumber] ? <span className="flag note" title="Notiz vorhanden">Notiz</span> : null}{a.groupSource === 'bezeichnung' && <WarnIcon text={`Gruppe „${a.groupName}“ aus der Bezeichnung abgeleitet – bitte prüfen`} />}{a.groupSource === 'manuell' && <span className="flag moved" title={`vom Prüfer verschoben (automatisch: ${a.autoGroup?.name ?? 'Ohne Gruppe'})`}>verschoben</span>}</td>
            <td className="num">{chf(a.balance)}{a.fx && a.fx.currency !== 'CHF' && a.fx.closing !== null && <div className="fx-sub">{a.fx.currency} {chf(a.fx.closing)}</div>}</td>
            <td className="num">{a.balancePreviousYear === null ? '' : chf(a.balancePreviousYear)}</td>
            <Delta cy={a.balance} vj={a.balancePreviousYear} />
            <td><StatusBadge status={a.status} />{fxProblem(a) && <WarnIcon text={fxProblem(a)!} />}{a.manual && <span className="manual" title={a.manual === 'akzeptiert' ? 'manuell akzeptiert' : 'Beleg manuell zugeordnet'}> ✓</span>}{problems.length > 0 && <WarnIcon text={problems.join(', ')} />}</td>
            <td>{hasDoc ? <span className="reg-link" title={doc!.filename}>{doc!.register ?? doc!.filename.slice(0, 18)}</span> : <span className="muted">–</span>}</td>
          </tr>
        );
      })}
    </>
  );
}

function AccountSelect({ accounts, value, onChange, irrelevantOption = true }: { accounts: ViewAccount[]; value: string; onChange: (v: string | null | undefined) => void; irrelevantOption?: boolean }) {
  return (
    <select className="assign" value={value} onClick={e => e.stopPropagation()} onChange={e => onChange(e.target.value === '' ? undefined : e.target.value === '__none' ? null : e.target.value)}>
      <option value="">– automatisch / nicht zugeordnet –</option>
      <option value={GENERAL_ACCOUNT}>Allgemeine Prüfungen (Register A)</option>
      {irrelevantOption && <option value="__none">Nicht relevant (keinem Konto)</option>}
      {accounts.map(a => <option key={a.accountNumber} value={a.accountNumber}>{a.accountNumber} {a.accountName}{a.status === 'KEIN_NACHWEIS' ? ' (ohne Nachweis)' : ''}</option>)}
    </select>
  );
}

function DocInfo({ d }: { d: ViewDoc | DocRow }) {
  const read = d.status === 'ok' ? 'vollständig' : d.status === 'partial' ? 'teilweise' : d.status === 'unsupported' ? 'nicht unterstützt' : 'nicht lesbar';
  return (
    <Info label="Details zum Beleg">
      <dl>
        <dt>Ablageort</dt><dd>{d.relPath}</dd>
        <dt>Belegart</dt><dd>{d.docType}</dd>
        <dt>Stichtag</dt><dd>{date(d.balanceDate)}</dd>
        <dt>Gelesen</dt><dd>{read} · {d.pageCount} S.</dd>
        {d.ocrPages > 0 && <><dt>Texterkennung</dt><dd>{d.ocrPages} S., Sicherheit {d.ocrConfidence ?? '–'} %</dd></>}
        <dt>Beträge</dt><dd>{d.amountCount}</dd>
      </dl>
    </Info>
  );
}

function DocLine({ d, accounts, filedInfo, onAssign }: { d: ViewDoc; accounts: ViewAccount[]; filedInfo?: { placement: { status: string; newPath: string | null; message: string | null } | null; notePath: string | null; register: string | null; irrelevant: boolean }; onAssign: (n: string | null | undefined) => void }) {
  const value = d.manualAssignment ? (d.irrelevant ? '__none' : d.accounts[0] ?? '') : '';
  const pl = filedInfo?.placement;
  const problem = d.status !== 'ok' || (d.ocrPages > 0 && (d.ocrConfidence ?? 100) < 60) || pl?.status === 'fehler';
  const problemText = [d.status !== 'ok' ? 'nicht vollständig gelesen' : '', d.ocrPages > 0 && (d.ocrConfidence ?? 100) < 60 ? `schlechte Texterkennung (${d.ocrConfidence} %)` : '', ...d.warnings, pl?.status === 'fehler' ? `Ablage: ${pl.message}` : ''].filter(Boolean).join(' · ');
  return (
    <tr data-beleg={d.relPath}>
      <td>{d.register && <span className="register sm">{d.register}</span>}{d.filename}<DocInfo d={d} />{problem && <WarnIcon text={problemText} />}</td>
      <td>
        {d.assigned ? <span>{d.accounts.map(accountLabel).join(', ')}</span> : d.irrelevant ? <span className="muted">nicht relevant</span> : <span className="badge badge-kein_nachweis">ohne Zuordnung</span>}
        {d.manualAssignment && <span className="manual"> ✓ manuell</span>}
      </td>
      <td><AccountSelect accounts={accounts} value={value} onChange={onAssign} /></td>
      <td className="small muted">{pl ? <span title={pl.newPath ?? ''}>{pl.status}{filedInfo?.notePath ? ' · mit Notiz' : ''}</span> : 'beim Abschliessen'}</td>
      <td className="actions"><button className="btn btn-sm" onClick={() => bsb().app.openPath(pl?.newPath ?? d.absPath)}>Öffnen</button></td>
    </tr>
  );
}

type PanelTab = 'beleg' | 'kontoblatt';
const PANEL_TABS: [PanelTab, string][] = [['beleg', 'Beleg'], ['kontoblatt', 'Kontoblatt']];

function AccountPanel({ a, docs, filedPath, note, accepted, nav, onAccept, onUnaccept, onNote, onAssign, onUnassign, onClose, groupOptions = [], onGroup, tab = 'beleg', onTab, historyId, focus = false, onFocus, hideNote = false }: {
  a: ViewAccount; docs: ViewDoc[]; filedPath: string | null; note?: { text: string; at: string; visum: string }; accepted?: { visum: string; at: string; comment?: string };
  nav: { pos: number; count: number; prev: () => void; next: () => void };
  onAccept: () => void; onUnaccept: () => void; onNote: (t: string) => void; onAssign: (docId: string) => void; onUnassign: (docId: string) => void; onClose: () => void;
  /** Gruppe ändern (Code) bzw. zurücksetzen (null) */
  groupOptions?: { code: string; name: string; category: string }[]; onGroup?: (code: string | null) => void;
  tab?: PanelTab; onTab?: (t: PanelTab) => void; historyId?: string;
  /** Fokus-Modus ein-/ausschalten; im Fokus-Modus steht die Notiz unten */
  focus?: boolean; onFocus?: () => void; hideNote?: boolean;
}) {
  const found = a.autoStatus === 'BELEGT' || a.autoStatus === 'PRUEFEN';
  const all: Best[] = found && a.best ? [a.best, ...a.candidates] : a.candidates;
  const [idx, setIdx] = useState(0);
  const [noteText, setNoteText] = useState(note?.text ?? '');
  const [showNote, setShowNote] = useState(!!note?.text);
  const [showAssign, setShowAssign] = useState(false);
  const manualDoc = a.manual === 'zugeordnet' ? docs.find(d => d.id === a.docId) : undefined;
  const c = manualDoc ? undefined : all[idx];
  const file = manualDoc ? manualDoc.absPath : c ? c.newPath ?? c.absPath : null;
  const doc = docs.find(d => d.id === (manualDoc?.id ?? c?.documentId));
  // Auch bereits zugeordnete Belege wählbar (ein Beleg kann mehrere Konten belegen, z. B. OP-Liste für 1100 und 1101)
  const candidatesToAssign = docs.filter(d => !d.irrelevant && !d.accounts.includes(a.accountNumber))
    .sort((x, y) => Number(x.assigned) - Number(y.assigned) || x.relPath.localeCompare(y.relPath, 'de'));
  // Nur bei Problemen sichtbar
  const problems: string[] = [];
  if (a.status === 'PRUEFEN' || a.status === 'KEIN_NACHWEIS') problems.push(...a.reasons.filter(r => !/Texterkennung|Scan/i.test(r)));
  if (c && c.differenceCents !== 0 && Number.isFinite(c.differenceCents)) problems.push(`Differenz zum Saldo: ${chf(c.differenceCents)}`);
  if (c) problems.push(...c.flags.filter(f => PROBLEM_FLAGS.has(f)).map(f => FLAG_LABEL[f] ?? f));
  if (doc && doc.ocrPages > 0 && (doc.ocrConfidence ?? 100) < 60) problems.push(`Schlechte Texterkennung (${doc.ocrConfidence} %) – Betrag mit dem Original vergleichen`);
  const fxp = fxProblem(a);
  const uniq = [...new Set(problems)].filter(() => !(a.manual && a.status === 'BELEGT'));
  if (fxp) uniq.push(fxp);
  return (
    <aside className="panel preview-panel">
      <div className="panel-title">
        <h3>{a.accountNumber} · {a.accountName}</h3>
        <StatusBadge status={a.status} />
        {a.manual && <span className="manual">✓ {a.manual === 'akzeptiert' ? 'akzeptiert' : 'manuell zugeordnet'}</span>}
        <span className="panel-nav">
          <button aria-label="vorheriges Konto" onClick={nav.prev} disabled={nav.pos <= 1}>‹</button>
          <span className="small">{nav.pos} / {nav.count}</span>
          <button aria-label="nächstes Konto" onClick={nav.next} disabled={nav.pos >= nav.count}>›</button>
          {onFocus && <button className="focus-toggle" aria-label={focus ? 'Fokus-Modus beenden' : 'Fokus-Modus'} title={focus ? 'Bilanz wieder einblenden' : 'Fokus-Modus: Bilanz einklappen, vertiefte Prüfung links, Konto rechts, Kommentare unten'} onClick={onFocus}>{focus ? '⤡' : '⤢ Fokus'}</button>}
          <button aria-label="Schliessen (Esc)" onClick={onClose}>✕</button>
        </span>
      </div>
      {onGroup && groupOptions.length > 0 && (
        <div className="group-line small">
          <span className="muted">Gruppe</span>
          <select value={a.groupCode ?? ''} aria-label="Gruppe des Kontos" onChange={e => onGroup(e.target.value || null)}>
            {!a.groupCode && <option value="">Ohne Gruppe (nicht im KMU-Kontenrahmen)</option>}
            {GROUP_CATS.map(([cat, label]) => (
              <optgroup key={cat} label={label}>
                {groupOptions.filter(g => g.category === cat).map(g => <option key={g.code} value={g.code}>{g.name}</option>)}
              </optgroup>
            ))}
          </select>
          {a.groupSource === 'manuell' && <button className="link" onClick={() => onGroup(null)} title={`Automatisch: ${a.autoGroup?.name ?? 'Ohne Gruppe'}`}>zurücksetzen</button>}
        </div>
      )}
      {onTab && (
        <nav className="tabs panel-tabs" role="tablist" aria-label="Ansicht Konto">
          {PANEL_TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => onTab(k)}>{l}</button>)}
        </nav>
      )}
      {tab === 'kontoblatt' && historyId && <LedgerView historyId={historyId} accountNumber={a.accountNumber} />}
      {tab === 'beleg' && (<>
      <div className="doc-line small">
        {doc ? <>{doc.register && <span className="register">{doc.register}</span>}<span>{doc.filename}</span></> : <span>Kein Beleg</span>}
        <Info label="Details zur Fundstelle">
          <dl>
            <dt>Saldo</dt><dd>{chf(a.balance)}{a.balancePreviousYear !== null ? ` (VJ ${chf(a.balancePreviousYear)})` : ''}</dd>
            <dt>Gruppe</dt><dd>{a.groupName ?? '–'}{a.groupSource === 'bezeichnung' ? ' (aus Bezeichnung)' : ''}</dd>
            {a.source && <><dt>Saldobilanz</dt><dd>{a.source}</dd></>}
            {doc && <><dt>Ablageort</dt><dd>{doc.relPath}</dd></>}
            {c && <><dt>Fundstelle</dt><dd>{c.pageLabel ?? `Seite ${c.page}`}, Zeile {c.lineNo}</dd>
              <dt>Wortlaut</dt><dd>{c.line}</dd>
              <dt>Wert im Beleg</dt><dd>{chf(c.evidenceCents)}</dd>
              <dt>Herkunft</dt><dd>{c.source === 'text-layer' ? 'Textebene' : `Texterkennung${doc?.ocrConfidence ? ` (${doc.ocrConfidence} %)` : ''}`}</dd>
              <dt>Punktzahl</dt><dd>{c.score}</dd></>}
            {accepted && <><dt>Akzeptiert</dt><dd>{accepted.visum || '–'}, {date(accepted.at.slice(0, 10))}</dd></>}
          </dl>
          {c && c.reasons.length > 0 && <ul>{c.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        </Info>
        {file && <button className="link small ml-auto" onClick={() => bsb().app.openPath(filedPath ?? file)}>Beleg öffnen</button>}
      </div>

      {a.fx && a.fx.currency !== 'CHF' && (
        <div className="fx-line small">
          <span>Saldo <strong>{a.fx.currency} {a.fx.closing === null ? '–' : chf(a.fx.closing)}</strong></span>
          <span>Kurs {a.fx.rate ?? '–'}</span>
          <span>CHF zum Kurs {a.fx.chfAtRate === null ? '–' : chf(a.fx.chfAtRate)}</span>
          <span className={a.fx.valuationDiff && Math.abs(a.fx.valuationDiff) >= 100 ? 'delta-big' : ''}>Bewertungsdifferenz {a.fx.valuationDiff === null ? '–' : chf(a.fx.valuationDiff)}</span>
          <Info label="Zur Fremdwährung"><dl><dt>Kontowährung</dt><dd>{a.fx.currency} (laut Kontoblatt)</dd><dt>Saldovortrag</dt><dd>{a.fx.opening === null ? '–' : `${a.fx.currency} ${chf(a.fx.opening)}`}</dd><dt>Kurs</dt><dd>{a.fx.rateSource ?? 'nicht erfasst'}</dd><dt>Abgleich</dt><dd>Der Nachweis wird in {a.fx.currency} abgeglichen; die Bewertung vergleicht den Buchwert in CHF mit Saldo × Kurs.</dd>{!a.fx.consistent && <><dt>Kontoblatt</dt><dd>Saldovortrag + Buchungen ≠ Schlusssaldo – Kontoblatt prüfen</dd></>}</dl></Info>
        </div>
      )}
      <div className="actions-row">
        {a.autoStatus === 'PRUEFEN' && a.manual !== 'zugeordnet' && (a.manual === 'akzeptiert'
          ? <button className="btn on" onClick={onUnaccept} title="Akzeptieren rückgängig machen">✓ Akzeptiert · rückgängig</button>
          : <button className="btn btn-ok" onClick={onAccept}>✓ Akzeptieren</button>)}
        {manualDoc
          ? <button className="btn" onClick={() => onUnassign(manualDoc.id)}>Zuordnung aufheben</button>
          : (a.status === 'KEIN_NACHWEIS' || a.status === 'PRUEFEN') && candidatesToAssign.length > 0 && <button className={`btn ${showAssign ? 'on' : ''}`} onClick={() => setShowAssign(v => !v)}>Beleg zuordnen</button>}
        {!hideNote && <button className={`btn ${showNote ? 'on' : ''}`} onClick={() => setShowNote(v => !v)}>Notiz{note?.text ? ' ✓' : ''}</button>}
      </div>
      {showAssign && !manualDoc && (
        <select className="assign" style={{ maxWidth: '100%' }} value="" onChange={e => { if (e.target.value) { onAssign(e.target.value); setShowAssign(false); } }}>
          <option value="">– Beleg wählen –</option>
          {candidatesToAssign.map(d => <option key={d.id} value={d.id}>{d.relPath}{d.assigned ? ` (bereits: ${d.accounts.map(accountLabel).join(', ')})` : ''}</option>)}
        </select>
      )}
      {showNote && !hideNote && (
        <div className="note-field">
          <AutoTextarea minRows={2} maxLength={500} value={noteText} onChange={e => setNoteText(e.target.value)} onBlur={() => noteText !== (note?.text ?? '') && onNote(noteText)} placeholder="z. B. Saldo mit Bankbestätigung abgestimmt." autoFocus={!note?.text} />
          <div className="note-meta"><span>{a.docId ? 'Wird dem Beleg als erste Seite vorangestellt.' : 'Erscheint in der Excel-Dokumentation.'}</span><span>{note ? `${note.visum || '–'}, ${date(note.at.slice(0, 10))} · ` : ''}{noteText.length} / 500</span></div>
        </div>
      )}

      {uniq.length > 0 && <div className="problem"><ul>{uniq.map((r, i) => <li key={i}>{r}</li>)}</ul></div>}

      {!manualDoc && all.length > 1 && (
        <div className="row filter">
          {all.map((x, i) => (
            <button key={i} className={`chip ${i === idx ? 'active' : ''}`} onClick={() => setIdx(i)} title={`${x.relPath ?? x.filename}: ${x.line}`}>
              {i === 0 && found ? 'Fundstelle' : `Alternative ${found ? i : i + 1}`}
            </button>
          ))}
        </div>
      )}
      {file ? (
        <DocumentPreview file={file} page={c?.page ?? 1} lineNo={c?.lineNo ?? 0} bbox={c?.bbox} line={c?.line ?? ''} />
      ) : (
        <p className="muted">{a.status === 'KEIN_NACHWEIS' ? 'Kein passender Betrag in den Unterlagen gefunden.' : 'Für dieses Konto ist kein Nachweis nötig.'}</p>
      )}
      </>)}
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
      <p className="small muted">Abgelegte Belege erhalten vorne Buchstabe und Zähler der Gruppe, z. B. <code>B.1_Kontoauszug Bank A.pdf</code>, <code>B.2_Kontoauszug Bank B.pdf</code>. Leer = ohne Präfix. Mehrere Gruppen dürfen denselben Buchstaben haben (z. B. G für IC-Forderungen und IC-Verbindlichkeiten).</p>
      <div className="letters">
        {groups.general && (
          <label className="letter-row">
            <input className="w-xs mono" maxLength={4} value={l[groups.general.code] ?? ''} onChange={e => setL({ ...l, [groups.general!.code]: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} aria-label="Buchstabe Allgemeine Prüfungen" />
            <span>{groups.general.name}</span><span className="muted small">Allgemein</span>
          </label>
        )}
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
