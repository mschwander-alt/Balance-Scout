import { useEffect, useMemo, useState } from 'react';
import { bsb } from '../bridge';
import { chf, date } from '../format';
import { Info, WarnIcon } from '../components/ui';
import { DocumentPreview } from '../components/DocumentPreview';
import { GENERAL_ACCOUNT, accountLabel, type ViewAccount, type ViewDoc } from '../review';
import type { Filed } from '../types';

type DocFilter = 'alle' | 'offen' | 'zu' | 'probleme';
type Sort = 'offen' | 'name' | 'datum' | 'betrag';

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const isProblem = (d: ViewDoc) => d.status !== 'ok' || (d.ocrPages > 0 && (d.ocrConfidence ?? 100) < 60);
const problemText = (d: ViewDoc) =>
  [d.status !== 'ok' ? 'nicht vollständig gelesen' : '', d.ocrPages > 0 && (d.ocrConfidence ?? 100) < 60 ? `schlechte Texterkennung (${d.ocrConfidence} %)` : '', ...d.warnings].filter(Boolean).join(' · ');
const open = (d: ViewDoc) => !d.assigned && !d.irrelevant;

function AssignBadge({ d }: { d: ViewDoc }) {
  if (d.irrelevant) return <span className="badge badge-nullsaldo">Nicht relevant</span>;
  if (!d.assigned) return <span className="badge badge-grey">Nicht zugeordnet</span>;
  return <span className="badge badge-belegt">{d.accounts.map(accountLabel).join(', ')}</span>;
}

export function Documents({ docs, accounts, filed, initialFilter, onAssign }: {
  docs: ViewDoc[]; accounts: ViewAccount[]; filed?: Record<string, Filed>; initialFilter?: DocFilter;
  onAssign: (docId: string, accountNumber: string | null | undefined) => void;
}) {
  const [filter, setFilter] = useState<DocFilter>(initialFilter ?? (docs.some(open) ? 'offen' : 'alle'));
  const [sort, setSort] = useState<Sort>('offen');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);

  const counts = { alle: docs.length, offen: docs.filter(open).length, zu: docs.filter(d => d.assigned || d.irrelevant).length, probleme: docs.filter(isProblem).length };
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const f = docs.filter(d =>
      (filter === 'alle' || (filter === 'offen' ? open(d) : filter === 'zu' ? d.assigned || d.irrelevant : isProblem(d))) &&
      (!t || d.filename.toLowerCase().includes(t) || d.relPath.toLowerCase().includes(t) || (d.searchText ?? '').includes(t)));
    const by: Record<Sort, (a: ViewDoc, b: ViewDoc) => number> = {
      offen: (a, b) => Number(open(b)) - Number(open(a)) || (a.register ?? '~').localeCompare(b.register ?? '~', 'de', { numeric: true }) || a.filename.localeCompare(b.filename, 'de'),
      name: (a, b) => a.filename.localeCompare(b.filename, 'de', { numeric: true }),
      datum: (a, b) => (b.keyDate ?? '').localeCompare(a.keyDate ?? ''),
      betrag: (a, b) => Math.abs(b.keyAmount?.cents ?? 0) - Math.abs(a.keyAmount?.cents ?? 0),
    };
    return [...f].sort(by[sort]);
  }, [docs, filter, sort, q]);

  // Auswahl: erster Beleg der Liste, falls nichts gewählt
  useEffect(() => {
    if (!sel || !docs.some(d => d.id === sel)) setSel(list[0]?.id ?? null);
  }, [list, sel, docs]);
  const cur = docs.find(d => d.id === sel) ?? null;
  const idx = list.findIndex(d => d.id === sel);
  const go = (d: number) => {
    const n = list[idx + d];
    if (n) {
      setSel(n.id);
      document.querySelector(`[data-beleg="${CSS.escape(n.relPath)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // Nach dem Zuordnen direkt zum nächsten offenen Beleg
  const assign = (docId: string, acc: string | null | undefined) => {
    const nextOpen = list.slice(idx + 1).find(d => open(d) && d.id !== docId) ?? list.find(d => open(d) && d.id !== docId);
    onAssign(docId, acc);
    if (acc !== undefined && filter === 'offen' && nextOpen) setSel(nextOpen.id);
    else if (acc !== undefined && nextOpen && open(cur!)) setSel(nextOpen.id);
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        {([['alle', 'Alle'], ['offen', 'Ohne Zuordnung'], ['zu', 'Zugeordnet'], ['probleme', 'Mit Hinweis']] as const).map(([k, l]) => (
          <button key={k} className={`chip ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{l} ({counts[k]})</button>
        ))}
        <input className="search ml-auto" type="search" placeholder="Dateiname oder Text im Beleg suchen …" value={q} onChange={e => setQ(e.target.value)} aria-label="Belege suchen" style={{ width: 260 }} />
        <label className="field inline small"><span>Sortierung</span>
          <select value={sort} onChange={e => setSort(e.target.value as Sort)}>
            <option value="offen">Ohne Zuordnung zuerst</option>
            <option value="name">Dateiname</option>
            <option value="datum">Neueste zuerst</option>
            <option value="betrag">Grösster Betrag</option>
          </select>
        </label>
      </div>

      <div className="result-layout withpreview docs-layout">
        <div className="table-wrap">
          <table className="grid clickable belege">
            <thead><tr><th>Dateiname</th><th>Datum</th><th className="num">Betrag</th><th>Zuordnung</th><th /></tr></thead>
            <tbody>
              {list.map(d => (
                <tr key={d.id} data-beleg={d.relPath} className={d.id === sel ? 'selected' : ''} onClick={() => setSel(d.id)}>
                  <td title={d.relPath}>
                    <div className="fname">{d.register && <span className="register sm">{d.register}</span>}{d.filename}{isProblem(d) && <WarnIcon text={problemText(d)} />}</div>
                    <div className="muted small">{kb(d.size)}</div>
                  </td>
                  <td>{date(d.keyDate ?? null)}</td>
                  <td className="num">{d.keyAmount ? `CHF ${chf(Math.abs(d.keyAmount.cents))}` : '–'}</td>
                  <td><AssignBadge d={d} />{d.manualAssignment && <span className="manual"> ✓</span>}</td>
                  <td className="muted">›</td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={5} className="muted">Keine Belege{filter === 'offen' ? ' ohne Zuordnung – alles zugeordnet ✓' : ''}.</td></tr>}
            </tbody>
          </table>
          <div className="small muted table-foot">{docs.length} Belege · {counts.offen} ohne Zuordnung</div>
        </div>
        {cur ? <DocPanel key={cur.id} d={cur} accounts={accounts} filed={filed?.[cur.id]} pos={idx + 1} count={list.length} prev={() => go(-1)} next={() => go(1)} onAssign={acc => assign(cur.id, acc)} /> : <div />}
      </div>
    </div>
  );
}

