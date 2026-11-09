import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { bsb } from '../bridge';
import { chf, date, pct } from '../format';
import { Info, Spinner, useToast } from '../components/ui';
import { DocumentPreview } from '../components/DocumentPreview';
import type { AgingItem, GroupsInfo, ReceivablesDecision, ReceivablesResult, ReviewDecisions } from '../../electron/shared';
import type { ViewAccount, ViewDoc } from '../review';

const BUCKETS = ['Nicht fällig', '1–30 Tage', '31–60 Tage', '61–90 Tage', '> 90 Tage'];
const SHADES = ['#1f5f9e', '#3b82c4', '#6ea6d9', '#a4c8ea', '#d4e5f6'];
type Sub = 'faelligkeit' | 'posten' | 'feststellungen';

/** Prüfgebiete: Bilanzpositionen links, vertiefte Prüfung rechts (zuerst Forderungen aus L+L). */
export function AuditAreas({ historyId, accounts, docs, groups, decisions, update, closingDate }: {
  historyId?: string; accounts: ViewAccount[]; docs: ViewDoc[]; groups: GroupsInfo | null; decisions: ReviewDecisions;
  update: (fn: (d: ReviewDecisions) => ReviewDecisions) => void; closingDate: string | null;
}) {
  const areas = useMemo(() => {
    const order = groups?.groups.filter(g => g.category === 'aktiven' || g.category === 'passiven') ?? [];
    return order
      .map(g => {
        const items = accounts.filter(a => a.groupCode === g.code);
        return { code: g.code, name: g.name, letter: decisions.groupLetters?.[g.code] ?? '', cy: items.reduce((s, a) => s + a.balance, 0), vj: items.reduce((s, a) => s + (a.balancePreviousYear ?? 0), 0), n: items.length };
      })
      .filter(a => a.n > 0);
  }, [groups, accounts, decisions.groupLetters]);
  const [area, setArea] = useState('A12');
  const cur = areas.find(a => a.code === area) ?? areas[0];
  return (
    <div className="areas">
      <aside className="area-list">
        <div className="small muted" style={{ padding: '4px 8px 8px' }}>Gezielte Analysen auf Basis der Kundenunterlagen</div>
        {areas.map(a => (
          <button key={a.code} className={`area-item ${a.code === cur?.code ? 'active' : ''} ${a.code === 'A12' ? '' : 'later'}`} onClick={() => setArea(a.code)}>
            {a.letter ? <span className="register">{a.letter}</span> : <span className="register empty" />}
            <span className="grow"><span className="area-name">{a.name}</span><span className="small muted">CHF {chf(Math.abs(a.cy))}</span></span>
            <span className="muted">›</span>
          </button>
        ))}
      </aside>
      <section className="area-body">
        {cur && (
          <div className="area-head">
            {cur.letter && <span className="register lg">{cur.letter}</span>}
            <div className="grow">
              <h2>{cur.name}</h2>
              <p className="small muted">{cur.code === 'A12' ? 'Vertiefte Prüfung – Fälligkeitsanalyse' : 'Vertiefte Prüfung folgt'}</p>
            </div>
            <div className="saldo-box">
              <span className="small muted">Saldo per {date(closingDate)}</span>
              <strong>CHF {chf(Math.abs(cur.cy))}</strong>
              <span className="small muted">VJ {chf(Math.abs(cur.vj))}{cur.vj ? ` · Δ ${(((Math.abs(cur.cy) - Math.abs(cur.vj)) / Math.abs(cur.vj)) * 100).toFixed(1)} %` : ''}</span>
            </div>
          </div>
        )}
        {cur?.code === 'A12' && historyId ? (
          <Receivables historyId={historyId} docs={docs} decisions={decisions} update={update} letter={cur.letter} />
        ) : (
          <div className="card muted">Für dieses Prüfgebiet ist noch keine vertiefte Analyse verfügbar. Als nächste folgen u. a. der Anlagespiegel (Sachanlagen) und die Fremdwährungsbewertung.</div>
        )}
      </section>
    </div>
  );
}

