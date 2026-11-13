import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { bsb } from '../bridge';
import { chf } from '../format';
import { AutoTextarea, Modal, Spinner, useToast } from '../components/ui';
import { useDragAutoScroll } from '../components/dragScroll';
import type { IncomeAccount, IncomeAmounts, IncomeAnalysis, IncomeBase, ReviewDecisions } from '../../electron/shared';

const pct = (x: number | null) => (x === null ? '' : `${(x * 100).toFixed(1)} %`);
const dpct = (x: number | null) => (x === null ? '' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)} %`);
/** Gruppe des KMU-Kontenrahmens je Abschnitt der Staffel (wie engine/src/analysis/incomeStatement.ts) */
const SECTION_GROUP: Record<string, string | null> = { ertrag: 'E30', material: 'E40', personal: 'E50', betrieb: 'E60', abschreibungen: 'E60', finanz: 'E60', neben: 'E70', ausserordentlich: 'E80', ohne: null, steuern: 'E89' };

/**
 * Analyse der Erfolgsrechnung: Staffel nach KMU-Kontenrahmen mit Margen, Relationszahlen zu einer wählbaren Bezugsgrösse,
 * Vorjahresvergleich, Bemerkungen und Verschieben von Konten per Drag & Drop (mit automatischem Scrollen).
 */
export function IncomeAnalysisView({ historyId, decisions, update, visum, closingDate, onMoveGroup }: {
  historyId: string; decisions: ReviewDecisions; update: (fn: (d: ReviewDecisions) => ReviewDecisions) => void; visum: string; closingDate: string | null;
  /** Konto in eine Gruppe des KMU-Kontenrahmens verschieben (null = automatische Gruppe) */
  onMoveGroup: (accountNumber: string, groupCode: string | null, quiet?: boolean) => void;
}) {
  const toast = useToast();
  const [a, setA] = useState<IncomeAnalysis | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pickBase, setPickBase] = useState(false);
  // nach dem Ablegen: Untergruppe mit dem verschobenen Konto aufklappen
  const [reveal, setReveal] = useState<{ num: string; section: string } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useDragAutoScroll(wrap, !!drag);
  const notes = decisions.incomeNotes ?? {};
  const base = decisions.incomeBase ?? null;
  const placements = decisions.incomePlacements ?? {};
  const params = { groupOverrides: decisions.groupOverrides, base, placements };
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    void bsb().review.analysis(historyId, 'income', params).then(setA, e => toast('error', (e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyId, paramsKey, toast]);
  useEffect(() => {
    if (!a || !reveal) return;
    // erst wenn die neue Berechnung das Konto im Zielabschnitt zeigt
    const sec = a.rows.find(r => r.key === `S:${reveal.section}`);
    if (!sec || sec.kind !== 'section') return;
    const sub = sec.subs.find(x => x.accounts.some(y => y.accountNumber === reveal.num));
    if (!sub && !sec.accounts.some(y => y.accountNumber === reveal.num)) return;
    if (sub) setOpen(s => new Set(s).add(sub.key));
    setReveal(null);
  }, [a, reveal]);

  const setNote = (key: string, text: string) => update(d => {
    const { [key]: _old, ...rest } = d.incomeNotes ?? {};
    return { ...d, incomeNotes: text.trim() ? { ...rest, [key]: { text, at: new Date().toISOString(), visum: visum.trim() } } : rest };
  });
  const setBase = (b: IncomeBase | null) => update(d => ({ ...d, incomeBase: b }));
  const toggle = (k: string) => setOpen(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allSubs = a ? a.rows.flatMap(r => (r.kind === 'section' ? r.subs.map(s => s.key) : [])) : [];
  const accounts = useMemo(() => (a ? a.rows.flatMap(r => (r.kind === 'section' ? [...r.subs.flatMap(s => s.accounts), ...r.accounts] : [])) : []), [a]);
  const exportExcel = async () => {
    const f = await bsb().review.exportAnalysis(historyId, 'income', { ...params, notes, visum }, 'Analyse_Erfolgsrechnung.xlsx');
    if (f) toast('ok', 'Analyse der Erfolgsrechnung gespeichert.');
  };
  /** Konto auf Abschnitt bzw. Untergruppe ziehen: Platzierung in der Staffel und Gruppe des Kontenrahmens */
  const drop = (num: string, section: string, sub?: string) => {
    update(d => ({ ...d, incomePlacements: { ...d.incomePlacements, [num]: { section, ...(sub ? { sub } : {}) } } }));
    const g = SECTION_GROUP[section];
    if (g !== undefined && g !== null) onMoveGroup(num, g, true);
    const sec = a?.rows.find(r => r.key === `S:${section}`);
    const subLabel = sec && sec.kind === 'section' ? sec.subs.find(x => x.id === sub)?.label : undefined;
    toast('ok', `Konto ${num} → ${sec?.label ?? section}${subLabel ? ` › ${subLabel}` : ''}`);
    setReveal({ num, section });
    setDrag(null); setOver(null);
  };
  const resetPlacement = (num: string) => {
    update(d => { const { [num]: _x, ...rest } = d.incomePlacements ?? {}; return { ...d, incomePlacements: rest }; });
    onMoveGroup(num, null, true);
    toast('ok', `Konto ${num}: automatische Gruppe`);
  };
  if (!a) return <Spinner label="Erfolgsrechnung wird analysiert …" />;
  const year = closingDate?.slice(0, 4) ?? 'Aktuell';
  const prev = closingDate ? String(Number(closingDate.slice(0, 4)) - 1) : 'Vorjahr';
  const nNotes = Object.values(notes).filter(n => n.text.trim()).length;
  const baseValue = base?.kind === 'accounts' ? '__accounts' : base?.kind === 'line' ? base.key : 'R:betriebsertrag';
  const pctHead = a.base.key === 'R:betriebsertrag' ? '%' : '% Bezug';

  const target = (section: string, sub?: string) => {
    const k = sub ? `U:${section}/${sub}` : `S:${section}`;
    return drag ? {
      onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== k) setOver(k); },
      onDrop: (e: React.DragEvent) => { e.preventDefault(); drop(drag, section, sub); },
      className: over === k ? 'drop-target' : '',
    } : { className: '' };
  };
  const cells = (x: IncomeAmounts) => (
    <>
      <td className="num cur">{chf(x.cy)}</td><td className="num pct">{pct(x.pctCy)}</td>
      {a.hasPreviousYear && <><td className="num">{chf(x.py ?? 0)}</td><td className="num pct">{pct(x.pctPy)}</td><td className="num">{x.diff ? chf(x.diff) : '–'}</td><td className="num pct">{dpct(x.diffPct)}</td></>}
    </>
  );
  const note = (key: string, label: string) => (
    <td className="note-cell" onClick={e => e.stopPropagation()}>
      <AutoTextarea className="inline-note" defaultValue={notes[key]?.text ?? ''} placeholder="Bemerkung …" aria-label={`Bemerkung ${label}`} key={`${key}:${notes[key]?.text ?? ''}`} submitOnEnter
        onBlur={e => { if (e.target.value !== (notes[key]?.text ?? '')) setNote(key, e.target.value); }} />
    </td>
  );
  const accountRow = (ac: IncomeAccount, section: string, sub?: string) => {
    const t = target(section, sub);
    return (
      <tr key={ac.key} className={`inc-account ${ac.big ? 'inc-big' : ''} ${t.className} ${drag === ac.accountNumber ? 'dragging' : ''}`} data-inc={ac.key} draggable
        onDragStart={e => { e.dataTransfer.setData('text/plain', ac.accountNumber); e.dataTransfer.effectAllowed = 'move'; setDrag(ac.accountNumber); }}
        onDragEnd={() => { setDrag(null); setOver(null); }} onDragOver={t.onDragOver} onDrop={t.onDrop}>
        <td className="mono">{ac.accountNumber}</td>
        <td title={ac.accountName}>{ac.accountName}{placements[ac.accountNumber] && <button className="flag moved" title="Verschiebung aufheben (automatische Gruppe)" onClick={() => resetPlacement(ac.accountNumber)}>verschoben ↺</button>}</td>
        {cells(ac)}{note(ac.key, ac.accountName)}
      </tr>
    );
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row small">
        <label className="field inline"><span>Relationszahlen (%) in Bezug auf</span>
          <select className="base-select" aria-label="Bezugsgrösse" value={baseValue} onChange={e => {
            const v = e.target.value;
            if (v === '__accounts') setPickBase(true);
            else setBase(v === 'R:betriebsertrag' ? null : { kind: 'line', key: v });
          }}>
            <optgroup label="Ergebnisse">{a.rows.filter(r => r.kind === 'result').map(r => <option key={r.key} value={r.key}>{r.label}{r.key === 'R:betriebsertrag' ? ' (Standard, 100 %)' : ''}</option>)}</optgroup>
            <optgroup label="Gruppen">{a.rows.filter(r => r.kind === 'section').map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</optgroup>
            <optgroup label="Untergruppen">{a.rows.flatMap(r => (r.kind === 'section' ? r.subs.map(s => <option key={s.key} value={s.key}>{r.label.length > 30 ? `${r.label.slice(0, 29)}…` : r.label} › {s.label}</option>) : []))}</optgroup>
            <option value="__accounts">{base?.kind === 'accounts' ? `Einzelkonten: ${a.base.label}` : 'Einzelkonten wählen …'}</option>
          </select>
        </label>
        {base?.kind === 'accounts' && <button className="link small" onClick={() => setPickBase(true)}>Konten ändern …</button>}
        <span className="muted">Ertrag positiv, Aufwand negativ{a.signFlipped ? ' (Vorzeichen der Saldobilanz gedreht)' : ''} · Konto per Drag &amp; Drop in eine andere Gruppe ziehen{!a.hasPreviousYear && ' · Saldobilanz ohne Vorjahr'}</span>
        <span className="ml-auto" />
        <button className="link small" onClick={() => setOpen(s => (s.size ? new Set() : new Set(allSubs)))}>{open.size ? 'Konten zuklappen' : 'Alle Konten aufklappen'}</button>
        <button className="btn btn-sm" onClick={() => void exportExcel()}>Excel herunterladen</button>
      </div>
      <div className="table-wrap" ref={wrap}>
        <table className="grid income">
          <thead><tr>
            <th>Konto</th><th>Bezeichnung</th><th className="num">{year}</th><th className="num" title={`Anteil an: ${a.base.label}`}>{pctHead}</th>
            {a.hasPreviousYear && <><th className="num">{prev}</th><th className="num" title={`Anteil an: ${a.base.label}`}>{pctHead}</th><th className="num">Differenz</th><th className="num">Differenz %</th></>}
            <th>Bemerkungen</th>
          </tr></thead>
          <tbody>
            {a.rows.map(r => {
              if (r.kind === 'result') return <tr key={r.key} className={`inc-result ${a.base.key === r.key ? 'inc-base' : ''}`} data-inc={r.key}><td colSpan={2}>{r.label}</td>{cells(r)}{note(r.key, r.label)}</tr>;
              const ts = target(r.id);
              return (
                <Fragment key={r.key}>
                  <tr className={`inc-section ${ts.className} ${a.base.key === r.key ? 'inc-base' : ''}`} data-inc={r.key} onDragOver={ts.onDragOver} onDrop={ts.onDrop}><td colSpan={2}>{r.label}</td>{cells(r)}{note(r.key, r.label)}</tr>
                  {r.subs.map(s => {
                    const tu = target(r.id, s.id);
                    return (
                      <Fragment key={s.key}>
                        <tr className={`inc-sub clickable-row ${tu.className} ${a.base.key === s.key ? 'inc-base' : ''}`} data-inc={s.key} onClick={() => toggle(s.key)} aria-expanded={open.has(s.key)} onDragOver={tu.onDragOver} onDrop={tu.onDrop}>
                          <td><span className="caret">{open.has(s.key) ? '⌄' : '›'}</span></td><td>{s.label} <span className="muted small">({s.accounts.length})</span></td>{cells(s)}{note(s.key, s.label)}
                        </tr>
                        {open.has(s.key) && s.accounts.map(ac => accountRow(ac, r.id, s.id))}
                      </Fragment>
                    );
                  })}
                  {r.accounts.map(ac => accountRow(ac, r.id))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Prozente: Anteil an „{a.base.label}“. Gliederung: Gruppe des Kontos, innerhalb der Gruppe nach den ersten zwei Ziffern der Kontonummer; per Drag &amp; Drop verschobene Konten erhalten die Gruppe des Ziels (auch in Bilanz/Kontenansicht).
        Auffällige Veränderungen (≥ 25 % und ≥ CHF 1'000) sind markiert. {nNotes ? `${nNotes} Bemerkung${nNotes > 1 ? 'en' : ''} erfasst – ` : ''}Beim Abschliessen wird die Analyse als „Analyse_Erfolgsrechnung.xlsx“ abgelegt, sobald Bemerkungen erfasst sind.
      </p>
      {pickBase && <BasePicker accounts={accounts} initial={base?.kind === 'accounts' ? base.accounts : []} onClose={() => setPickBase(false)}
        onApply={list => { setBase(list.length ? { kind: 'accounts', accounts: list } : null); setPickBase(false); }} />}
    </div>
  );
}

/** Bezugsgrösse aus Einzelkonten: Konten suchen und ankreuzen */
function BasePicker({ accounts, initial, onApply, onClose }: { accounts: IncomeAccount[]; initial: string[]; onApply: (list: string[]) => void; onClose: () => void }) {
  const [sel, setSel] = useState<string[]>(initial);
  const [q, setQ] = useState('');
  const t = q.trim().toLowerCase();
  const list = accounts.filter(x => !t || x.accountNumber.includes(t) || x.accountName.toLowerCase().includes(t)).sort((x, y) => x.accountNumber.localeCompare(y.accountNumber, 'de', { numeric: true }));
  const total = accounts.filter(x => sel.includes(x.accountNumber)).reduce((s, x) => s + x.cy, 0);
  return (
    <Modal title="Bezugsgrösse: Einzelkonten wählen" wide onClose={onClose}
      footer={<><span className="small muted grow">{sel.length} Konten · CHF {chf(total)}</span><button className="btn" onClick={onClose}>Abbrechen</button><button className="btn btn-primary" disabled={!sel.length} onClick={() => onApply(sel)}>Übernehmen</button></>}>
      <input className="w-md" type="search" placeholder="Konto suchen …" value={q} onChange={e => setQ(e.target.value)} aria-label="Konto suchen" autoFocus />
      <div className="additions-scroll" style={{ marginTop: 8 }}>
        <table className="grid small">
          <tbody>
            {list.map(x => (
              <tr key={x.accountNumber}>
                <td><input type="checkbox" aria-label={`Bezug ${x.accountNumber}`} checked={sel.includes(x.accountNumber)} onChange={e => setSel(s => (e.target.checked ? [...s, x.accountNumber] : s.filter(y => y !== x.accountNumber)))} /></td>
                <td className="mono">{x.accountNumber}</td><td>{x.accountName}</td><td className="num">{chf(x.cy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
