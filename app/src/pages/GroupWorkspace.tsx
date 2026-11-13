import { useState } from 'react';
import { chf, date, pct } from '../format';
import { AutoTextarea } from '../components/ui';
import type { AreaState, ReviewDecisions } from '../../electron/shared';
import type { ViewAccount, ViewDoc } from '../review';
import { AREA_STATES, areaRow } from '../areas';

type Update = (fn: (d: ReviewDecisions) => ReviewDecisions) => void;
const STATUS_TEXT: Record<string, string> = { BELEGT: 'Belegt', PRUEFEN: 'Prüfen', KEIN_NACHWEIS: 'Kein Nachweis', NULLSALDO: 'Nullsaldo', NICHT_IM_UMFANG: 'Nicht im Umfang' };
const STATUS_CLS: Record<string, string> = { BELEGT: 'badge-belegt', PRUEFEN: 'badge-pruefen', KEIN_NACHWEIS: 'badge-kein', NULLSALDO: 'badge-grey', NICHT_IM_UMFANG: 'badge-grey' };

/** Status des Prüfgebiets: offen / in Arbeit / erledigt – mit Visum und Datum */
export function AreaStatusControl({ code, decisions, update, visum, compact = false }: { code: string; decisions: ReviewDecisions; update: Update; visum: string; compact?: boolean }) {
  const st = decisions.areaStatus?.[code];
  const cur: AreaState = st?.status ?? 'offen';
  const set = (s: AreaState) => update(d => {
    const { [code]: _x, ...rest } = d.areaStatus ?? {};
    return { ...d, areaStatus: s === 'offen' && !st ? rest : { ...rest, [code]: { status: s, at: new Date().toISOString(), visum: visum.trim() } } };
  });
  return (
    <div className={`area-status ${compact ? 'compact' : ''}`}>
      <div className="seg area-seg" role="radiogroup" aria-label={`Status Prüfgebiet ${code}`}>
        {AREA_STATES.map(([k, l]) => (
          <button key={k} role="radio" aria-checked={cur === k} className={`${cur === k ? `active st-${k}` : ''}`} onClick={() => set(k)}>{l}</button>
        ))}
      </div>
      {!compact && st && <span className="small muted">Visum <strong>{st.visum || '–'}</strong> · {date(st.at.slice(0, 10))}</span>}
    </div>
  );
}

/** Feststellungen der Gruppe (abhaken, entfernen, neue mit Enter) */
export function GroupFindings({ code, decisions, update, visum }: { code: string; decisions: ReviewDecisions; update: Update; visum: string }) {
  const [text, setText] = useState('');
  const findings = decisions.groupFindings?.[code] ?? [];
  const setF = (fn: (f: typeof findings) => typeof findings) => update(d => ({ ...d, groupFindings: { ...d.groupFindings, [code]: fn(d.groupFindings?.[code] ?? []) } }));
  const add = () => { if (!text.trim()) return; setF(f => [...f, { text: text.trim(), status: 'offen', at: new Date().toISOString(), visum: visum.trim() }]); setText(''); };
  return (
    <div className="stack" style={{ gap: 5 }}>
      {findings.map((f, i) => (
        <label key={i} className={`finding ${f.status}`}>
          <input type="checkbox" checked={f.status === 'erledigt'} onChange={e => setF(x => x.map((y, j) => (j === i ? { ...y, status: e.target.checked ? 'erledigt' : 'offen' } : y)))} />
          <span className="grow">{f.text}</span>
          <button className="icon-btn" aria-label="Feststellung entfernen" onClick={e => { e.preventDefault(); setF(x => x.filter((_, j) => j !== i)); }}>✕</button>
        </label>
      ))}
      <AutoTextarea placeholder="+ Neue Feststellung (Enter)" aria-label="Neue Feststellung" value={text} onChange={e => setText(e.target.value)} submitOnEnter onSubmit={add} />
    </div>
  );
}

