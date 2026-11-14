import { Fragment, useEffect, useState, type DragEvent } from 'react';
import { bsb } from '../bridge';
import type { AppSettings, CloudLocation, ColumnMapping, ExplicitMapping, FileMode, FxRateList, GroupsInfo, JobInput, PartRole, PickedPath, SignConvention, TbPart, TbPreview } from '../../electron/shared';
import { chf } from '../format';
import { Info, Modal, Spinner, useToast } from '../components/ui';
import { groupAccounts } from '../review';
import { ExcludedTable } from './Result';

const picked = (p: string): PickedPath => ({ path: p, name: p.split(/[\\/]/).pop()!, isDirectory: false });

export function NewAudit({ prefill, onStart }: { prefill?: Partial<JobInput>; onStart: (i: JobInput) => void }) {
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [mandate, setMandate] = useState(prefill?.mandate ?? '');
  const [client, setClient] = useState(prefill?.client ?? '');
  const [closing, setClosing] = useState(prefill?.closingDate ?? `${new Date().getFullYear() - 1}-12-31`);
  // Saldobilanz: eine oder mehrere Dateien (z. B. Bilanz und Erfolgsrechnung getrennt)
  const [tbs, setTbs] = useState<PickedPath[]>((prefill?.trialBalancePaths ?? (prefill?.trialBalancePath ? [prefill.trialBalancePath] : [])).map(picked));
  const [sign, setSign] = useState<SignConvention>(prefill?.signConvention ?? 'signed');
  const [mappings, setMappings] = useState<Record<string, ExplicitMapping>>(prefill?.trialBalanceMappings ?? (prefill?.trialBalanceMapping && prefill.trialBalancePath ? { [prefill.trialBalancePath]: prefill.trialBalanceMapping } : {}));
  const [digits, setDigits] = useState<{ min: number; max: number } | null>(prefill?.accountDigits ?? null);
  const [digitsTouched, setDigitsTouched] = useState(!!prefill?.accountDigits);
  const [skipZero, setSkipZero] = useState(!!prefill?.skipZeroBalances);
  // Verwendung je Blatt (Bilanz / Erfolgsrechnung / beides / nicht verwenden); ohne Eintrag: automatisch
  const [roles, setRoles] = useState<Record<string, PartRole>>(prefill?.partRoles ?? {});
  const setRole = (id: string, r: PartRole) => setRoles(cur => { const { [id]: _x, ...rest } = cur; return r === 'auto' ? rest : { ...rest, [id]: r }; });
  const [mapPart, setMapPart] = useState<TbPart | null>(null);
  const [showAccounts, setShowAccounts] = useState(false);
  const [groups, setGroups] = useState<GroupsInfo | null>(null);
  useEffect(() => void bsb().review.groups().then(setGroups, () => undefined), []);
  const [preview, setPreview] = useState<TbPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [evidence, setEvidence] = useState<PickedPath[]>((prefill?.evidencePaths ?? []).map(p => ({ path: p, name: p.split(/[\\/]/).pop()!, isDirectory: !/\.[a-z0-9]{2,5}$/i.test(p) })));
  const [target, setTarget] = useState<string | null>(prefill?.targetDir ?? null);
  const [mode, setMode] = useState<FileMode>(prefill?.fileMode ?? 'copy');
  const [tol, setTol] = useState(prefill ? (prefill.absoluteToleranceCents! / 100).toFixed(2) : '1.00');
  const [over, setOver] = useState<'tb' | 'ev' | null>(null);
  const [cloud, setCloud] = useState<CloudLocation[] | null>(null);
  const [cloudHelp, setCloudHelp] = useState(false);
  // Kontoblätter (optional) und Fremdwährungskurse per Stichtag
  const [ledgers, setLedgers] = useState<PickedPath[]>((prefill?.ledgerPaths ?? []).map(picked));
  const [manualRates, setManualRates] = useState<Record<string, number> | null>(prefill?.fxRates?.source === 'manuell erfasst' ? prefill.fxRates.rates : null);
  const [showRates, setShowRates] = useState(false);
  useEffect(() => void bsb().pick.cloudLocations().then(setCloud, () => setCloud([])), []);

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
    if (!tbs.length) return setPreview(null);
    setPreviewBusy(true);
    bsb().engine.previewTrialBalance(tbs.map(t => t.path), sign, { mappings, accountDigits: digits, skipZeroBalances: skipZero, partRoles: roles }).then(
      p => {
        setPreview(p);
        // Ziffernbereich: Vorschlag übernehmen, solange der Benutzer nichts gewählt hat
        if (!digitsTouched && p.suggestedDigits && (p.suggestedDigits.min !== digits?.min || p.suggestedDigits.max !== digits?.max)) setDigits(p.suggestedDigits);
        const unmapped = p.parts?.find(x => x.status === 'zuordnen');
        if (unmapped) setMapPart(unmapped);
      },
      e => toast('error', `Saldobilanz: ${(e as Error).message}`),
    ).finally(() => setPreviewBusy(false));
  }, [tbs, sign, mappings, digits, digitsTouched, skipZero, roles, toast]);
  // Neue Datei(en): Ziffernbereich neu aus den Kontonummern vorschlagen (nie aus einer früheren Prüfung übernehmen)
  const addTb = (items: PickedPath[]) => {
    setTbs(cur => [...cur, ...items.filter(i => !cur.some(c => c.path === i.path))]);
    setDigitsTouched(false);
    setDigits(null);
  };
  // Ausgeblendete Zeilen mit MEHR Ziffern als eingestellt sind vermutlich echte Konten
  const longer = preview?.excluded?.filter(e => digits && e.accountNumber.replace(/\D/g, '').length > digits.max && e.balance !== null && e.balance !== 0) ?? [];
  const zeroSkipped = preview?.excluded?.filter(e => /^Saldo null/.test(e.reason)).length ?? 0;
  const longerDigits = longer.length ? Math.max(...longer.map(e => e.accountNumber.replace(/\D/g, '').length)) : 0;

  const addEvidence = (items: PickedPath[]) => setEvidence(ev => [...ev, ...items.filter(i => !ev.some(e => e.path === i.path))]);
  const onDrop = async (e: DragEvent, kind: 'tb' | 'ev') => {
    e.preventDefault();
    setOver(null);
    const items = (await Promise.all([...e.dataTransfer.files].map(f => bsb().pick.pathOf(f)))).filter((x): x is PickedPath => !!x);
    if (kind === 'tb') {
      const f = items.filter(p => !p.isDirectory && /\.(xlsx|xlsm|xls|csv|pdf)$/i.test(p.name));
      if (!f.length) return toast('error', 'Bitte Excel-, CSV- oder PDF-Dateien (Bilanz, Erfolgsrechnung) ablegen.');
      addTb(f);
    } else addEvidence(items);
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
    !tbs.length && 'Saldobilanz wählen',
    tbs.length && preview && (!preview.accounts.length || preview.parts?.some(x => x.status === 'zuordnen')) && 'Spalten der Saldobilanz zuordnen',
    digits && (digits.min < 1 || digits.max < digits.min) ? 'Ziffernbereich ungültig' : null,
    !evidence.length && 'Unterlagen des Kunden wählen',
    mode !== 'none' && !target && 'Zielordner wählen (oder „nicht ablegen“)',
    !Number.isFinite(tolCents) || tolCents < 0 ? 'Toleranz ungültig' : null,
    evidence.some(e => target && (target === e.path || target.startsWith(e.path + '\\') || target.startsWith(e.path + '/'))) && mode === 'move' ? 'Beim Verschieben darf der Zielordner nicht im Kundenordner liegen' : null,
  ].filter(Boolean) as string[];

  const rateList = settings?.fxRateLists?.[closing] ?? null;
  const fxRates: FxRateList | undefined = manualRates ? { date: closing, rates: manualRates, source: 'manuell erfasst' } : rateList ?? undefined;
  const start = () => {
    onStart({
      mandate: mandate.trim(), client: client.trim() || undefined, closingDate: closing || null, trialBalancePath: tbs[0]!.path,
      trialBalancePaths: tbs.map(t => t.path), trialBalanceMappings: Object.keys(mappings).length ? mappings : undefined,
      accountDigits: digits ?? undefined, skipZeroBalances: skipZero || undefined, partRoles: Object.keys(roles).length ? roles : undefined, signConvention: sign, evidencePaths: evidence.map(e => e.path),
      targetDir: mode === 'none' ? null : target, fileMode: mode, absoluteToleranceCents: tolCents,
      ledgerPaths: ledgers.length ? ledgers.map(l => l.path) : undefined, fxRates,
    });
  };
  const setDigit = (k: 'min' | 'max', v: string) => {
    const n = Math.max(1, Math.min(12, Number(v) || 1));
    setDigitsTouched(true);
    setDigits(d => {
      const cur = d ?? { min: n, max: n };
      const next = { ...cur, [k]: n };
      if (k === 'min' && next.max < n) next.max = n;
      if (k === 'max' && next.min > n) next.min = n;
      return next;
    });
  };

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
          <p className="step"><span className="num">2</span><strong>Bilanz und Erfolgsrechnung</strong></p>
          <div {...dropProps('tb')}>
            {tbs.length ? (
              <ul className="paths">
                {tbs.map(t => (
                  <li key={t.path}>
                    <span>📄</span><span className="grow" title={t.path}><strong>{t.name}</strong></span>
                    <button className="icon-btn" aria-label="entfernen" onClick={() => setTbs(cur => cur.filter(x => x.path !== t.path))}>✕</button>
                  </li>
                ))}
              </ul>
            ) : <>Saldobilanz bzw. Bilanz und Erfolgsrechnung hierher ziehen – eine Datei oder mehrere (Excel, CSV, PDF, auch Scan)</>}
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-sm" onClick={async () => { const f = await bsb().pick.trialBalance(); if (f) addTb([f]); }}>{tbs.length ? 'Weitere Datei …' : 'Datei wählen …'}</button>
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <label className="field inline"><span>Kontonummern</span>
              <span className="row" style={{ gap: 4 }}>
                von <input className="w-xs" type="number" min={1} max={12} aria-label="Ziffern von" value={digits?.min ?? ''} onChange={e => setDigit('min', e.target.value)} />
                bis <input className="w-xs" type="number" min={1} max={12} aria-label="Ziffern bis" value={digits?.max ?? ''} onChange={e => setDigit('max', e.target.value)} /> Ziffern
              </span>
            </label>
            <label className="field inline"><span>Vorzeichen</span>
              <select value={sign} onChange={e => setSign(e.target.value as SignConvention)}>
                <option value="signed">Soll + / Haben −</option>
                <option value="unsigned">Alle Salden positiv</option>
              </select>
            </label>
            <label className="field inline check">
              <input type="checkbox" checked={skipZero} onChange={e => setSkipZero(e.target.checked)} />
              <span>Konten mit Saldo null nicht importieren</span>
              <Info label="Zu Konten mit Saldo null">Nicht importiert werden Konten mit Saldo null im laufenden Jahr <em>und</em> im Vorjahr. Enthält die Saldobilanz kein Vorjahr, genügt Saldo null im laufenden Jahr. Die Konten bleiben unter „Ausgeblendete Zeilen“ nachvollziehbar.</Info>
            </label>
          </div>
          {skipZero && preview && !previewBusy && zeroSkipped > 0 && <p className="small muted">{zeroSkipped} Konten mit Saldo null werden nicht importiert.</p>}
          {digits && !digitsTouched && preview?.suggestedDigits && <p className="small muted">Ziffernbereich aus den Kontonummern der Datei vorgeschlagen – Gruppen und Zwischensummen mit kürzeren Nummern werden ausgeblendet.</p>}
          {longer.length > 0 && (
            <div className="warn-box small" style={{ marginTop: 6 }}>
              {longer.length} Zeilen mit {longerDigits}-stelliger Nummer und Saldo werden ausgeblendet (z. B. {longer.slice(0, 2).map(e => `${e.accountNumber} ${e.accountName}`).join(', ')}) – vermutlich Konten.{' '}
              <button className="link small" onClick={() => { setDigitsTouched(true); setDigits(d => ({ min: d?.min ?? longerDigits, max: longerDigits })); }}>Bereich auf {digits?.min}–{longerDigits} Ziffern erweitern</button>
            </div>
          )}
          {previewBusy && <Spinner label="Saldobilanz wird geprüft …" />}
          {preview && !previewBusy && (
            <div style={{ marginTop: 10 }}>
              {preview.parts && preview.parts.length > 0 && (
                <ul className="parts small">
                  {preview.parts.map(p => {
                    // Excel mit mehreren Blättern: Prüfer wählt, welches Blatt Bilanz bzw. Erfolgsrechnung ist
                    const multiSheet = !!p.sheet && preview.parts!.filter(x => x.path === p.path).length > 1;
                    return (
                      <li key={p.id} className={`${p.status} part-line`}>
                        <span className="grow">
                          {p.label}: {p.status === 'ok' ? `${p.accountCount} Konten` : p.status === 'ignoriert' ? (p.reason ? `nicht verwendet – ${p.reason}` : 'keine Kontenliste (ignoriert)') : 'Spalten nicht erkannt'}
                          {p.ocrPages > 0 && ' · Texterkennung'}{' '}
                          <button className="link small" onClick={() => setMapPart(p)}>Spalten zuordnen …</button>
                        </span>
                        {multiSheet && (
                          <select className="part-role" aria-label={`Verwendung ${p.sheet}`} value={roles[p.id] ?? 'auto'} onChange={e => setRole(p.id, e.target.value as PartRole)}>
                            <option value="auto">automatisch</option>
                            <option value="bilanz">Bilanz</option>
                            <option value="erfolg">Erfolgsrechnung</option>
                            <option value="beide">Bilanz und Erfolgsrechnung</option>
                            <option value="aus">nicht verwenden</option>
                          </select>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {preview.validation && (
                <div className={preview.validation.ok ? 'ok-box' : 'warn-box'}>
                  {preview.validation.accountCount} Konten erkannt{preview.excluded?.length ? ` · ${preview.excluded.length} Zeilen ausgeblendet` : ''} ·{' '}
                  {preview.validation.checks.map(c => `${c.passed ? '✓' : '✗'} ${c.name.replace('Aktuelles Jahr: ', '')}`).join(' · ')}
                </div>
              )}
              {preview.accounts.length > 0 && <button className="link small" onClick={() => setShowAccounts(true)}>Konten anzeigen (gegliedert nach KMU-Kontenrahmen) …</button>}
              {preview.validation?.issues.filter(i => i.severity === 'error').slice(0, 3).map((i, n) => <p key={n} className="error-text small">{i.source ? `${i.source}, ` : ''}Zeile {i.rowIndex}: {i.message}</p>)}
              {preview.validation && !preview.validation.checks.every(c => c.passed) && <p className="small muted">Tipp: Sind Bilanz <em>und</em> Erfolgsrechnung dabei? Vorzeichen-Einstellung prüfen. Die Prüfung kann trotzdem gestartet werden.</p>}
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
                    <span className="grow path-text" title={e.path}><strong>{e.name}</strong> <span className="muted">{e.path.slice(0, Math.max(0, e.path.length - e.name.length - 1))}</span></span>
                    <button className="icon-btn" aria-label="entfernen" onClick={() => setEvidence(ev => ev.filter(x => x.path !== e.path))}>✕</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="cloud" style={{ marginTop: 10 }}>
            <span className="small muted">Aus der Cloud: </span>
            {cloud === null ? null : cloud.length ? (
              cloud.map(c => (
                <button key={c.path} className="chip" title={c.path} onClick={async () => addEvidence(await bsb().pick.evidence('folders', c.path))}>
                  {c.kind === 'sharepoint' ? '☁ ' : '☁ '}{c.label}
                </button>
              ))
            ) : (
              <span className="small warn">keine synchronisierten OneDrive-/SharePoint-Ordner gefunden.</span>
            )}{' '}
            <button className="link small" onClick={() => setCloudHelp(true)}>Cloud-Ordner einrichten …</button>
          </div>
        </div>
      </div>

      <div className="card">
        <p className="step"><span className="num">4</span><strong>Kontoblätter und Fremdwährung</strong> <span className="muted small">(optional)</span></p>
        <div className="grid2">
          <div>
            <div className="small muted">Kontoblätter (PDF oder Excel, auch mehrere hundert Seiten) – für Fremdwährungskonten und weitere Analysen. Sie gelten nicht als Nachweis.</div>
            {ledgers.length > 0 && (
              <ul className="paths">
                {ledgers.map(l => (
                  <li key={l.path}><span>📒</span><span className="grow" title={l.path}>{l.name}</span>
                    <button className="icon-btn" aria-label="entfernen" onClick={() => setLedgers(x => x.filter(y => y.path !== l.path))}>✕</button></li>
                ))}
              </ul>
            )}
            <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={async () => { const f = await bsb().pick.evidence('files'); setLedgers(x => [...x, ...f.filter(n => !n.isDirectory && /\.(pdf|xlsx|xls|csv)$/i.test(n.name) && !x.some(y => y.path === n.path))]); }}>Kontoblätter wählen …</button>
          </div>
          <div>
            <div className="small muted">Kurse per Bilanzstichtag (CHF je Einheit)</div>
            <div className="row" style={{ marginTop: 4 }}>
              {manualRates ? (
                <span className="ok-text small">✓ manuell erfasst: {Object.entries(manualRates).map(([k, v]) => `${k} ${v}`).join(' · ') || '–'}</span>
              ) : rateList ? (
                <span className="ok-text small" title={rateList.source}>✓ ESTV-Kursliste per {closing.split('-').reverse().join('.')} ({Object.keys(rateList.rates).length} Währungen, z. B. EUR {rateList.rates.EUR ?? '–'} · USD {rateList.rates.USD ?? '–'})</span>
              ) : (
                <span className="warn small">Keine Kursliste per {closing.split('-').reverse().join('.')} geladen.</span>
              )}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn btn-sm" onClick={async () => { try { const l = await bsb().review.importRates(); if (l) { setSettings(st => (st ? { ...st, fxRateLists: l } : st)); toast('ok', 'Kursliste gespeichert – gilt für alle Prüfungen mit diesem Stichtag.'); } } catch (e) { toast('error', (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); } }}>ESTV-Kursliste laden …</button>
              <button className="link small" onClick={() => setShowRates(true)}>Kurse manuell erfassen …</button>
              {manualRates && <button className="link small" onClick={() => setManualRates(null)}>manuelle Kurse entfernen</button>}
            </div>
          </div>
        </div>
      </div>

      {showRates && <RatesDialog initial={manualRates ?? rateList?.rates ?? {}} onClose={() => setShowRates(false)} onApply={r => { setManualRates(r); setShowRates(false); }} />}

      <div className="card">
        <p className="step"><span className="num">5</span><strong>Ablage und Dokumentation</strong></p>
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
            : <>Nach der Durchsicht entstehen beim <strong>Abschliessen</strong> im Zielordner <code>01_Zugeordnet</code> (Dateinamen mit Register, z. B. <code>B.1_…</code>), <code>02_Nicht_zugeordnet</code>, <code>03_Nicht_relevant</code> und die Excel-Dokumentation. Vorhandene Dateien werden nie überschrieben.</>}
          {mode === 'move' && <strong className="warn"> Achtung: Die Dateien werden aus dem Kundenordner entfernt.</strong>}
        </p>
      </div>

      <div className="row-end">
        {problems.length > 0 && <span className="muted small">{problems.join(' · ')}</span>}
        <button className="btn btn-primary btn-lg" disabled={problems.length > 0} onClick={start}>Prüfung starten</button>
      </div>

      {cloudHelp && (
        <Modal title="Cloud-Dateien in Balance Scout verwenden" onClose={() => setCloudHelp(false)} footer={<button className="btn btn-primary" onClick={async () => { setCloudHelp(false); setCloud(await bsb().pick.cloudLocations()); }}>Fertig – erneut suchen</button>}>
          <p>Balance Scout liest Ordner, die Windows im Explorer anzeigt. Dateien aus <strong>SharePoint/Teams</strong> und <strong>OneDrive</strong> erscheinen dort, sobald sie mit der OneDrive-App synchronisiert sind – das kann jeder Benutzer selbst einrichten, ohne Administratorrechte:</p>
          <ol>
            <li>Im Browser die SharePoint-Bibliothek bzw. den Teams-Kanal (Reiter <em>Dateien</em>) mit den Kundenunterlagen öffnen.</li>
            <li>Oben auf <strong>Synchronisieren</strong> klicken (oder bei einem Ordner <strong>Verknüpfung zu „Meine Dateien“ hinzufügen</strong>).</li>
            <li>Die Anfrage „OneDrive öffnen“ bestätigen. Die Bibliothek erscheint im Explorer unter dem Namen der Firma bzw. unter OneDrive.</li>
          </ol>
          <p className="small muted">Dateien, die nur online liegen („Dateien bei Bedarf“), lädt Windows beim Prüfen automatisch herunter. Ohne Internetverbindung meldet Balance Scout solche Dateien im Belegverzeichnis.</p>
        </Modal>
      )}
      {mapPart && (
        <MappingDialog
          part={mapPart}
          current={mappings[mapPart.id] ?? mapPart.used ?? null}
          onClose={() => setMapPart(null)}
          onApply={m => { setMappings(cur => ({ ...cur, [mapPart.id]: m })); setMapPart(null); }}
        />
      )}
      {showAccounts && preview && (
        <Modal title={`Konten (${preview.accounts.length})`} wide onClose={() => setShowAccounts(false)} footer={<button className="btn btn-primary" onClick={() => setShowAccounts(false)}>Schliessen</button>}>
          <div className="table-wrap" style={{ maxHeight: 460 }}>
            <table className="grid small">
              <thead><tr><th>Konto</th><th>Bezeichnung</th><th className="num">Saldo</th><th className="num">Vorjahr</th><th>Herkunft</th></tr></thead>
              <tbody>
                {groupAccounts(preview.accounts.map(a => ({ ...a, groupName: a.groupName ?? null })), groups?.groups.map(g => g.code) ?? []).map(g => (
                  <Fragment key={g.code}>
                    <tr className="group-row"><td colSpan={2}>{g.name}</td><td className="num mono">{chf(g.total)}</td><td /><td className="muted">{g.items.length} Konten</td></tr>
                    {g.items.map(a => (
                      <tr key={`${a.source}-${a.accountNumber}`}>
                        <td className="mono">{a.accountNumber}</td>
                        <td>{a.accountName}{a.groupSource === 'bezeichnung' && <span className="flag" title="Gruppe aus der Bezeichnung abgeleitet">Gruppe?</span>}</td>
                        <td className="num mono">{chf(a.balance)}</td>
                        <td className="num mono muted">{a.balancePreviousYear == null ? '' : chf(a.balancePreviousYear)}</td>
                        <td className="muted">{a.source ?? ''}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {preview.excluded?.length ? (
            <details style={{ marginTop: 10 }}><summary className="small">Ausgeblendete Zeilen (Gruppen, Zwischensummen): {preview.excluded.length}</summary><ExcludedTable rows={preview.excluded} /></details>
          ) : null}
        </Modal>
      )}
    </div>
  );
}

function MappingDialog({ part, current, onClose, onApply }: { part: TbPart; current: TbPreview['detected']; onClose: () => void; onApply: (m: NonNullable<TbPreview['detected']>) => void }) {
  const head = part.head ?? [];
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
  const valid = m.accountNumber !== undefined && m.accountName !== undefined && (m.balanceCurrentYear !== undefined || (m.balanceDebit !== undefined && m.balanceCredit !== undefined));
  return (
    <Modal title={`Spalten zuordnen – ${part.label}`} wide onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn btn-primary" disabled={!valid} onClick={() => onApply({ headerRowIndex: hdr, mapping: m as ColumnMapping })}>Übernehmen</button>
    </>}>
      {!part.detected && <p className="warn-box small">Die Spalten wurden nicht automatisch erkannt. Bitte Kopfzeile anklicken und Spalten wählen.</p>}
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
        {sel('balanceCurrentYear', 'Saldo Stichtag', true)}
        {sel('balancePreviousYear', 'Saldo Vorjahr', true)}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="small muted">Ohne Saldo-Spalte:</span>
        {sel('balanceDebit', 'Soll', true)}
        {sel('balanceCredit', 'Haben', true)}
        <span className="small muted">→ Saldo = Soll − Haben</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="small muted">Vorjahr ohne Saldo-Spalte:</span>
        {sel('balancePrevDebit', 'Soll VJ', true)}
        {sel('balancePrevCredit', 'Haben VJ', true)}
      </div>
    </Modal>
  );
}

/** Kurse manuell erfassen (unterjährige Abschlüsse oder Abweichungen) */
function RatesDialog({ initial, onClose, onApply }: { initial: Record<string, number>; onClose: () => void; onApply: (r: Record<string, number>) => void }) {
  const common = ['EUR', 'USD', 'GBP', 'JPY', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CNY'];
  const [rows, setRows] = useState<[string, string][]>(() => {
    const keys = [...new Set([...Object.keys(initial).filter(k => common.includes(k) || initial[k]), 'EUR', 'USD'])].slice(0, 30);
    return keys.filter(k => common.includes(k)).map(k => [k, initial[k] !== undefined ? String(initial[k]) : '']);
  });
  return (
    <Modal title="Kurse per Bilanzstichtag erfassen" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn btn-primary" onClick={() => onApply(Object.fromEntries(rows.filter(([c, v]) => c && Number(v.replace(',', '.')) > 0).map(([c, v]) => [c.toUpperCase(), Number(v.replace(',', '.'))])))}>Übernehmen</button>
    </>}>
      <p className="small muted">CHF für 1 Einheit (bei JPY also z. B. 0.005054 für 1 Yen). Nur für diese Prüfung.</p>
      {rows.map(([c, v], i) => (
        <div key={i} className="row" style={{ marginBottom: 4 }}>
          <input className="w-xs mono" maxLength={3} value={c} onChange={e => setRows(r => r.map((x, j) => (j === i ? [e.target.value.toUpperCase(), x[1]] : x)))} aria-label="Währung" />
          <input className="w-sm" inputMode="decimal" value={v} placeholder="z. B. 0.9305" onChange={e => setRows(r => r.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} aria-label={`Kurs ${c}`} />
          <button className="icon-btn" aria-label="entfernen" onClick={() => setRows(r => r.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="link small" onClick={() => setRows(r => [...r, ['', '']])}>+ Währung</button>
    </Modal>
  );
}
