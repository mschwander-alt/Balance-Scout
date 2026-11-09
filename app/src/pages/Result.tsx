import { useCallback, useEffect, useMemo, useState } from 'react';
import { bsb } from '../bridge';
import type { AuditResult, Best, DocRow, Status } from '../types';
import type { GroupsInfo, ReviewDecisions } from '../../electron/shared';
import { chf, date, pct } from '../format';
import { FLAG_LABEL, Info, Modal, Spinner, StatusBadge, WarnIcon, useToast } from '../components/ui';
import { DocumentPreview } from '../components/DocumentPreview';
import { Documents } from './Documents';
import { GENERAL_ACCOUNT, accountLabel, deriveView, groupAccounts, type ViewAccount, type ViewDoc } from '../review';

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
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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
  const matchesSearch = (a: ViewAccount) => {
    const t = search.trim().toLowerCase();
    return !t || a.accountNumber.includes(t) || a.accountName.toLowerCase().includes(t) || (a.groupName ?? '').toLowerCase().includes(t);
  };
  const order = groups?.groups.map(g => g.code) ?? [];
  const accounts = view.accounts.filter(a => (filter === 'ALLE' || a.status === filter) && matchesSearch(a));
  const docs = useMemo(
    () => view.docs.filter(d => docFilter === 'alle' || (docFilter === 'zu' ? d.assigned : docFilter === 'offen' ? !d.assigned && !d.irrelevant : d.status !== 'ok')),
    [view.docs, docFilter],
  );
  const sel = view.accounts.find(a => a.accountNumber === open) ?? null;
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
      <input className="w-xs" value={visum} placeholder="Kürzel" aria-label="Visum" onChange={e => setVisum(e.target.value.toUpperCase().slice(0, 6))} onBlur={() => void bsb().app.saveSettings({ visum: visum.trim() })} />
    </label>
  );
  const accept = (a: ViewAccount) => update(d => ({ ...d, accepted: { ...d.accepted, [a.accountNumber]: { at: now(), visum: needVisum() } } }));
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
        {([['konten', 'Konten'], ['belege', 'Belegverzeichnis'], ['saldobilanz', 'Saldobilanz-Prüfung'], ['diagnose', 'Diagnosebericht']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === 'konten' && (
        <div className={`result-layout ${sel ? 'withpreview' : 'nopanel'}`}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row small" style={{ justifyContent: 'space-between' }}>
              <span className="muted">{filter !== 'ALLE' || search ? `${accounts.length} von ${view.accounts.length} Konten` : ''}{filter !== 'ALLE' && <> · <button className="link" onClick={() => setFilter('ALLE')}>Filter aufheben</button></>}</span>
              <span className="row" style={{ gap: 12 }}>
                {grouped && <button className="link small" onClick={() => setCollapsed(c => (c.size ? new Set() : new Set(groupAccounts(accounts, order).map(g => g.code))))}>{collapsed.size ? 'Alle aufklappen' : 'Alle zuklappen'}</button>}
                <label className="muted"><input type="checkbox" checked={grouped} onChange={e => setGrouped(e.target.checked)} /> nach KMU-Kontenrahmen gruppieren</label>
              </span>
            </div>
            <div className="table-wrap">
              <table className="grid clickable konten">
                <thead><tr><th>Konto</th><th>Bezeichnung</th><th className="num">Vorjahr</th><th className="num">Aktuell</th><th className="num dchf">Δ CHF</th><th className="num">Δ %</th><th>Status</th><th>Beleg</th></tr></thead>
                <tbody>
                  {(grouped ? withTotals(groupAccounts(accounts, order)) : [{ code: '', name: '', items: accounts, total: 0 }]).map(g =>
                    'totalOf' in g ? (
                      <tr key={`t-${g.totalOf}`} className="total-row">
                        <td colSpan={2}>{g.name}</td>
                        <td className="num">{chf(g.vj)}</td><td className="num">{chf(g.cy)}</td>
                        <Delta cy={g.cy} vj={g.vj} />
                        <td colSpan={2} />
                      </tr>
                    ) : (
                      <GroupRows key={g.code || 'alle'} g={g} grouped={grouped} collapsed={collapsed.has(g.code)}
                        onToggle={() => setCollapsed(c => { const n = new Set(c); if (n.has(g.code)) n.delete(g.code); else n.add(g.code); return n; })}
                        letter={decisions.groupLetters?.[g.code]} open={open} setOpen={setOpen} docs={view.docs} notes={decisions.notes ?? {}} />
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
              onAssign={docId => assign(docId, sel.accountNumber)} onUnassign={docId => assign(docId, undefined)} onClose={() => setOpen(null)}
            />
          )}
        </div>
      )}

      {tab === 'belege' && (
        <Documents docs={view.docs} accounts={view.accounts} filed={result.filed} initialFilter={docFilter === 'offen' ? 'offen' : undefined} onAssign={(id, n) => assign(id, n)} />
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

type Group = { code: string; name: string; items: ViewAccount[]; total: number };
type TotalRow = { totalOf: string; name: string; cy: number; vj: number };
const TOTAL_LABEL: Record<string, string> = { aktiven: 'Total Aktiven', passiven: 'Total Passiven', erfolg: 'Total Erfolgsrechnung (Saldo)' };
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
      out.push({ totalOf: c, name: TOTAL_LABEL[c]!, cy: items.reduce((a, x) => a + x.balance, 0), vj: items.reduce((a, x) => a + (x.balancePreviousYear ?? 0), 0) });
    }
  });
  return out;
}

function Delta({ cy, vj }: { cy: number; vj: number | null }) {
  if (vj === null) return <><td className="num muted dchf">–</td><td className="num muted">–</td></>;
  const d = cy - vj;
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

const PROBLEM_FLAGS = new Set(['SIGN_CONFLICT', 'AMBIGUOUS', 'CURRENCY_MISMATCH', 'DATE_MISMATCH']);

function GroupRows({ g, grouped, collapsed, onToggle, letter, open, setOpen, docs, notes }: {
  g: Group; grouped: boolean; collapsed: boolean; onToggle: () => void; letter?: string; open: string | null;
  setOpen: (n: string) => void; docs: ViewDoc[]; notes: Record<string, unknown>;
}) {
  const docBy = new Map(docs.map(d => [d.id, d]));
  const vj = g.items.reduce((a, x) => a + (x.balancePreviousYear ?? 0), 0);
  const hasVj = g.items.some(x => x.balancePreviousYear !== null);
  const nDocs = new Set(g.items.map(a => (a.status === 'BELEGT' || a.status === 'PRUEFEN' ? a.docId : null)).filter(Boolean)).size;
  return (
    <>
      {grouped && (
        <tr className="group-row" onClick={onToggle} aria-expanded={!collapsed}>
          <td colSpan={2} title={g.name}><span className="caret">{collapsed ? '›' : '⌄'}</span>{letter ? <span className="register">{letter}</span> : null} {g.name}</td>
          <td className="num">{hasVj ? chf(vj) : ''}</td>
          <td className="num">{chf(g.total)}</td>
          <Delta cy={g.total} vj={hasVj ? vj : null} />
          <td className="small muted" title={`${g.items.length} Konten, ${nDocs} Belege`}>{g.items.length}</td>
          <td className="small muted">{nDocs || ''}</td>
        </tr>
      )}
      {!collapsed && g.items.map(a => {
        const doc = a.docId ? docBy.get(a.docId) : undefined;
        const hasDoc = (a.status === 'BELEGT' || a.status === 'PRUEFEN') && doc;
        const problems = (a.best?.flags ?? []).filter(f => PROBLEM_FLAGS.has(f)).map(f => FLAG_LABEL[f] ?? f);
        const quiet = a.status === 'NULLSALDO' || a.status === 'NICHT_IM_UMFANG';
        return (
          <tr key={a.accountNumber} data-konto={a.accountNumber} className={`${open === a.accountNumber ? 'selected' : ''} ${quiet ? 'muted-row' : ''}`} onClick={() => setOpen(a.accountNumber)}>
            <td>{a.accountNumber}</td>
            <td title={a.accountName}>{a.accountName}{notes[a.accountNumber] ? <span className="flag note" title="Notiz vorhanden">Notiz</span> : null}{a.groupSource === 'bezeichnung' && <WarnIcon text={`Gruppe „${a.groupName}“ aus der Bezeichnung abgeleitet – bitte prüfen`} />}</td>
            <td className="num">{a.balancePreviousYear === null ? '' : chf(a.balancePreviousYear)}</td>
            <td className="num">{chf(a.balance)}</td>
            <Delta cy={a.balance} vj={a.balancePreviousYear} />
            <td><StatusBadge status={a.status} />{a.manual && <span className="manual" title={a.manual === 'akzeptiert' ? 'manuell akzeptiert' : 'Beleg manuell zugeordnet'}> ✓</span>}{problems.length > 0 && <WarnIcon text={problems.join(', ')} />}</td>
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

function AccountPanel({ a, docs, filedPath, note, accepted, nav, onAccept, onUnaccept, onNote, onAssign, onUnassign, onClose }: {
  a: ViewAccount; docs: ViewDoc[]; filedPath: string | null; note?: { text: string; at: string; visum: string }; accepted?: { visum: string; at: string; comment?: string };
  nav: { pos: number; count: number; prev: () => void; next: () => void };
  onAccept: () => void; onUnaccept: () => void; onNote: (t: string) => void; onAssign: (docId: string) => void; onUnassign: (docId: string) => void; onClose: () => void;
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
  const candidatesToAssign = docs.filter(d => !d.assigned && !d.irrelevant);
  // Nur bei Problemen sichtbar
  const problems: string[] = [];
  if (a.status === 'PRUEFEN' || a.status === 'KEIN_NACHWEIS') problems.push(...a.reasons.filter(r => !/Texterkennung|Scan/i.test(r)));
  if (c && c.differenceCents !== 0 && Number.isFinite(c.differenceCents)) problems.push(`Differenz zum Saldo: ${chf(c.differenceCents)}`);
  if (c) problems.push(...c.flags.filter(f => PROBLEM_FLAGS.has(f)).map(f => FLAG_LABEL[f] ?? f));
  if (doc && doc.ocrPages > 0 && (doc.ocrConfidence ?? 100) < 60) problems.push(`Schlechte Texterkennung (${doc.ocrConfidence} %) – Betrag mit dem Original vergleichen`);
  const uniq = [...new Set(problems)].filter(() => !(a.manual && a.status === 'BELEGT'));
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
          <button aria-label="Schliessen (Esc)" onClick={onClose}>✕</button>
        </span>
      </div>
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

      <div className="actions-row">
        {a.autoStatus === 'PRUEFEN' && a.manual !== 'zugeordnet' && (a.manual === 'akzeptiert'
          ? <button className="btn on" onClick={onUnaccept} title="Akzeptieren rückgängig machen">✓ Akzeptiert · rückgängig</button>
          : <button className="btn btn-ok" onClick={onAccept}>✓ Akzeptieren</button>)}
        {manualDoc
          ? <button className="btn" onClick={() => onUnassign(manualDoc.id)}>Zuordnung aufheben</button>
          : (a.status === 'KEIN_NACHWEIS' || a.status === 'PRUEFEN') && candidatesToAssign.length > 0 && <button className={`btn ${showAssign ? 'on' : ''}`} onClick={() => setShowAssign(v => !v)}>Beleg zuordnen</button>}
        <button className={`btn ${showNote ? 'on' : ''}`} onClick={() => setShowNote(v => !v)}>Notiz{note?.text ? ' ✓' : ''}</button>
      </div>
      {showAssign && !manualDoc && (
        <select className="assign" style={{ maxWidth: '100%' }} value="" onChange={e => { if (e.target.value) { onAssign(e.target.value); setShowAssign(false); } }}>
          <option value="">– Beleg ohne Zuordnung wählen –</option>
          {candidatesToAssign.map(d => <option key={d.id} value={d.id}>{d.relPath}</option>)}
        </select>
      )}
      {showNote && (
        <div className="note-field">
          <textarea rows={2} maxLength={500} value={noteText} onChange={e => setNoteText(e.target.value)} onBlur={() => noteText !== (note?.text ?? '') && onNote(noteText)} placeholder="z. B. Saldo mit Bankbestätigung abgestimmt." autoFocus={!note?.text} />
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