/** Klick auf eine Gruppenzeile: Gruppen-Arbeitsbereich rechts – Kennzahlen, Konten, vertiefte Prüfung, Status, Feststellungen */
export function GroupPanel({ code, name, items, allAccounts, docs, decisions, update, visum, onOpenAccount, onDeepen, onAreas, onClose }: {
  code: string; name: string; items: ViewAccount[]; allAccounts: ViewAccount[]; docs: ViewDoc[]; decisions: ReviewDecisions; update: Update; visum: string;
  onOpenAccount: (num: string) => void; onDeepen?: () => void; onAreas?: () => void; onClose: () => void;
}) {
  const r = areaRow(code, name, items, decisions, allAccounts);
  const regOf = (a: ViewAccount) => docs.find(d => d.id === a.docId)?.register ?? null;
  const delta = r.py ? (Math.abs(r.cy) - Math.abs(r.py)) / Math.abs(r.py) : null;
  const otherFindings = r.findings.length - (decisions.groupFindings?.[code]?.length ?? 0);
  return (
    <aside className="panel preview-panel group-panel" aria-label={`Gruppe ${name}`}>
      <div className="panel-title">
        {r.letter && <span className="register">{r.letter}</span>}
        <h3>{name}</h3>
        <span className="panel-nav"><button aria-label="Schliessen (Esc)" onClick={onClose}>✕</button></span>
      </div>
      <div className="group-kpis">
        <div><span>Saldo</span><strong>{chf(r.cy)}</strong></div>
        <div><span>Vorjahr</span><strong>{chf(r.py)}</strong></div>
        <div><span>Veränderung</span><strong className={delta !== null && Math.abs(delta) >= 0.2 ? 'warn-text' : ''}>{delta === null ? '–' : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} %`}</strong></div>
        <div><span>Abdeckung</span><strong>{r.coverage === null ? '–' : pct(r.coverage)}</strong></div>
      </div>
      <table className="grid small clickable">
        <thead><tr><th>Konto</th><th>Bezeichnung</th><th className="num">Saldo</th><th>Status</th><th>Reg.</th></tr></thead>
        <tbody>
          {items.map(a => (
            <tr key={a.accountNumber} onClick={() => onOpenAccount(a.accountNumber)} data-gruppenkonto={a.accountNumber}>
              <td>{a.accountNumber}</td><td>{a.accountName}</td><td className="num">{chf(a.balance)}</td>
              <td><span className={`badge ${STATUS_CLS[a.status] ?? ''}`}>{STATUS_TEXT[a.status] ?? a.status}</span></td>
              <td>{regOf(a) ? <span className="register sm">{regOf(a)}</span> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="group-section">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>Vertiefte Prüfung{r.analysis ? `: ${r.analysis}` : ''}</strong>
          <span className="row" style={{ gap: 6 }}>
            {onDeepen && <button className="btn btn-sm" onClick={onDeepen}>⤢ Im Fokus-Modus prüfen</button>}
            {r.analysis && onAreas && <button className="btn btn-sm" onClick={onAreas}>Ganze Analyse</button>}
          </span>
        </div>
        {!r.analysis && <p className="small muted">Keine eigene Analyse – Vorjahresvergleich und Nachweise je Konto. Feststellungen unten erfassen.</p>}
      </div>
      <div className="group-section">
        <strong>Status</strong>
        <AreaStatusControl code={code} decisions={decisions} update={update} visum={visum} />
      </div>
      <div className="group-section">
        <strong>Feststellungen der Gruppe</strong>
        {otherFindings > 0 && <p className="small muted">+ {otherFindings} Feststellung{otherFindings > 1 ? 'en' : ''} aus der vertieften Prüfung ({r.findings.slice(-otherFindings).filter(f => f.status === 'offen').length} offen)</p>}
        <GroupFindings code={code} decisions={decisions} update={update} visum={visum} />
      </div>
      {r.letter && r.analysis && <p className="small muted">Ablage beim Abschluss: {r.letter}.100_Analyse … · Beilagen {r.letter}.100.1 …</p>}
    </aside>
  );
}