function Receivables({ historyId, docs, decisions, update, letter }: {
  historyId: string; docs: ViewDoc[]; decisions: ReviewDecisions; update: (fn: (d: ReviewDecisions) => ReviewDecisions) => void; letter: string;
}) {
  const toast = useToast();
  const saved = decisions.analyses?.receivables;
  const [params, setParams] = useState<ReceivablesDecision>(saved ?? { docId: null, termDays: 30, rates: {}, findings: [] });
  const [r, setR] = useState<ReceivablesResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [sub, setSub] = useState<Sub>('faelligkeit');
  const [cust, setCust] = useState<string | null>(null);
  const [item, setItem] = useState<AgingItem | null>(null);
  const [newFinding, setNewFinding] = useState('');
  const first = useRef(true);
  const hadSaved = useRef(!!saved);

  // Neu berechnen bei Änderung von Quelle, Frist oder Kursen (kurz verzögert beim Tippen)
  useEffect(() => {
    setBusy(true);
    const t = setTimeout(() => {
      bsb().review.receivables(historyId, { docId: params.docId, termDays: params.termDays, rates: params.rates }).then(
        res => {
          setR(res);
          // Erstes Öffnen: vorgeschlagene Feststellungen übernehmen
          if (first.current && !hadSaved.current && res.aging) setParams(p => ({ ...p, docId: res.docId, findings: res.suggestions.map(text => ({ text, status: 'offen' })) }));
          first.current = false;
        },
        e => toast('error', (e as Error).message),
      ).finally(() => setBusy(false));
    }, first.current ? 0 : 350);
    return () => clearTimeout(t);
  }, [historyId, params.docId, params.termDays, params.rates, toast]);
  // Parameter und Feststellungen in den Entscheiden der Prüfung speichern (für Abschluss/Export)
  const hasAging = !!r?.aging;
  useEffect(() => {
    if (!hasAging) return;
    update(d => ({ ...d, analyses: { ...d.analyses, receivables: params } }));
  }, [params, hasAging, update]);

  const a = r?.aging;
  const opDoc = docs.find(d => d.id === r?.docId);
  const customers = a?.customers ?? [];
  const top = customers.slice(0, 8);
  const rest = customers.slice(8);
  const diff = a && r?.balanceChf !== null && r?.balanceChf !== undefined ? a.totalChf - r.balanceChf : null;
  const custItems = a && cust !== null ? a.items.filter(i => `${i.customerNo}|${i.customerName}` === cust) : [];
  const fileName = `${letter ? `${letter}.x_` : ''}Analyse_Fälligkeit.xlsx`;

  if (!r && busy) return <Spinner label="OP-Liste wird ausgewertet …" />;
  if (r && !r.candidates.length && !r.docId) {
    return <div className="card">Unter den Kundenunterlagen wurde keine Offenposten-Liste der Debitoren gefunden. Legen Sie die OP-Liste (Excel oder PDF) zu den Unterlagen und starten Sie die Prüfung erneut.</div>;
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row source-row">
        <label className="field inline"><span>OP-Liste</span>
          <select value={params.docId ?? r?.docId ?? ''} onChange={e => setParams(p => ({ ...p, docId: e.target.value || null }))}>
            {(r?.candidates ?? []).map(c => <option key={c.docId} value={c.docId}>{c.relPath}</option>)}
            {docs.filter(d => !r?.candidates.some(c => c.docId === d.id)).map(d => <option key={d.id} value={d.id}>{d.relPath} (manuell)</option>)}
          </select>
        </label>
        <label className="field inline"><span>Zahlungsfrist</span>
          <input className="w-xs" type="number" min={0} max={365} value={params.termDays} onChange={e => setParams(p => ({ ...p, termDays: Math.max(0, Number(e.target.value) || 0) }))} aria-label="Zahlungsfrist in Tagen" /> Tage
          <Info label="Zur Zahlungsfrist">Gilt für Posten ohne Fälligkeitsdatum in der Liste: fällig = Belegdatum + Frist. Überfälligkeit per Bilanzstichtag.</Info>
        </label>
        {(r?.currencies ?? []).filter(c => c !== 'CHF').map(c => (
          <label key={c} className="field inline"><span>Kurs {c}</span>
            <input className={`w-sm ${a?.missingRates.includes(c) ? 'missing' : ''}`} inputMode="decimal" placeholder="z. B. 0.93" defaultValue={params.rates[c] ?? ''}
              onChange={e => { const v = Number(e.target.value.replace(',', '.')); setParams(p => ({ ...p, rates: { ...p.rates, [c]: v } })); }} aria-label={`Kurs ${c}`} />
          </label>
        ))}
        <span className="ml-auto" />
        {busy && <Spinner />}
        <button className="btn" disabled={!a} onClick={async () => { const p = await bsb().review.exportReceivables(historyId, params, fileName.replace('.x_', '_')); if (p) toast('ok', 'Fälligkeitsanalyse gespeichert.'); }}>Excel herunterladen</button>
      </div>

      {a && (
        <>
          <div className={`recon ${diff !== null && Math.abs(diff) > 100 ? 'bad' : 'ok'}`}>
            <span>Total OP-Liste <strong>CHF {chf(a.totalChf)}</strong></span>
            <span>Saldo Forderungen L+L ({r?.balanceAccounts || '–'}) <strong>CHF {r?.balanceChf === null ? '–' : chf(r!.balanceChf)}</strong></span>
            <span>{diff === null ? '' : Math.abs(diff) <= 100 ? '✓ abgestimmt' : <>Differenz <strong>CHF {chf(diff)}</strong></>}</span>
            <Info label="Details zur OP-Liste">
              <dl>
                <dt>Quelle</dt><dd>{opDoc?.relPath ?? r?.filename}</dd>
                <dt>Stichtag Liste</dt><dd>{date(r?.listDate ?? null)}</dd>
                <dt>Posten</dt><dd>{a.items.length} · {a.kpis.customers} Debitoren</dd>
                {a.checks.map(c => <Fragment key={c.name}><dt>{c.name}</dt><dd>{c.passed ? '✓ ' : '✗ '}{c.message}</dd></Fragment>)}
              </dl>
            </Info>
          </div>
          {a.checks.filter(c => !c.passed).length > 0 && <div className="problem"><ul>{a.checks.filter(c => !c.passed).map(c => <li key={c.name}>{c.message}</li>)}</ul></div>}

          <nav className="tabs sub" role="tablist">
            {([['faelligkeit', 'Fälligkeitsanalyse'], ['posten', `Einzelposten (${a.items.length})`], ['feststellungen', `Feststellungen (${params.findings.filter(f => f.status === 'offen').length})`]] as [Sub, string][]).map(([k, l]) => (
              <button key={k} role="tab" className={sub === k ? 'active' : ''} onClick={() => setSub(k)}>{l}</button>
            ))}
          </nav>

          {sub === 'faelligkeit' && (
            <>
              <div className="charts">
                <div className="card">
                  <h3>Altersstruktur offene Rechnungen</h3>
                  <Bars values={a.buckets} />
                  {a.credits !== 0 && <p className="small muted">Gutschriften / Vorauszahlungen (nicht nach Alter verteilt): CHF {chf(a.credits)}</p>}
                </div>
                <div className="card">
                  <h3>Verteilung</h3>
                  <Donut values={a.buckets} total={a.grossChf} />
                </div>
              </div>
              <div className="kpi-row">
                <div className="card kpi2"><span className="small muted">Über 90 Tage überfällig</span><strong>CHF {chf(a.kpis.overdue90)}</strong><span className="small muted">{pct(a.kpis.overdue90Share)} der Rechnungen</span></div>
                <div className="card kpi2"><span className="small muted">Überfällige Debitoren</span><strong>{a.kpis.overdueCustomers}</strong><span className="small muted">von {a.kpis.customers}</span></div>
                <div className="card kpi2"><span className="small muted">Grösster überfälliger Saldo</span><strong>{a.kpis.largestOverdue ? `CHF ${chf(a.kpis.largestOverdue.amount)}` : '–'}</strong><span className="small muted">{a.kpis.largestOverdue?.customer ?? ''}</span></div>
                <div className="card kpi2"><span className="small muted">Ø Überfälligkeit</span><strong>{a.kpis.avgDaysOverdue} Tage</strong><span className="small muted">gewichtet, überfällige Posten</span></div>
              </div>
              <div className={`result-layout cust-layout ${cust ? 'withpreview' : 'nopanel'}`}>
                <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
                  <h3 style={{ padding: '10px 12px 0' }}>Forderungen nach Kunden</h3>
                  <table className="grid clickable kunden">
                    <thead><tr><th>Kunde</th><th className="num">Total CHF</th>{BUCKETS.map(b => <th key={b} className="num">{b.replace(' Tage', ' T')}</th>)}</tr></thead>
                    <tbody>
                      {top.map(c => {
                        const k = `${c.customerNo}|${c.customerName}`;
                        return (
                          <tr key={k} data-kunde={c.customerName} className={cust === k ? 'selected' : ''} onClick={() => { setCust(k); setItem(null); }}>
                            <td title={`${c.customerNo} ${c.customerName}`}>{c.customerName || c.customerNo}{c.dunningLevel ? <span className="flag" title="Mahnstufe">MS {c.dunningLevel}</span> : null}</td>
                            <td className="num">{chf(c.totalChf)}</td>
                            {c.buckets.map((b, i) => <td key={i} className={`num ${i >= 3 && b > 0 ? 'delta-big' : ''}`}>{b ? chf(b) : '–'}</td>)}
                          </tr>
                        );
                      })}
                      {rest.length > 0 && (
                        <tr className="muted-row">
                          <td>Andere ({rest.length})</td>
                          <td className="num">{chf(rest.reduce((s, c) => s + c.totalChf, 0))}</td>
                          {BUCKETS.map((_, i) => <td key={i} className="num">{chf(rest.reduce((s, c) => s + c.buckets[i]!, 0))}</td>)}
                        </tr>
                      )}
                      <tr className="total-row">
                        <td>Total{a.credits ? ' (inkl. Gutschriften)' : ''}</td>
                        <td className="num">{chf(a.totalChf)}</td>
                        {a.buckets.map((b, i) => <td key={i} className="num">{chf(b)}</td>)}
                      </tr>
                    </tbody>
                  </table>
                </div>
                {cust && <CustomerPanel items={custItems} name={cust.split('|')[1] || cust.split('|')[0]!} file={opDoc?.absPath ?? null} item={item} setItem={setItem} onClose={() => setCust(null)} />}
              </div>
            </>
          )}

          {sub === 'posten' && (
            <div className="table-wrap">
              <table className="grid">
                <thead><tr><th>Kunde</th><th>Beleg</th><th>Art</th><th>Datum</th><th>Fällig</th><th className="num">Tage</th><th>Klasse</th><th className="num">Betrag</th><th className="num">CHF</th></tr></thead>
                <tbody>
                  {a.items.map((i, n) => (
                    <tr key={n}>
                      <td>{i.customerName || i.customerNo}</td><td>{i.docNo}</td><td>{i.docType}</td><td>{date(i.date)}</td><td>{date(i.due)}</td>
                      <td className="num">{i.daysOverdue !== null && i.daysOverdue > 0 ? i.daysOverdue : ''}</td>
                      <td>{i.amount < 0 ? 'Gutschr./VZ' : BUCKETS[i.bucket]}</td>
                      <td className="num">{i.currency !== 'CHF' ? `${i.currency} ` : ''}{chf(i.amount)}</td>
                      <td className="num">{i.amountChf === null ? '–' : chf(i.amountChf)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {sub === 'feststellungen' && (
            <div className="card stack" style={{ gap: 6 }}>
              <h3>Feststellungen und nächste Schritte</h3>
              {params.findings.map((f, i) => (
                <label key={i} className={`finding ${f.status}`}>
                  <input type="checkbox" checked={f.status === 'erledigt'} onChange={e => setParams(p => ({ ...p, findings: p.findings.map((x, j) => (j === i ? { ...x, status: e.target.checked ? 'erledigt' : 'offen' } : x)) }))} />
                  <span className="grow">{f.text}</span>
                  <span className={`badge ${f.status === 'erledigt' ? 'badge-belegt' : 'badge-pruefen'}`}>{f.status === 'erledigt' ? 'Erledigt' : 'Offen'}</span>
                  <button className="icon-btn" aria-label="entfernen" onClick={e => { e.preventDefault(); setParams(p => ({ ...p, findings: p.findings.filter((_, j) => j !== i) })); }}>✕</button>
                </label>
              ))}
              <div className="row">
                <input className="grow" placeholder="Neue Feststellung, z. B. Saldenbestätigung Muster AG einholen" value={newFinding} onChange={e => setNewFinding(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && newFinding.trim()) { setParams(p => ({ ...p, findings: [...p.findings, { text: newFinding.trim(), status: 'offen' }] })); setNewFinding(''); } }} />
                <button className="btn" disabled={!newFinding.trim()} onClick={() => { setParams(p => ({ ...p, findings: [...p.findings, { text: newFinding.trim(), status: 'offen' }] })); setNewFinding(''); }}>+ Feststellung erfassen</button>
              </div>
              <p className="small muted">Die Feststellungen erscheinen in der Analyse ({fileName}), die beim Abschliessen als Nachweis abgelegt wird.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CustomerPanel({ items, name, file, item, setItem, onClose }: { items: AgingItem[]; name: string; file: string | null; item: AgingItem | null; setItem: (i: AgingItem) => void; onClose: () => void }) {
  const sel = item ?? items.find(i => (i.daysOverdue ?? 0) > 0) ?? items[0] ?? null;
  return (
    <aside className="panel preview-panel">
      <div className="panel-title"><h3>{name}</h3><span className="panel-nav"><button aria-label="Schliessen" onClick={onClose}>✕</button></span></div>
      <table className="grid clickable small">
        <thead><tr><th>Beleg</th><th>Datum</th><th className="num">Betrag</th><th>Fälligkeit</th></tr></thead>
        <tbody>
          {items.map((i, n) => (
            <tr key={n} className={sel === i ? 'selected' : ''} onClick={() => setItem(i)}>
              <td>{i.docNo} <span className="muted">{i.docType}</span></td><td>{date(i.date)}</td>
              <td className="num">{i.currency !== 'CHF' ? `${i.currency} ` : ''}{chf(i.amount)}</td>
              <td className={(i.daysOverdue ?? 0) > 90 ? 'delta-big' : ''}>{i.amount < 0 ? 'Gutschr./VZ' : (i.daysOverdue ?? 0) > 0 ? `${i.daysOverdue} T überfällig` : 'nicht fällig'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {file && sel && <DocumentPreview file={file} page={sel.page} lineNo={sel.lineNo} bbox={sel.bbox} line={sel.line} />}
    </aside>
  );
}

function Bars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="bars" role="img" aria-label="Altersstruktur">
      {values.map((v, i) => (
        <div key={i} className="bar-col">
          <span className="bar-val">{chf(v).replace(/\.\d\d$/, '')}</span>
          <div className="bar" style={{ height: `${Math.max(2, (v / max) * 100)}%`, background: SHADES[i] }} />
          <span className="bar-lbl">{BUCKETS[i]}</span>
        </div>
      ))}
    </div>
  );
}

function Donut({ values, total }: { values: number[]; total: number }) {
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 140 140" width="150" height="150" aria-label="Verteilung">
        <circle cx="70" cy="70" r={R} fill="none" stroke="#eef1f5" strokeWidth="22" />
        {values.map((v, i) => {
          const len = total > 0 ? (Math.max(0, v) / total) * C : 0;
          const el = <circle key={i} cx="70" cy="70" r={R} fill="none" stroke={SHADES[i]} strokeWidth="22" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} transform="rotate(-90 70 70)" />;
          off += len;
          return el;
        })}
        <text x="70" y="66" textAnchor="middle" fontSize="10" fill="#737b8c">CHF</text>
        <text x="70" y="82" textAnchor="middle" fontSize="13" fontWeight="600" fill="#222936">{chf(total).replace(/\.\d\d$/, '')}</text>
      </svg>
      <ul className="legend">
        {values.map((v, i) => <li key={i}><span className="dot" style={{ background: SHADES[i] }} /> {BUCKETS[i]} <strong>{total ? ((v / total) * 100).toFixed(1) : '0.0'} %</strong></li>)}
      </ul>
    </div>
  );
}
