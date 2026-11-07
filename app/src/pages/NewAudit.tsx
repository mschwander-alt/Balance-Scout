import { useEffect, useState, type DragEvent } from 'react';
import { bsb } from '../bridge';
import type { AppSettings, ColumnMapping, FileMode, JobInput, PickedPath, SignConvention, TbPreview } from '../../electron/shared';
import { chf } from '../format';
import { Modal, Spinner, useToast } from '../components/ui';

export function NewAudit({ prefill, onStart }: { prefill?: Partial<JobInput>; onStart: (i: JobInput) => void }) {
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [mandate, setMandate] = useState(prefill?.mandate ?? '');
  const [client, setClient] = useState(prefill?.client ?? '');
  const [closing, setClosing] = useState(prefill?.closingDate ?? `${new Date().getFullYear() - 1}-12-31`);
  const [tb, setTb] = useState<PickedPath | null>(prefill?.trialBalancePath ? { path: prefill.trialBalancePath, name: prefill.trialBalancePath.split(/[\\/]/).pop()!, isDirectory: false } : null);
  const [sign, setSign] = useState<SignConvention>(prefill?.signConvention ?? 'signed');
  const [mapping, setMapping] = useState<TbPreview['detected']>(prefill?.trialBalanceMapping ?? null);
  const [preview, setPreview] = useState<TbPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [showMapping, setShowMapping] = useState(false);
  const [evidence, setEvidence] = useState<PickedPath[]>((prefill?.evidencePaths ?? []).map(p => ({ path: p, name: p.split(/[\\/]/).pop()!, isDirectory: !/\.[a-z0-9]{2,5}$/i.test(p) })));
  const [target, setTarget] = useState<string | null>(prefill?.targetDir ?? null);
  const [mode, setMode] = useState<FileMode>(prefill?.fileMode ?? 'copy');
  const [tol, setTol] = useState(prefill ? (prefill.absoluteToleranceCents! / 100).toFixed(2) : '1.00');
  const [over, setOver] = useState<'tb' | 'ev' | null>(null);

  useEffect(() => {
    void bsb().app.settings().then(s => {
      setSettings(s);
      if (!prefill) {
        setMode(s.fileMode);
        setTol(s.toleranceChf);
        setSign(s.signConvention);
      }
    });
  }, [prefill]);

  // Vorschau der Saldobilanz bei Änderung
  useEffect(() => {
    if (!tb) return setPreview(null);
    setPreviewBusy(true);
    bsb().engine.previewTrialBalance(tb.path, sign, mapping).then(
      p => {
        setPreview(p);
        if (!p.detected) setShowMapping(true);
      },
      e => toast('error', `Saldobilanz: ${(e as Error).message}`),
    ).finally(() => setPreviewBusy(false));
  }, [tb, sign, mapping, toast]);

  const addEvidence = (items: PickedPath[]) => setEvidence(ev => [...ev, ...items.filter(i => !ev.some(e => e.path === i.path))]);
  const onDrop = async (e: DragEvent, kind: 'tb' | 'ev') => {
    e.preventDefault();
    setOver(null);
    const picked = (await Promise.all([...e.dataTransfer.files].map(f => bsb().pick.pathOf(f)))).filter((x): x is PickedPath => !!x);
    if (kind === 'tb') {
      const f = picked.find(p => !p.isDirectory && /\.(xlsx|xlsm|xls|csv)$/i.test(p.name));
      if (!f) return toast('error', 'Bitte eine Excel- oder CSV-Datei als Saldobilanz ablegen.');
      setMapping(null);
      setTb(f);
    } else addEvidence(picked);
  };
  const dropProps = (kind: 'tb' | 'ev') => ({
    onDragOver: (e: DragEvent) => { e.preventDefault(); setOver(kind); },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => void onDrop(e, kind),
    className: `drop ${over === kind ? 'over' : ''}`,
  });

  const suggestedTarget = () => {
    const base = settings?.defaultTargetBase;
    const year = closing.slice(0, 4);
    return base && mandate ? `${base.replace(/[\\/]$/, '')}\\${mandate.replace(/[<>:"/\\|?*]/g, '_')}\\JA ${year}` : undefined;
  };

  const tolCents = Math.round(Number(tol.replace(',', '.').replace(/'/g, '')) * 100);
  const problems = [
    !mandate.trim() && 'Mandat angeben',
    !tb && 'Saldobilanz wählen',
    tb && preview && !preview.detected && 'Spalten der Saldobilanz zuordnen',
    !evidence.length && 'Unterlagen des Kunden wählen',
    mode !== 'none' && !target && 'Zielordner wählen (oder „nicht ablegen“)',
    !Number.isFinite(tolCents) || tolCents < 0 ? 'Toleranz ungültig' : null,
    evidence.some(e => target && (target === e.path || target.startsWith(e.path + '\\') || target.startsWith(e.path + '/'))) && mode === 'move' ? 'Beim Verschieben darf der Zielordner nicht im Kundenordner liegen' : null,
  ].filter(Boolean) as string[];

  const start = () =>
    onStart({
      mandate: mandate.trim(), client: client.trim() || undefined, closingDate: closing || null, trialBalancePath: tb!.path,
      trialBalanceMapping: mapping ?? undefined, signConvention: sign, evidencePaths: evidence.map(e => e.path),
      targetDir: mode === 'none' ? null : target, fileMode: mode, absoluteToleranceCents: tolCents,
    });

  return (
    <div className="page stack">
      <div className="card">
        <p className="step"><span className="num">1</span><strong>Mandat</strong></p>
        <div className="grid3">
          <label className="field"><span>Mandat / Bezeichnung</span><input value={mandate} onChange={e => setMandate(e.target.value)} placeholder="z. B. Muster AG" autoFocus /></label>
          <label className="field"><span>Kunde (optional)</span><input value={client} onChange={e => setClient(e.target.value)} /></label>
          <label className="field"><span>Bilanzstichtag</span><input type="date" value={closing} onChange={e => setClosing(e.target.value)} /></label>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <p className="step"><span className="num">2</span><strong>Saldobilanz</strong></p>
          <div {...dropProps('tb')}>
            {tb ? <><strong>{tb.name}</strong><div className="small">{tb.path}</div></> : <>Excel/CSV hierher ziehen oder</>}
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-sm" onClick={async () => { const f = await bsb().pick.trialBalance(); if (f) { setMapping(null); setTb(f); } }}>{tb ? 'Andere Datei …' : 'Datei wählen …'}</button>
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <label className="field inline"><span>Vorzeichen</span>
              <select value={sign} onChange={e => setSign(e.target.value as SignConvention)}>
                <option value="signed">Soll + / Haben −</option>
                <option value="unsigned">Alle Salden positiv</option>
              </select>
            </label>
            {tb && <button className="link small" onClick={() => setShowMapping(true)}>Spalten zuordnen …</button>}
          </div>
          {previewBusy && <Spinner label="Saldobilanz wird geprüft …" />}
          {preview?.validation && !previewBusy && (
            <div style={{ marginTop: 10 }}>
              <div className={preview.validation.ok ? 'ok-box' : 'warn-box'}>
                {preview.validation.accountCount} Konten erkannt ·{' '}
                {preview.validation.checks.map(c => `${c.passed ? '✓' : '✗'} ${c.name.replace('Aktuelles Jahr: ', '')}`).join(' · ')}
              </div>
              {preview.validation.issues.filter(i => i.severity === 'error').slice(0, 3).map((i, n) => <p key={n} className="error-text small">Zeile {i.rowIndex}: {i.message}</p>)}
              {!preview.validation.checks.every(c => c.passed) && <p className="small muted">Tipp: Vorzeichen-Einstellung prüfen. Die Prüfung kann trotzdem gestartet werden.</p>}
            </div>
          )}
        </div>

        <div className="card">
          <p className="step"><span className="num">3</span><strong>Unterlagen des Kunden</strong></p>
          <div {...dropProps('ev')}>
            Ordner oder Dateien hierher ziehen – Unterordner werden mitgelesen.
            <div className="small">PDF (auch Scans), Bilder, Excel (xlsx/xls), CSV, Word</div>
            <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
              <button className="btn btn-sm" onClick={async () => addEvidence(await bsb().pick.evidence('folders'))}>Ordner wählen …</button>
              <button className="btn btn-sm" onClick={async () => addEvidence(await bsb().pick.evidence('files'))}>Dateien wählen …</button>
            </div>
            {evidence.length > 0 && (
              <ul className="paths">
                {evidence.map(e => (
                  <li key={e.path}>
                    <span>{e.isDirectory ? '📁' : '📄'}</span>
                    <span className="grow" title={e.path}>{e.path}</span>
                    <button className="icon-btn" aria-label="entfernen" onClick={() => setEvidence(ev => ev.filter(x => x.path !== e.path))}>✕</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Tipp: Synchronisierte OneDrive-/SharePoint-Ordner im Explorer funktionieren wie normale Ordner.</p>
        </div>
      </div>

      <div className="card">
        <p className="step"><span className="num">4</span><strong>Ablage und Dokumentation</strong></p>
        <div className="row">
          <label className="field inline"><span>Belege</span>
            <select value={mode} onChange={e => setMode(e.target.value as FileMode)}>
              <option value="copy">kopieren (Original bleibt beim Kunden)</option>
              <option value="move">verschieben</option>
              <option value="none">nicht ablegen (nur Excel)</option>
            </select>
          </label>
          {mode !== 'none' && (
            <>
              <button className="btn btn-sm" onClick={async () => { const d = await bsb().pick.targetDir(suggestedTarget()); if (d) setTarget(d); }}>Zielordner wählen …</button>
              {!target && suggestedTarget() && <button className="link small" onClick={() => setTarget(suggestedTarget()!)}>Vorschlag: {suggestedTarget()}</button>}
              {target && <code className="small">{target}</code>}
            </>
          )}
          <label className="field inline ml-auto"><span>Toleranz CHF</span><input className="w-sm" value={tol} onChange={e => setTol(e.target.value)} /></label>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          {mode === 'none'
            ? 'Die Excel-Dokumentation wird neben der Saldobilanz gespeichert.'
            : <>Im Zielordner entstehen <code>01_Zugeordnet</code>, <code>02_Nicht_zugeordnet</code> und die Excel-Dokumentation. Vorhandene Dateien werden nie überschrieben.</>}
          {mode === 'move' && <strong className="warn"> Achtung: Die Dateien werden aus dem Kundenordner entfernt.</strong>}
        </p>
      </div>

      <div className="row-end">
        {problems.length > 0 && <span className="muted small">{problems.join(' · ')}</span>}
        <button className="btn btn-primary btn-lg" disabled={problems.length > 0} onClick={start}>Prüfung starten</button>
      </div>

      {showMapping && tb && (
        <MappingDialog
          preview={preview}
          current={mapping ?? preview?.detected ?? null}
          onClose={() => setShowMapping(false)}
          onApply={m => { setMapping(m); setShowMapping(false); }}
        />
      )}
    </div>
  );
}

function MappingDialog({ preview, current, onClose, onApply }: { preview: TbPreview | null; current: TbPreview['detected']; onClose: () => void; onApply: (m: NonNullable<TbPreview['detected']>) => void }) {
  const head = preview?.head ?? [];
  const [hdr, setHdr] = useState(current?.headerRowIndex ?? 0);
  const [m, setM] = useState<Partial<ColumnMapping>>(current?.mapping ?? {});
  const cols = Math.max(0, ...head.map(r => r.length));
  const colName = (i: number) => `${String.fromCharCode(65 + i)}${head[hdr]?.[i] ? ` – ${head[hdr]![i]}` : ''}`;
  const sel = (k: keyof ColumnMapping, label: string, optional = false) => (
    <label className="field inline"><span>{label}</span>
      <select value={m[k] ?? ''} onChange={e => setM({ ...m, [k]: e.target.value === '' ? undefined : Number(e.target.value) })}>
        <option value="">{optional ? '– keine –' : '– wählen –'}</option>
        {Array.from({ length: cols }, (_, i) => <option key={i} value={i}>{colName(i)}</option>)}
      </select>
    </label>
  );
  const valid = m.accountNumber !== undefined && m.accountName !== undefined && m.balanceCurrentYear !== undefined;
  return (
    <Modal title="Spalten der Saldobilanz zuordnen" wide onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn btn-primary" disabled={!valid} onClick={() => onApply({ headerRowIndex: hdr, mapping: m as ColumnMapping })}>Übernehmen</button>
    </>}>
      {!preview?.detected && <p className="warn-box small">Die Spalten wurden nicht automatisch erkannt. Bitte Kopfzeile anklicken und Spalten wählen.</p>}
      <div className="mapping-table">
        <table>
          <tbody>
            {head.slice(0, 25).map((r, i) => (
              <tr key={i} className={i === hdr ? 'header-row' : ''} onClick={() => setHdr(i)} style={{ cursor: 'pointer' }}>
                <td className="muted">{i + 1}</td>
                {Array.from({ length: cols }, (_, c) => <td key={c}>{r[c]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">Kopfzeile: Zeile {hdr + 1} (anklicken zum Ändern)</p>
      <div className="row">
        {sel('accountNumber', 'Kontonummer')}
        {sel('accountName', 'Bezeichnung')}
        {sel('balanceCurrentYear', 'Saldo Stichtag')}
        {sel('balancePreviousYear', 'Saldo Vorjahr', true)}
      </div>
      {preview?.accounts.length ? <p className="small muted">Beispiel: {preview.accounts.slice(0, 3).map(a => `${a.accountNumber} ${a.accountName} ${chf(a.balance)}`).join(' · ')}</p> : null}
    </Modal>
  );
}
