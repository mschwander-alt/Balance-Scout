import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bsb, call, ApiFailure } from '../bridge';
import type { Candidate, Decision, Engagement, Lock, MatchResult, Me, Review, Run, Status } from '../types';
import { chf, dateTime, pct, shortUser } from '../format';
import { DecisionBadge, DECISION_LABEL, Spinner, StatusBadge, useAiConsent, useToast } from '../components/ui';

const FLAG_LABEL: Record<string, string> = {
  SIGN_CONFLICT: 'Vorzeichen',
  AMBIGUOUS: 'Mehrdeutig',
  CURRENCY_MISMATCH: 'Währung',
  DATE_MISMATCH: 'Stichtag',
  OCR_SOURCE: 'Scan/OCR',
  LOW_SPECIFICITY: 'Zufallsrisiko',
};

export function MatchingTab({ engagement, trialBalanceId, me, locks, tick }: { engagement: Engagement; trialBalanceId: string; me: Me; locks: Lock[]; tick: number }) {
  const toast = useToast();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [busy, setBusy] = useState(false);
  const [tolerance, setTolerance] = useState('1.00');
  const [filter, setFilter] = useState<Status | 'ALLE' | 'OFFEN'>('ALLE');
  const [open, setOpen] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    const r = await call<Run[]>('GET', `/api/trial-balances/${trialBalanceId}/match-runs`);
    setRuns(r);
    if (r[0]) setRun(await call<Run>('GET', `/api/match-runs/${r[0].id}`));
    const rv = await call<Review[]>('GET', `/api/trial-balances/${trialBalanceId}/reviews`);
    setReviews(Object.fromEntries(rv.map(x => [x.accountId!, x])));
  }, [trialBalanceId]);

  useEffect(() => {
    loadRuns().catch(e => toast('error', (e as Error).message));
  }, [loadRuns, tick, toast]);

  const start = async () => {
    const tol = Math.round(Number(tolerance.replace(',', '.').replace(/'/g, '')) * 100);
    if (!Number.isFinite(tol) || tol < 0) return toast('error', 'Toleranz ungültig.');
    setBusy(true);
    await bsb().app.setActivity('Abgleich läuft');
    try {
      await call('POST', `/api/trial-balances/${trialBalanceId}/match-runs`, { absoluteToleranceCents: tol });
      await loadRuns();
      toast('ok', 'Abgleich abgeschlossen.');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      await bsb().app.setActivity(null);
    }
  };

  const results = run?.results ?? [];
  const lockBy = useMemo(() => Object.fromEntries(locks.map(l => [l.accountId, l])), [locks]);
  const shown = results.filter(r =>
    filter === 'ALLE' ? true : filter === 'OFFEN' ? r.status !== 'NICHT_IM_UMFANG' && r.status !== 'NULLSALDO' && (reviews[r.accountId]?.decision ?? 'offen') === 'offen' : r.status === filter,
  );
  const s = run?.summary;
  const reviewed = results.filter(r => reviews[r.accountId] && reviews[r.accountId]!.decision !== 'offen').length;
  const inScope = results.filter(r => r.status !== 'NICHT_IM_UMFANG').length;
  const openResult = results.find(r => r.accountId === open) ?? null;

  return (
    <div className={`matching ${openResult ? 'with-panel' : ''}`}>
      <div className="stack">
        <div className="card row">
          <label className="field inline">
            <span>Toleranz CHF</span>
            <input className="w-sm" value={tolerance} onChange={e => setTolerance(e.target.value)} />
          </label>
          <button className="btn btn-primary" onClick={start} disabled={busy}>{busy ? <Spinner label="Abgleich läuft …" /> : 'Abgleich starten'}</button>
          {run && <span className="muted small">Lauf vom {dateTime(run.created_at)} · {shortUser(run.created_by)} · {run.engine_version}</span>}
          {runs && runs.length > 1 && (
            <select className="ml-auto" value={run?.id} onChange={async e => setRun(await call<Run>('GET', `/api/match-runs/${e.target.value}`))}>
              {runs.map(r => <option key={r.id} value={r.id}>{dateTime(r.created_at)} – {shortUser(r.created_by)}</option>)}
            </select>
          )}
        </div>

        {s && (
          <div className="kpis">
            <Kpi label="Abdeckung (belegt)" value={pct(s.coverage)} sub={`${chf(s.confirmedAbsTotal)} von ${chf(s.inScopeAbsTotal)}`} />
            <Kpi label="Belegt" value={String(s.counts.BELEGT)} tone="ok" onClick={() => setFilter('BELEGT')} />
            <Kpi label="Prüfen" value={String(s.counts.PRUEFEN)} tone="warn" onClick={() => setFilter('PRUEFEN')} />
            <Kpi label="Kein Nachweis" value={String(s.counts.KEIN_NACHWEIS)} tone="bad" onClick={() => setFilter('KEIN_NACHWEIS')} />
            <Kpi label="Prüfvermerke" value={`${reviewed} / ${inScope}`} onClick={() => setFilter('OFFEN')} sub="ohne Vermerk anzeigen" />
          </div>
        )}

        {run && (
          <>
            <div className="row filter">
              {(['ALLE', 'OFFEN', 'BELEGT', 'PRUEFEN', 'KEIN_NACHWEIS', 'NULLSALDO', 'NICHT_IM_UMFANG'] as const).map(f => (
                <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
                  {f === 'ALLE' ? 'Alle' : f === 'OFFEN' ? 'Ohne Vermerk' : <StatusBadge status={f} />}
                </button>
              ))}
            </div>
            <table className="grid clickable">
              <thead>
                <tr><th>Konto</th><th>Bezeichnung</th><th className="num">Saldo</th><th>Status</th><th>Fundstelle</th><th>Hinweise</th><th>Vermerk</th></tr>
              </thead>
              <tbody>
                {shown.map(r => {
                  const l = lockBy[r.accountId];
                  const rv = reviews[r.accountId];
                  return (
                    <tr key={r.accountId} className={open === r.accountId ? 'selected' : ''} onClick={() => setOpen(r.accountId)}>
                      <td className="mono">{r.accountNumber}</td>
                      <td>{r.accountName}{l && <span className={`lock ${l.lockedBy === me.actor ? 'mine' : ''}`} title={`In Bearbeitung: ${l.lockedByName}`}>🔒 {shortUser(l.lockedByName)}</span>}</td>
                      <td className="num mono">{chf(r.balance)}</td>
                      <td><StatusBadge status={r.status} /></td>
                      <td className="small">{r.best ? <>{r.best.filename} <span className="muted">S.{r.best.page}/Z.{r.best.lineNo}</span></> : <span className="muted">–</span>}</td>
                      <td>{r.best?.flags.map(f => <span key={f} className="flag">{FLAG_LABEL[f] ?? f}</span>)}</td>
                      <td>{rv ? <DecisionBadge decision={rv.decision} /> : <span className="muted small">–</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
        {runs?.length === 0 && <p className="muted">Noch kein Abgleich. Belege hochladen und „Abgleich starten“.</p>}
      </div>

      {openResult && run && (
        <AccountPanel
          key={openResult.accountId}
          engagement={engagement}
          runId={run.id}
          result={openResult}
          me={me}
          lock={lockBy[openResult.accountId]}
          review={reviews[openResult.accountId]}
          onClose={() => setOpen(null)}
          onSaved={rv => setReviews(x => ({ ...x, [openResult.accountId]: rv }))}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone, onClick }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'bad'; onClick?: () => void }) {
  return (
    <button className={`kpi ${tone ?? ''}`} onClick={onClick} disabled={!onClick}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </button>
  );
}

interface AiReview { review: { assessment: 'stuetzt' | 'stuetzt_nicht' | 'unklar'; reasoning: string; issues: string[]; suggestedComment: string | null }; provider: string; notice: string }

function AccountPanel(p: {
  engagement: Engagement; runId: string; result: MatchResult; me: Me; lock?: Lock; review?: Review;
  onClose: () => void; onSaved: (r: Review) => void;
}) {
  const toast = useToast();
  const { ask, dialog } = useAiConsent();
  const [editing, setEditing] = useState(false);
  const [decision, setDecision] = useState<Decision>(p.review?.decision ?? (p.result.status === 'BELEGT' ? 'bestaetigt' : 'offen'));
  const [comment, setComment] = useState(p.review?.comment ?? '');
  const [history, setHistory] = useState<Review[]>([]);
  const [ai, setAi] = useState<AiReview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const heartbeat = useRef<number | null>(null);
  const r = p.result;
  const lockedByOther = p.lock && p.lock.lockedBy !== p.me.actor;

  useEffect(() => {
    void call<Review[]>('GET', `/api/accounts/${r.accountId}/reviews`).then(setHistory).catch(() => undefined);
  }, [r.accountId, p.review?.version]);

  // Sperre freigeben beim Schliessen
  useEffect(
    () => () => {
      if (heartbeat.current) window.clearInterval(heartbeat.current);
      if (heartbeat.current !== null) void call('DELETE', `/api/accounts/${r.accountId}/lock`).catch(() => undefined);
    },
    [r.accountId],
  );

  const startEdit = async () => {
    try {
      await call('POST', `/api/accounts/${r.accountId}/lock`);
      setEditing(true);
      heartbeat.current = window.setInterval(() => void call('POST', `/api/accounts/${r.accountId}/lock`).catch(() => undefined), 60_000);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const stopEdit = async () => {
    if (heartbeat.current) window.clearInterval(heartbeat.current);
    heartbeat.current = null;
    setEditing(false);
    await call('DELETE', `/api/accounts/${r.accountId}/lock`).catch(() => undefined);
  };

  const save = async () => {
    setBusy('Speichern …');
    try {
      const saved = await call<Review>('PUT', `/api/accounts/${r.accountId}/review`, { decision, comment, runId: p.runId, baseVersion: p.review?.version ?? 0 });
      p.onSaved(saved);
      toast('ok', 'Prüfvermerk gespeichert.');
      await stopEdit();
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409) toast('error', 'Inzwischen von jemand anderem geändert – bitte Konto neu öffnen.');
      else toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const askAi = async () => {
    if (!(await ask(p.engagement.id, 'match_review', `Fundstelle zu Konto ${r.accountNumber}`))) return;
    setBusy('KI beurteilt …');
    try {
      setAi(await call<AiReview>('POST', `/api/match-runs/${p.runId}/accounts/${r.accountId}/ai-review`, {}));
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="panel">
      {dialog}
      <header className="panel-head">
        <div>
          <h3>{r.accountNumber} {r.accountName}</h3>
          <p className="mono">{chf(r.balance)} {p.engagement.currency}</p>
        </div>
        <button className="icon-btn" aria-label="Schliessen" onClick={p.onClose}>✕</button>
      </header>

      <section>
        <StatusBadge status={r.status} />
        <ul className="reasons">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </section>

      {r.best && <CandidateBox c={r.best} title="Beste Fundstelle" />}
      {r.candidates.length > 1 && (
        <details>
          <summary>{r.candidates.length - 1} weitere Fundstelle(n)</summary>
          {r.candidates.slice(1).map((c, i) => <CandidateBox key={i} c={c} />)}
        </details>
      )}

      {r.best && (
        <section>
          <button className="btn btn-sm" onClick={askAi} disabled={!!busy}>KI-Beurteilung anfordern</button>
          {ai && (
            <div className={`ai-box ai-${ai.review.assessment}`}>
              <strong>{ai.review.assessment === 'stuetzt' ? 'Stützt den Saldo' : ai.review.assessment === 'stuetzt_nicht' ? 'Stützt den Saldo nicht' : 'Unklar'}</strong>
              <p>{ai.review.reasoning}</p>
              {ai.review.issues.length > 0 && <p className="small">Punkte: {ai.review.issues.join(', ')}</p>}
              {ai.review.suggestedComment && editing && (
                <button className="link" onClick={() => setComment(c => (c ? `${c}\n` : '') + ai.review.suggestedComment)}>Formulierung übernehmen</button>
              )}
              <p className="muted small">{ai.notice} ({ai.provider})</p>
            </div>
          )}
        </section>
      )}

      <section className="review">
        <h4>Prüfvermerk</h4>
        {lockedByOther && <p className="warn">🔒 Wird bearbeitet von {p.lock!.lockedByName}.</p>}
        {!editing ? (
          <>
            {p.review ? (
              <div>
                <DecisionBadge decision={p.review.decision} />
                {p.review.comment && <p className="comment">{p.review.comment}</p>}
                <p className="muted small">v{p.review.version} · {shortUser(p.review.reviewedBy)} · {dateTime(p.review.reviewedAt)}</p>
              </div>
            ) : <p className="muted">Noch kein Vermerk.</p>}
            <button className="btn btn-primary btn-sm" onClick={startEdit} disabled={!!lockedByOther}>Bearbeiten</button>
          </>
        ) : (
          <>
            <div className="seg">
              {(Object.keys(DECISION_LABEL) as Decision[]).map(d => (
                <button key={d} className={decision === d ? 'active' : ''} onClick={() => setDecision(d)}>{DECISION_LABEL[d]}</button>
              ))}
            </div>
            <textarea rows={5} value={comment} onChange={e => setComment(e.target.value)} placeholder="Feststellungen, Abstimmung, offene Punkte …" />
            <div className="row-end">
              <button className="btn btn-sm" onClick={stopEdit}>Abbrechen</button>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={!!busy}>Speichern</button>
            </div>
          </>
        )}
        {busy && <Spinner label={busy} />}
        {history.length > 1 && (
          <details>
            <summary>Verlauf ({history.length})</summary>
            <ul className="history">
              {history.map(h => <li key={h.version}>v{h.version} · {DECISION_LABEL[h.decision]} · {shortUser(h.reviewedBy)} · {dateTime(h.reviewedAt)}</li>)}
            </ul>
          </details>
        )}
      </section>
    </aside>
  );
}

function CandidateBox({ c, title }: { c: Candidate; title?: string }) {
  return (
    <div className="cand">
      {title && <h4>{title}</h4>}
      <div className="cand-head">
        <span>{c.filename} · S.{c.page} Z.{c.lineNo}{c.source !== 'text-layer' ? ' · OCR' : ''}</span>
        <span className="score" title="Punktzahl">{c.score}</span>
      </div>
      <pre className="line">{c.line}</pre>
      <p className="small">Beleg {chf(c.evidenceCents)} · Differenz {chf(c.differenceCents)} · {c.kind === 'exact' ? 'exakt' : c.kind === 'rounded' ? 'gerundet' : 'Toleranz'}</p>
      <ul className="reasons small">{c.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}