function DocPanel({ d, accounts, filed, pos, count, prev, next, onAssign }: {
  d: ViewDoc; accounts: ViewAccount[]; filed?: Filed; pos: number; count: number; prev: () => void; next: () => void;
  onAssign: (acc: string | null | undefined) => void;
}) {
  const [q, setQ] = useState('');
  const amounts = useMemo(() => new Set(d.amountSet ?? []), [d.amountSet]);
  const current = d.manualAssignment ? (d.irrelevant ? null : d.accounts[0] ?? null) : d.accounts[0] ?? null;
  const [pick, setPick] = useState<string | null>(current && current !== GENERAL_ACCOUNT ? current : null);
  // Vorschläge: Saldo kommt im Beleg vor; dann Konten ohne Nachweis; dann der Rest
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const rank = (a: ViewAccount) => (amounts.has(Math.abs(a.balance)) && a.balance !== 0 ? 0 : a.status === 'KEIN_NACHWEIS' ? 1 : a.status === 'PRUEFEN' ? 2 : 3);
    return accounts
      .filter(a => a.status !== 'NICHT_IM_UMFANG' || t)
      .filter(a => !t || a.accountNumber.includes(t) || a.accountName.toLowerCase().includes(t) || (a.groupName ?? '').toLowerCase().includes(t))
      .sort((a, b) => rank(a) - rank(b) || a.accountNumber.localeCompare(b.accountNumber, 'de', { numeric: true }));
  }, [accounts, q, amounts]);
  const file = filed?.placement?.newPath ?? d.absPath;
  const ka = d.keyAmount;
  return (
    <aside className="panel preview-panel doc-panel">
      <div className="panel-title">
        <h3 title={d.relPath}>{d.filename}</h3>
        <AssignBadge d={d} />
        <span className="panel-nav">
          <button aria-label="vorheriger Beleg" onClick={prev} disabled={pos <= 1}>‹</button>
          <span className="small">{pos} / {count}</span>
          <button aria-label="nächster Beleg" onClick={next} disabled={pos >= count}>›</button>
        </span>
      </div>
      <div className="doc-line small">
        <span>Erkanntes Datum: <strong>{date(d.keyDate ?? null)}</strong></span>
        <span>Betrag: <strong>{ka ? `CHF ${chf(Math.abs(ka.cents))}` : '–'}</strong></span>
        <Info label="Details zum Beleg">
          <dl>
            <dt>Ablageort</dt><dd>{d.relPath}</dd>
            <dt>Belegart</dt><dd>{d.docType}</dd>
            <dt>Grösse</dt><dd>{kb(d.size)}, {d.pageCount} S.</dd>
            <dt>Gelesen</dt><dd>{d.status === 'ok' ? 'vollständig' : d.status}{d.ocrPages > 0 ? ` · Texterkennung ${d.ocrPages} S., ${d.ocrConfidence ?? '–'} %` : ''}</dd>
            {ka && <><dt>Betrag aus</dt><dd>Seite {ka.page}: {ka.line}</dd></>}
            <dt>Beträge</dt><dd>{d.amountCount}</dd>
            {filed?.placement?.newPath && <><dt>Abgelegt</dt><dd>{filed.placement.newPath}</dd></>}
          </dl>
        </Info>
        <button className="link small ml-auto" onClick={() => bsb().app.openPath(file)}>Öffnen</button>
      </div>
      {isProblem(d) && <div className="problem">{problemText(d)}</div>}
      <DocumentPreview file={file} page={ka?.page ?? 1} lineNo={ka?.lineNo ?? 0} bbox={ka?.bbox} line={ka?.line ?? ''} />

      <div className="assign-box">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong className="small">Beleg einem Konto zuordnen</strong>
          {d.manualAssignment && <button className="link small" onClick={() => onAssign(undefined)}>Zuordnung aufheben</button>}
        </div>
        <input type="search" placeholder="Konto suchen (Nummer, Bezeichnung oder Gruppe)" value={q} onChange={e => setQ(e.target.value)} aria-label="Konto suchen" />
        <div className="acc-pick">
          <table className="grid clickable">
            <thead><tr><th>Konto</th><th>Bezeichnung</th><th className="num">Vorjahr</th><th className="num">Aktuell</th><th className="num">Δ</th></tr></thead>
            <tbody>
              {rows.map(a => {
                const match = amounts.has(Math.abs(a.balance)) && a.balance !== 0;
                return (
                  <tr key={a.accountNumber} data-pick={a.accountNumber} className={pick === a.accountNumber ? 'selected' : ''} onClick={() => setPick(a.accountNumber)} onDoubleClick={() => onAssign(a.accountNumber)}>
                    <td>{a.accountNumber}</td>
                    <td title={a.accountName}><span className={`dot ${a.status === 'BELEGT' ? 'ok' : a.status === 'PRUEFEN' ? 'warn' : a.status === 'KEIN_NACHWEIS' ? 'bad' : 'grey'}`} /> {a.accountName}{match && <span className="flag match" title="Dieser Saldo kommt im Beleg vor">Betrag passt</span>}</td>
                    <td className="num">{a.balancePreviousYear === null ? '' : chf(a.balancePreviousYear)}</td>
                    <td className="num">{chf(a.balance)}</td>
                    <td className="num">{a.balancePreviousYear === null ? '' : chf(a.balance - a.balancePreviousYear)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="actions-row">
          <button className="btn btn-primary grow" disabled={!pick} onClick={() => pick && onAssign(pick)}>Beleg zuordnen{pick ? ` → ${pick}` : ''}</button>
          <button className="btn" onClick={() => onAssign(GENERAL_ACCOUNT)} title="Belege ohne Konto, z. B. HR-Auszug, Statuten">Allgemein (A)</button>
          <button className="btn" onClick={() => onAssign(null)}>Nicht relevant</button>
        </div>
      </div>
    </aside>
  );
}
