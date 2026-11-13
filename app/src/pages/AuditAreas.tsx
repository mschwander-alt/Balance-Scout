import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { bsb } from '../bridge';
import { chf, date, pct } from '../format';
import { AutoTextarea, Info, Spinner, useToast } from '../components/ui';
import { DocumentPreview } from '../components/DocumentPreview';
import type { AgingItem, GroupsInfo, ReceivablesDecision, ReceivablesResult, ReviewDecisions } from '../../electron/shared';
import type { ViewAccount, ViewDoc } from '../review';
import { FixedAssets } from './FixedAssets';
import { Accruals } from './Accruals';

/** Prüfgebiete mit Vorjahresvergleich der Rechnungsabgrenzungen */
const ACCRUALS = ['A15', 'P13'];

/** Prüfgebiete mit Anlagespiegel: mobile/immobile Sachanlagen, immaterielle Werte */
const FIXED = ['A21', 'A22', 'A23'];
const BUCKETS = ['Nicht fällig', '1–30 Tage', '31–60 Tage', '61–90 Tage', '> 90 Tage'];
/** Altersklassen als Ampel: nicht fällig (grün) bis > 90 Tage (rot) – lesbar auf dunklem Grund */
const SHADES = ['#4fc767', '#b7d84f', '#e3b341', '#f0883e', '#f85149'];
type Sub = 'faelligkeit' | 'posten' | 'feststellungen';
/** Sortierung Kundentabelle: Name, Total oder Index der Altersklasse */
type CustSortKey = 'name' | 'total' | number;

/** Prüfgebiete: Bilanzpositionen links, vertiefte Prüfung rechts (zuerst Forderungen aus L+L). */
export function AuditAreas({ historyId, accounts, docs, groups, decisions, update, closingDate, rates }: {
  historyId?: string; accounts: ViewAccount[]; docs: ViewDoc[]; groups: GroupsInfo | null; decisions: ReviewDecisions;
  update: (fn: (d: ReviewDecisions) => ReviewDecisions) => void; closingDate: string | null; rates?: Record<string, number>;
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
          <button key={a.code} className={`area-item ${a.code === cur?.code ? 'active' : ''} ${a.code === 'A12' || FIXED.includes(a.code) || ACCRUALS.includes(a.code) ? '' : 'later'}`} onClick={() => setArea(a.code)}>
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
              <p className="small muted">{cur.code === 'A12' ? 'Vertiefte Prüfung – Fälligkeitsanalyse' : FIXED.includes(cur.code) ? 'Vertiefte Prüfung – Anlagespiegel und Abschreibungen' : ACCRUALS.includes(cur.code) ? 'Vertiefte Prüfung – Vorjahresvergleich aus den Kontoblättern' : 'Vertiefte Prüfung folgt'}</p>
            </div>
            <div className="saldo-box">
              <span className="small muted">Saldo per {date(closingDate)}</span>
              <strong>CHF {chf(Math.abs(cur.cy))}</strong>
              <span className="small muted">VJ {chf(Math.abs(cur.vj))}{cur.vj ? ` · Δ ${(((Math.abs(cur.cy) - Math.abs(cur.vj)) / Math.abs(cur.vj)) * 100).toFixed(1)} %` : ''}</span>
            </div>
          </div>
        )}
        {cur?.code === 'A12' && historyId ? (
          <Receivables historyId={historyId} docs={docs} decisions={decisions} update={update} letter={cur.letter} defaultRates={rates ?? {}} />
        ) : cur && FIXED.includes(cur.code) && historyId ? (
          <FixedAssets historyId={historyId} decisions={decisions} update={update} />
        ) : cur && ACCRUALS.includes(cur.code) && historyId ? (
          <Accruals historyId={historyId} decisions={decisions} update={update} closingDate={closingDate} />
        ) : (
          <div className="card muted">Für dieses Prüfgebiet ist noch keine vertiefte Analyse verfügbar. Verfügbar sind: Forderungen aus L+L (Fälligkeitsanalyse), Sachanlagen und immaterielle Werte (Anlagespiegel) sowie aktive und passive Rechnungsabgrenzungen (Vorjahresvergleich).</div>
        )}
      </section>
    </div>
  );
}

