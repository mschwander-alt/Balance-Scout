import { useEffect, useState } from 'react';
import { bsb } from '../bridge';
import { chf, date } from '../format';
import { DocumentPreview } from './DocumentPreview';
import { Info, Spinner } from './ui';
import type { LedgerAccountView } from '../../electron/shared';

/**
 * Reiter „Kontoblatt“: das Kontoblatt des Kontos in der Vorschau, direkt am Anfang des Kontos (Kontokopf).
 * Darüber Saldovortrag, Soll, Haben, Schlusssaldo mit Abgleich zur Saldobilanz; darunter die Buchungen –
 * ein Klick springt im Kontoblatt an die Stelle der Buchung.
 */
export function LedgerView({ historyId, accountNumber }: { historyId: string; accountNumber: string }) {
  const [v, setV] = useState<LedgerAccountView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // gewählte Stelle: null = Kontokopf, sonst Index der Buchung
  const [sel, setSel] = useState<number | null>(null);
  const [showPostings, setShowPostings] = useState(false);
  useEffect(() => {
    let alive = true;
    setV(null); setError(null); setSel(null);
    bsb().review.ledgerAccount(historyId, accountNumber).then(r => alive && setV(r), e => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [historyId, accountNumber]);
  if (error) return <p className="error-text small">{error}</p>;
  if (!v) return <Spinner label="Kontoblatt wird geladen …" />;
  if (!v.available || !v.sourcePath) return <p className="muted">{v.reason}</p>;
  const p = sel === null ? null : v.postings[sel] ?? null;
  const at = p ? { page: p.page, lineNo: p.lineNo, bbox: p.bbox, line: p.text } : { page: v.head.page, lineNo: v.head.lineNo, bbox: v.head.bbox, line: `Konto ${v.accountNumber}` };
  const chfAccount = v.currency === 'CHF';
  const tbDiff = chfAccount && v.tbBalance !== null && v.closing !== null ? v.closing - v.tbBalance : null;
  const cur = chfAccount ? '' : `${v.currency} `;
  return (
    <div className="ledger-view">
      <div className="ledger-kpis small">
        <span className={tbDiff === null ? 'muted' : Math.abs(tbDiff) <= 1 ? 'ok' : 'bad'}>
          {tbDiff === null ? `Schlusssaldo ${v.closing === null ? '–' : `${cur}${chf(v.closing)}`}` : Math.abs(tbDiff) <= 1 ? 'Saldo = Saldobilanz ✓' : `Saldo ≠ Saldobilanz (Δ ${chf(tbDiff)})`}
        </span>
        <Info label="Details zum Kontoblatt"><dl>
          <dt>Quelle</dt><dd>{v.source}{v.pages.length ? ` · Seite ${v.pages[0]}${v.pages.length > 1 ? `–${v.pages[v.pages.length - 1]}` : ''}` : ''}</dd>
          <dt>Saldovortrag</dt><dd>{v.opening === null ? '–' : `${cur}${chf(v.opening)}`}</dd>
          <dt>Soll</dt><dd>{cur}{chf(v.debitTotal)}</dd>
          <dt>Haben</dt><dd>{cur}{chf(v.creditTotal)}</dd>
          <dt>Schlusssaldo</dt><dd>{v.closing === null ? '–' : `${cur}${chf(v.closing)}`}</dd>
          {v.tbBalance !== null && <><dt>Saldobilanz</dt><dd>{chf(v.tbBalance)}</dd></>}
        </dl></Info>
        {sel !== null && <button className="link small" onClick={() => setSel(null)}>↑ zum Kontoanfang</button>}
        <button className="link small ml-auto" onClick={() => void bsb().app.openPath(v.sourcePath!)}>Kontoblatt öffnen</button>
      </div>
      {!v.consistent && <div className="problem">Kontoblatt: Saldovortrag + Buchungen ergeben nicht den Schlusssaldo – Lesefehler oder unvollständiges Kontoblatt.</div>}
      <DocumentPreview file={v.sourcePath} page={at.page} lineNo={at.lineNo} bbox={at.bbox} line={at.line} />
      <button className="link small postings-toggle" aria-expanded={showPostings} onClick={() => setShowPostings(x => !x)}>Buchungen ({v.postings.length}) {showPostings ? '▴' : '▾'}</button>
      {showPostings && <div className="ledger-postings">
        <table className="grid small">
          <thead><tr><th>Datum</th><th>Text</th><th>Gegenkonto</th><th className="num">Betrag</th><th className="num">Saldo</th></tr></thead>
          <tbody>
            {v.postings.map((x, i) => (
              <tr key={`${x.page}|${x.lineNo}`} className={sel === i ? 'selected' : ''} onClick={() => setSel(i)} data-buchung={i}>
                <td>{date(x.date)}</td><td title={x.text}>{x.text}</td><td>{x.contra ?? ''}</td>
                <td className="num">{chf(x.amount)}</td><td className="num">{x.balance === null ? '' : chf(x.balance)}</td>
              </tr>
            ))}
            {!v.postings.length && <tr><td colSpan={5} className="muted">Keine Buchungen im Geschäftsjahr.</td></tr>}
          </tbody>
        </table>
      </div>}
    </div>
  );
}
