import { useMemo, useState } from 'react';
import { bsb } from '../bridge';
import type { AccountRow, AuditResult, DocRow, Status } from '../types';
import { chf, date, pct } from '../format';
import { FLAG_LABEL, StatusBadge, useToast } from '../components/ui';

type Tab = 'konten' | 'belege' | 'saldobilanz' | 'diagnose';

export function Result({ result, onRepeat }: { result: AuditResult; onRepeat?: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('konten');
  const [filter, setFilter] = useState<Status | 'ALLE'>('ALLE');
  const [docFilter, setDocFilter] = useState<'alle' | 'zu' | 'nicht' | 'probleme'>('alle');
  const [open, setOpen] = useState<string | null>(null);
  const s = result.summary;
  const accounts = result.accounts.filter(a => filter === 'ALLE' || a.status === filter);
  const docs = useMemo(
    () => result.documents.filter(d => docFilter === 'alle' || (docFilter === 'zu' ? d.assigned : docFilter === 'nicht' ? !d.assigned : d.status !== 'ok')),
    [result.documents, docFilter],
  );
  const sel = result.accounts.find(a => a.accountNumber === open) ?? null;
  const target = result.documents.find(d => d.placement?.newPath)?.placement?.newPath;
  const ocrDocs = result.documents.filter(d => d.ocrPages > 0).length;
  const problemDocs = result.documents.filter(d => d.status !== 'ok').length;

  return (
    <div className="page stack">
      <div className="row">
        <button className="btn btn-primary" onClick={() => bsb().app.openPath(result.excelPath)}>Excel-Dokumentation öffnen</button>
        <button className="btn" onClick={() => bsb().app.showInFolder(result.excelPath)}>Zielordner anzeigen</button>
        {onRepeat && <button className="btn" onClick={onRepeat}>Erneut prüfen …</button>}
        <span className="muted small ml-auto" title={result.excelPath}>{result.excelPath}</span>
      </div>

      <div className="kpis">
        <Kpi label="Abdeckung (belegt)" value={pct(s.coverage)} sub={`${chf(s.confirmedAbsTotal)} von ${chf(s.inScopeAbsTotal)}`} />
        <Kpi label="Belegt" value={s.counts.BELEGT} tone="ok" onClick={() => { setTab('konten'); setFilter('BELEGT'); }} />
        <Kpi label="Prüfen" value={s.counts.PRUEFEN} tone="warn" onClick={() => { setTab('konten'); setFilter('PRUEFEN'); }} />
        <Kpi label="Kein Nachweis" value={s.counts.KEIN_NACHWEIS} tone="bad" onClick={() => { setTab('konten'); setFilter('KEIN_NACHWEIS'); }} />
        <Kpi label="Belege zugeordnet" value={`${result.documents.filter(d => d.assigned).length} / ${result.documents.length}`} sub={`${ocrDocs} mit Texterkennung${problemDocs ? ` · ${problemDocs} mit Hinweis` : ''}`} onClick={() => setTab('belege')} />
      </div>

      <nav className="tabs" role="tablist" style={{ padding: 0 }}>
        {([['konten', 'Konten'], ['belege', 'Belegverzeichnis'], ['saldobilanz', 'Saldobilanz-Prüfung'], ['diagnose', 'Diagnosebericht']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === 'konten' && (
        <div className={`result-layout ${sel ? '' : 'nopanel'}`}>
          <div className="stack">
            <div className="row filter">
              {(['ALLE', 'BELEGT', 'PRUEFEN', 'KEIN_NACHWEIS', 'NULLSALDO', 'NICHT_IM_UMFANG'] as const).map(f => (
                <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f === 'ALLE' ? `Alle (${result.accounts.length})` : <StatusBadge status={f} />}</button>
              ))}
            </div>
            <div className="table-wrap">
              <table className="grid clickable">
                <thead><tr><th>Konto</th><th>Bezeichnung</th><th className="num">Saldo</th><th>Status</th><th>Datei</th><th>Seite</th><th>Hinweise</th></tr></thead>
                <tbody>
                  {accounts.map(a => (
                    <tr key={a.accountNumber} className={open === a.accountNumber ? 'selected' : ''} onClick={() => setOpen(a.accountNumber)}>
                      <td className="mono">{a.accountNumber}</td>
                      <td>{a.accountName}</td>
                      <td className="num mono">{chf(a.balance)}</td>
                      <td><StatusBadge status={a.status} /></td>
                      <td className="small">{a.status === 'BELEGT' || a.status === 'PRUEFEN' ? a.best?.filename : <span className="muted">–</span>}</td>
                      <td className="small">{a.best && (a.status === 'BELEGT' || a.status === 'PRUEFEN') ? a.best.pageLabel ?? a.best.page : ''}</td>
                      <td>{a.best?.flags.map(f => <span key={f} className="flag">{FLAG_LABEL[f] ?? f}</span>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {sel && <AccountPanel a={sel} onClose={() => setOpen(null)} />}
        </div>
      )}

      {tab === 'belege' && (
        <div className="stack">
          <div className="row filter">
            {([['alle', 'Alle'], ['zu', 'Zugeordnet'], ['nicht', 'Nicht zugeordnet'], ['probleme', 'Mit Hinweis']] as const).map(([k, l]) => (
              <button key={k} className={`chip ${docFilter === k ? 'active' : ''}`} onClick={() => setDocFilter(k)}>{l}</button>
            ))}
            {target && <button className="btn btn-sm ml-auto" onClick={() => bsb().app.showInFolder(target)}>Ablage öffnen</button>}
          </div>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Datei</th><th>Belegart</th><th>Stichtag</th><th>Gelesen</th><th>Konten</th><th>Ablage</th><th /></tr></thead>
              <tbody>{docs.map(d => <DocLine key={d.id} d={d} />)}</tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'saldobilanz' && (
        <div className="card">
          <ul className="checks">{result.validation.checks.map(c => <li key={c.name} className={c.passed ? 'ok' : 'fail'}><strong>{c.passed ? '✓' : '✗'} {c.name}</strong> – {c.message}</li>)}</ul>
          {result.validation.issues.length > 0 && <ul className="issues">{result.validation.issues.map((i, n) => <li key={n} className={i.severity}>Zeile {i.rowIndex}: {i.message}</li>)}</ul>}
        </div>
      )}

      {tab === 'diagnose' && (
        <div className="card stack">
          <p className="small muted">Dieser Bericht enthält <strong>keine</strong> Beträge, Namen oder Dateinamen. Sie können ihn zur Fehlersuche weitergeben.</p>
          <div><button className="btn btn-sm" onClick={async () => { await bsb().app.copyText(result.diagnostics); toast('ok', 'Diagnosebericht kopiert.'); }}>In Zwischenablage kopieren</button></div>
          <pre className="diag">{result.diagnostics}</pre>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone, onClick }: { label: string; value: string | number; sub?: string; tone?: 'ok' | 'warn' | 'bad'; onClick?: () => void }) {
  return (
    <button className={`kpi ${tone ?? ''}`} onClick={onClick} disabled={!onClick}>
      <span className="kpi-label">{label}</span><span className="kpi-value">{value}</span>{sub && <span className="kpi-sub">{sub}</span>}
    </button>
  );
}

function DocLine({ d }: { d: DocRow }) {
  const read = d.status === 'ok' ? 'Ja' : d.status === 'partial' ? 'Teilweise' : d.status === 'unsupported' ? 'nicht unterstützt' : 'Nein';
  return (
    <tr>
      <td>{d.filename}<div className="muted small" title={d.relPath}>{d.relPath}</div>{d.warnings.length > 0 && <div className="small warn">{d.warnings.join(' · ')}</div>}</td>
      <td className="small">{d.docType}</td>
      <td className="small">{date(d.balanceDate)}</td>
      <td className="small">{read}{d.ocrPages > 0 && <div className="muted">Scan, {d.ocrConfidence ?? '–'} %</div>}</td>
      <td className="small mono">{d.assignedAccounts.join(', ') || '–'}</td>
      <td className="small">{d.assigned ? <span className="badge badge-belegt">01 Zugeordnet</span> : <span className="badge badge-kein_nachweis">02 Nicht zugeordnet</span>}{d.placement && <div className="muted">{d.placement.status}{d.placement.message ? `: ${d.placement.message}` : ''}</div>}</td>
      <td className="actions"><button className="btn btn-sm" onClick={() => bsb().app.openPath(d.placement?.newPath ?? d.absPath)}>Öffnen</button></td>
    </tr>
  );
}

function AccountPanel({ a, onClose }: { a: AccountRow; onClose: () => void }) {
  const b = a.best;
  const file = b?.newPath ?? b?.absPath ?? null;
  return (
    <aside className="panel">
      <header className="panel-head">
        <div><h3>{a.accountNumber} {a.accountName}</h3><p className="mono">{chf(a.balance)}{a.balancePreviousYear !== null && <span className="muted small"> · VJ {chf(a.balancePreviousYear)}</span>}</p></div>
        <button className="icon-btn" aria-label="Schliessen" onClick={onClose}>✕</button>
      </header>
      <section><StatusBadge status={a.status} /><ul className="reasons">{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></section>
      {b && (a.status === 'BELEGT' || a.status === 'PRUEFEN') && (
        <div className="cand">
          <h4>Fundstelle</h4>
          <div className="cand-head"><span>{b.relPath ?? b.filename} · {b.pageLabel ?? `S. ${b.page}`} · Z. {b.lineNo}{b.source !== 'text-layer' ? ' · Texterkennung' : ''}</span><span className="score" title="Punktzahl">{b.score}</span></div>
          <pre className="line">{b.line}</pre>
          <p className="small">Beleg {chf(b.evidenceCents)} · Differenz {chf(b.differenceCents)}</p>
          <ul className="reasons small">{b.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          {file && <button className="btn btn-sm" onClick={() => bsb().app.openPath(file)}>Beleg öffnen</button>}
        </div>
      )}
      {a.candidates.length > 0 && (
        <details><summary>{a.candidates.length} weitere Fundstelle(n)</summary>
          {a.candidates.map((c, i) => <div key={i} className="cand"><div className="cand-head"><span>{c.filename} · S. {c.page}</span><span className="score">{c.score}</span></div><pre className="line">{c.line}</pre></div>)}
        </details>
      )}
      <p className="small muted">Prüfer-Entscheid und Kommentar werden in der Excel-Dokumentation (grüne Spalten) erfasst.</p>
    </aside>
  );
}
