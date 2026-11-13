import { useEffect, useState } from 'react';
import { bsb } from '../bridge';
import { chf, date } from '../format';
import { DocumentPreview } from './DocumentPreview';
import { Spinner } from './ui';
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
      <div className="doc-line small">
        <span>{v.source} · Konto {v.accountNumber}{v.pages.length ? ` · Seite ${v.pages[0]}${v.pages.length > 1 ? `–${v.pages[v.pages.length - 1]}` : ''}` : ''}</span>
        {sel !== null && <button className="link small" onClick={() => setSel(null)}>↑ zum Kontoanfang</button>}
        <button className="link small ml-auto" onClick={() => void bsb().app.openPath(v.sourcePath!)}>Kontoblatt öffnen</button>
      </div>
      <div className="ledger-kpis">
        <div><span>Saldovortrag</span><strong>{v.opening === null ? '–' : `${cur}${chf(v.opening)}`}</strong></div>
        <div><span>Soll</span><strong>{cur}{chf(v.debitTotal)}</strong></div>
        <div><span>Haben</span><strong>{cur}{chf(v.creditTotal)}</strong></div>
        <div className={tbDiff === null ? '' : Math.abs(tbDiff) <= 1 ? 'ok' : 'bad'}>
          <span>{tbDiff === null ? 'Schlusssaldo' : Math.abs(tbDiff) <= 1 ? 'Schlusssaldo = Saldobilanz ✓' : `≠ Saldobilanz (Δ ${chf(tbDiff)})`}</span>
          <strong>{v.closing === null ? '–' : `${cur}${chf(v.closing)}`}</strong>
        </div>
      </div>
      {!v.consistent && <div className="problem">Kontoblatt: Saldovortrag + Buchungen ergeben nicht den Schlusssaldo – Lesefehler oder unvollständiges Kontoblatt.</div>}
      <DocumentPreview file={v.sourcePath} page={at.page} lineNo={at.lineNo} bbox={at.bbox} line={at.line} />
      <div className="ledger-postings">
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
      </div>
    </div>
  );
}