function Receivables({ historyId, docs, decisions, update, letter, defaultRates }: {
  historyId: string; docs: ViewDoc[]; decisions: ReviewDecisions; update: (fn: (d: ReviewDecisions) => ReviewDecisions) => void; letter: string; defaultRates: Record<string, number>;
}) {
  const toast = useToast();
  const saved = decisions.analyses?.receivables;
  // Kurse: aus der Prüfung (ESTV-Kursliste bzw. manuell erfasst) vorbelegt
  const [params, setParams] = useState<ReceivablesDecision>(saved ?? { docId: null, termDays: 30, rates: { ...defaultRates }, findings: [] });
  const [started, setStarted] = useState(!!saved);
  const [info, setInfo] = useState<ReceivablesResult | null>(null); // Kandidaten (ohne Analyse)
  const [r, setR] = useState<ReceivablesResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [sub, setSub] = useState<Sub>('faelligkeit');
  const [cust, setCust] = useState<string | null>(null);
  const [item, setItem] = useState<AgingItem | null>(null);
  const [newFinding, setNewFinding] = useState('');
  const [custFilter, setCustFilter] = useState('');
  const [custSort, setCustSort] = useState<{ key: CustSortKey; dir: 1 | -1 }>({ key: 'total', dir: -1 });
  // Zuordnung aus der Durchsicht (inkl. manueller Änderungen und Mehrfachzuordnung)
  const assigned = useMemo(() => Object.fromEntries(docs.map(d => [d.id, d.accounts])), [docs]);
  const assignedKey = JSON.stringify(assigned);
  // Vom Prüfer verschobene Konten (Gruppe) – Forderungskonten können neu dazukommen oder wegfallen
  const groupOverrides = decisions.groupOverrides;
  const overridesKey = JSON.stringify(groupOverrides ?? {});

  // Kandidaten laden: Belege, die Konten der Forderungen L+L zugeordnet sind (noch keine Analyse)
  useEffect(() => {
    void bsb().review.receivables(historyId, { docIds: ['__keine__'], assigned, groupOverrides }).then(res => {
      setInfo(res);
      setParams(p => (p.docIds?.length ? p : { ...p, docIds: res.candidates.filter(c => c.looksLikeOpList).map(c => c.docId) }));
    }, e => toast('error', (e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyId, assignedKey, overridesKey, toast]);

  const run = async (p: ReceivablesDecision) => {
    setBusy(true);
    try {
      const res = await bsb().review.receivables(historyId, { ...p, assigned, groupOverrides });
      setR(res);
      return res;
    } catch (e) {
      toast('error', (e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  // Nach dem Start: bei Änderung von Frist, Kursen, Listen oder Konten neu berechnen (kurz verzögert beim Tippen)
  useEffect(() => {
    if (!started) return;
    const t = setTimeout(() => void run(params), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, params.termDays, params.rates, params.docIds, params.accounts, assignedKey, overridesKey]);
  // Gestartete Analyse in den Entscheiden speichern (Abschluss legt sie als Nachweis ab)
  useEffect(() => {
    if (started) update(d => ({ ...d, analyses: { ...d.analyses, receivables: { ...params, assigned } } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, params, assignedKey, update]);

  const start = async () => {
    const res = await run(params);
    if (!res?.aging) return;
    setStarted(true);
    if (!params.findings.length) setParams(p => ({ ...p, findings: res.suggestions.map(text => ({ text, status: 'offen' as const })) }));
  };
  const discard = () => {
    setStarted(false);
    setR(null);
    update(d => { const { receivables: _x, ...rest } = d.analyses ?? {}; return { ...d, analyses: rest }; });
  };

  const cands = info?.candidates ?? [];
  const selDocs = params.docIds ?? [];
  const accFromDocs = [...new Set(cands.filter(c => selDocs.includes(c.docId)).flatMap(c => c.accounts))];
  const selAccounts = params.accounts?.length ? params.accounts : accFromDocs;
  const setAccounts = (accounts: string[]) => setParams(p => ({ ...p, accounts: [...new Set(accounts)] }));
  // Abstimmung: Forderungskonten und gewählte Konten als Häkchen, alle übrigen Konten über die Auswahlliste
  const accOpts = info?.accountOptions ?? [];
  const shownAccounts = accOpts.filter(o => o.suggested || selAccounts.includes(o.accountNumber));
  const otherAccounts = accOpts.filter(o => !o.suggested && !selAccounts.includes(o.accountNumber));
  const a = started ? r?.aging : null;
  const opDocOf = (i: AgingItem) => docs.find(d => d.id === ((i as AgingItem & { sourceDocId?: string }).sourceDocId ?? r?.docId));
  // Forderungen nach Kunden: alle Kunden, durchsuchbar und sortierbar
  const customers = useMemo(() => {
    const q = custFilter.trim().toLowerCase();
    const list = (a?.customers ?? []).filter(c => !q || `${c.customerNo} ${c.customerName}`.toLowerCase().includes(q));
    const val = (c: (typeof list)[number]) => (custSort.key === 'name' ? 0 : custSort.key === 'total' ? c.totalChf : c.buckets[custSort.key]!);
    return [...list].sort((x, y) => custSort.key === 'name'
      ? (x.customerName || x.customerNo).localeCompare(y.customerName || y.customerNo, 'de') * custSort.dir
      : (val(x) - val(y)) * custSort.dir || (x.customerName || '').localeCompare(y.customerName || '', 'de'));
  }, [a, custFilter, custSort]);
  const sortBy = (key: CustSortKey) => setCustSort(s => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' ? 1 : -1 }));
  const sortMark = (key: CustSortKey) => (custSort.key === key ? (custSort.dir === 1 ? ' ▲' : ' ▼') : '');
  const diff = a && r?.balanceChf !== null && r?.balanceChf !== undefined ? a.totalChf - r.balanceChf : null;
  const custItems = a && cust !== null ? a.items.filter(i => `${i.customerNo}|${i.customerName}` === cust) : [];
  const fileName = `${letter ? `${letter}.x_` : ''}Analyse_Fälligkeit`;
  const exportParams = { ...params, assigned, groupOverrides };

  return (
    <div className="stack" style={{ gap: 10 }}>
      {/* 1. Grundlage wählen: Listen (nur Belege, die Forderungskonten zugeordnet sind) und Konten für die Abstimmung */}
      <div className="card setup-card">
        <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
          <div className="grow">
            <div className="small muted">OP-Liste(n) – Belege, die Konten der Forderungen L+L zugeordnet sind</div>
            {!info ? <Spinner /> : cands.length === 0 ? (
              <p className="warn small">Noch kein Beleg ist einem Forderungskonto zugeordnet. Ordnen Sie die OP-Liste im Belegverzeichnis den Konten zu (auch mehreren Konten).</p>
            ) : cands.map(c => (
              <label key={c.docId} className="pick-line">
                <input type="checkbox" checked={selDocs.includes(c.docId)} onChange={e => setParams(p => ({ ...p, docIds: e.target.checked ? [...selDocs, c.docId] : selDocs.filter(x => x !== c.docId) }))} />
                <span className="grow">{c.relPath}</span>
                <span className="small muted">Konto {c.accounts.join(', ')}</span>
                {!c.looksLikeOpList && <span className="flag" title="Sieht nicht wie eine OP-Liste aus">keine OP-Liste?</span>}
              </label>
            ))}
          </div>
          <div>
            <div className="small muted">Abstimmung mit Konto</div>
            {shownAccounts.map(o => (
              <label key={o.accountNumber} className="pick-line">
                <input type="checkbox" checked={selAccounts.includes(o.accountNumber)} onChange={e => setAccounts(e.target.checked ? [...selAccounts, o.accountNumber] : selAccounts.filter(x => x !== o.accountNumber))} />
                <span>{o.accountNumber} {o.accountName}</span><span className="small muted">CHF {chf(o.balance)}</span>
                {!o.suggested && <span className="flag" title="Konto gehört nicht zu den Forderungen aus L+L">andere Gruppe</span>}
              </label>
            ))}
            {otherAccounts.length > 0 && (
              <select className="add-account" value="" aria-label="Weiteres Konto für die Abstimmung"
                onChange={e => { if (e.target.value) setAccounts([...selAccounts, e.target.value]); }}>
                <option value="">+ Weiteres Konto hinzufügen …</option>
                {otherAccounts.map(o => <option key={o.accountNumber} value={o.accountNumber}>{o.accountNumber} {o.accountName} · CHF {chf(o.balance)}</option>)}
              </select>
            )}
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
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
          {!started ? (
            <button className="btn btn-primary" disabled={!selDocs.length || busy} onClick={() => void start()}>Analyse starten</button>
          ) : (
            <>
              <button className="link small" onClick={discard} title="Analyse nicht als Nachweis ablegen">Analyse verwerfen</button>
              <button className="btn" disabled={!a} onClick={async () => { const f = await bsb().review.exportReceivables(historyId, exportParams, `${fileName.replace('.x_', '_')}.pptx`, 'pptx'); if (f) toast('ok', 'PowerPoint gespeichert.'); }}>PowerPoint herunterladen</button>
              <button className="btn" disabled={!a} onClick={async () => { const f = await bsb().review.exportReceivables(historyId, exportParams, `${fileName.replace('.x_', '_')}.xlsx`, 'xlsx'); if (f) toast('ok', 'Excel gespeichert.'); }}>Excel herunterladen</button>
            </>
          )}
        </div>
      </div>

      {started && !a && busy && <Spinner label="OP-Liste wird ausgewertet …" />}
      {a && (
        <>
          <div className={`recon ${diff !== null && Math.abs(diff) > 100 ? 'bad' : 'ok'}`}>
            <span>Total OP-Liste <strong>CHF {chf(a.totalChf)}</strong></span>
            <span>Saldo Konto {r?.balanceAccounts || '–'} <strong>CHF {r?.balanceChf === null ? '–' : chf(r!.balanceChf)}</strong></span>
            <span>{diff === null ? '' : Math.abs(diff) <= 100 ? '✓ abgestimmt' : <>Differenz <strong>CHF {chf(diff)}</strong></>}</span>
            <Info label="Details zur OP-Liste">
              <dl>
                {r?.lists.map(l => <Fragment key={l.docId}><dt>Liste</dt><dd>{l.filename} · {l.items} Posten · per {date(l.listDate)}</dd></Fragment>)}
                <dt>Posten</dt><dd>{a.items.length} · {a.kpis.customers} Debitoren</dd>
                {a.checks.map(c => <Fragment key={c.name}><dt>{c.name}</dt><dd>{c.passed ? '✓ ' : '✗ '}{c.message}</dd></Fragment>)}
              </dl>
            </Info>
          </div>
          {a.checks.filter(c => !c.passed).length > 0 && <div className="problem"><ul>{a.checks.filter(c => !c.passed).map(c => <li key={c.name}>{c.message}</li>)}</ul></div>}

          <nav className="tabs sub" role="tablist">
            {([['faelligkeit', 'Fälligkeitsanalyse'], ['posten', `Einzelposten (${a.items.length})`], ['feststellungen', `Feststellungen und Notiz (${params.findings.filter(f => f.status === 'offen').length})`]] as [Sub, string][]).map(([k, l]) => (
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
                <div className="card" style={{ padding: 0 }}>
                  <div className="row cust-head">
                    <h3>Forderungen nach Kunden</h3>
                    <span className="small muted">{custFilter ? `${customers.length} von ${a.customers.length}` : a.customers.length} Kunden</span>
                    <input className="ml-auto w-md" type="search" placeholder="Kunde suchen …" value={custFilter} onChange={e => setCustFilter(e.target.value)} aria-label="Kunde suchen" />
                  </div>
                  <div className="cust-scroll">
                  <table className="grid clickable kunden">
                    <thead><tr>
                      <th className="sortable" onClick={() => sortBy('name')} aria-sort={custSort.key === 'name' ? (custSort.dir === 1 ? 'ascending' : 'descending') : undefined}>Kunde{sortMark('name')}</th>
                      <th className="num sortable" onClick={() => sortBy('total')}>Total CHF{sortMark('total')}</th>
                      {BUCKETS.map((b, i) => <th key={b} className="num sortable" onClick={() => sortBy(i)}>{b.replace(' Tage', ' T')}{sortMark(i)}</th>)}
                    </tr></thead>
                    <tbody>
                      {customers.length === 0 && <tr className="muted-row"><td colSpan={2 + BUCKETS.length}>Kein Kunde gefunden.</td></tr>}
                      {customers.map(c => {
                        const k = `${c.customerNo}|${c.customerName}`;
                        return (
                          <tr key={k} data-kunde={c.customerName} className={cust === k ? 'selected' : ''} onClick={() => { setCust(k); setItem(null); }}>
                            <td title={`${c.customerNo} ${c.customerName}`}>{c.customerName || c.customerNo}{c.dunningLevel ? <span className="flag" title="Mahnstufe">MS {c.dunningLevel}</span> : null}</td>
                            <td className="num">{chf(c.totalChf)}</td>
                            {c.buckets.map((b, i) => <td key={i} className={`num ${i >= 3 && b > 0 ? 'delta-big' : ''}`}>{b ? chf(b) : '–'}</td>)}
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      {custFilter && customers.length > 0 && (
                        <tr className="muted-row">
                          <td>Summe Auswahl ({customers.length})</td>
                          <td className="num">{chf(customers.reduce((s, c) => s + c.totalChf, 0))}</td>
                          {BUCKETS.map((_, i) => <td key={i} className="num">{chf(customers.reduce((s, c) => s + c.buckets[i]!, 0))}</td>)}
                        </tr>
                      )}
                      <tr className="total-row">
                        <td>Total{a.credits ? ' (inkl. Gutschriften)' : ''}</td>
                        <td className="num">{chf(a.totalChf)}</td>
                        {a.buckets.map((b, i) => <td key={i} className="num">{chf(b)}</td>)}
                      </tr>
                    </tfoot>
                  </table>
                  </div>
                </div>
                {cust && <CustomerPanel items={custItems} name={cust.split('|')[1] || cust.split('|')[0]!} fileOf={i => opDocOf(i)?.absPath ?? null} item={item} setItem={setItem} onClose={() => setCust(null)} />}
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
                <AutoTextarea className="grow" placeholder="Neue Feststellung, z. B. Saldenbestätigung Muster AG einholen" value={newFinding} onChange={e => setNewFinding(e.target.value)}
                  submitOnEnter onSubmit={() => { if (newFinding.trim()) { setParams(p => ({ ...p, findings: [...p.findings, { text: newFinding.trim(), status: 'offen' }] })); setNewFinding(''); } }} />
                <button className="btn" disabled={!newFinding.trim()} onClick={() => { setParams(p => ({ ...p, findings: [...p.findings, { text: newFinding.trim(), status: 'offen' }] })); setNewFinding(''); }}>+ Feststellung erfassen</button>
              </div>
              <label className="field note-field" style={{ marginTop: 8 }}>
                <span>Notiz zum Prüfgebiet (erscheint in Excel und PowerPoint)</span>
                <AutoTextarea minRows={3} maxLength={2000} value={params.note ?? ''} onChange={e => setParams(p => ({ ...p, note: e.target.value }))} placeholder="z. B. Delkredere pauschal 5 % auf Inland, 10 % auf Ausland; Einzelwertberichtigung Muster AG geprüft." />
              </label>
              <p className="small muted">Feststellungen und Notiz erscheinen in der Analyse ({fileName}.xlsx und .pptx), die beim Abschliessen als Nachweis abgelegt wird.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CustomerPanel({ items, name, fileOf, item, setItem, onClose }: { items: AgingItem[]; name: string; fileOf: (i: AgingItem) => string | null; item: AgingItem | null; setItem: (i: AgingItem) => void; onClose: () => void }) {
  const sel = item ?? items.find(i => (i.daysOverdue ?? 0) > 0) ?? items[0] ?? null;
  const file = sel ? fileOf(sel) : null;
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
        <circle cx="70" cy="70" r={R} fill="none" style={{ stroke: 'var(--grey-bg)' }} strokeWidth="22" />
        {values.map((v, i) => {
          const len = total > 0 ? (Math.max(0, v) / total) * C : 0;
          const el = <circle key={i} cx="70" cy="70" r={R} fill="none" stroke={SHADES[i]} strokeWidth="22" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} transform="rotate(-90 70 70)" />;
          off += len;
          return el;
        })}
        <text x="70" y="66" textAnchor="middle" fontSize="10" style={{ fill: 'var(--muted)' }}>CHF</text>
        <text x="70" y="82" textAnchor="middle" fontSize="13" fontWeight="600" style={{ fill: 'var(--text)' }}>{chf(total).replace(/\.\d\d$/, '')}</text>
      </svg>
      <ul className="legend">
        {values.map((v, i) => <li key={i}><span className="dot" style={{ background: SHADES[i] }} /> {BUCKETS[i]} <strong>{total ? ((v / total) * 100).toFixed(1) : '0.0'} %</strong></li>)}
      </ul>
    </div>
  );
}
