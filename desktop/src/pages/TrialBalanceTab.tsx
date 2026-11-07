import { useEffect, useState } from 'react';
import { bsb, call } from '../bridge';
import type { PickedFile } from '../../electron/shared';
import type { Engagement, TrialBalance, Validation } from '../types';
import { chf, dateTime } from '../format';
import { Spinner, useToast } from '../components/ui';

export function TrialBalanceTab({ engagement, onImported }: { engagement: Engagement; onImported: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<PickedFile | null>(null);
  const [sign, setSign] = useState<'signed' | 'unsigned'>('signed');
  const [preview, setPreview] = useState<{ validation: Validation; accounts: TrialBalance['accounts'] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const current = engagement.trialBalances?.[0];

  useEffect(() => {
    if (current) void call<TrialBalance>('GET', `/api/trial-balances/${current.id}`).then(setTb).catch(() => setTb(null));
  }, [current?.id]);

  const pick = async () => {
    const f = await bsb().api.pickFiles({ multiple: false, filters: [{ name: 'Saldobilanz', extensions: ['xlsx', 'xlsm', 'csv'] }] });
    if (!f[0]) return;
    setFile(f[0]);
    setPreview(null);
    setBusy('Vorschau …');
    const r = await bsb().api.upload<{ validation: Validation; accounts: TrialBalance['accounts'] }>(`/api/engagements/${engagement.id}/trial-balances`, f, { dryRun: 'true', signConvention: sign }, 'file');
    setBusy(null);
    if (!r.ok) return toast('error', r.error ?? 'Fehler');
    setPreview(r.data!);
  };

  const importNow = async () => {
    if (!file) return;
    setBusy('Import …');
    const r = await bsb().api.upload(`/api/engagements/${engagement.id}/trial-balances`, [file], { signConvention: sign }, 'file');
    setBusy(null);
    if (!r.ok) return toast('error', r.error ?? 'Fehler');
    toast('ok', 'Saldobilanz importiert.');
    setFile(null);
    setPreview(null);
    onImported();
  };

  const v = preview?.validation ?? tb?.validation;
  return (
    <div className="stack">
      <div className="card">
        <h3>Saldobilanz importieren</h3>
        <div className="row">
          <label className="field inline">
            <span>Vorzeichen</span>
            <select value={sign} onChange={e => setSign(e.target.value as 'signed' | 'unsigned')}>
              <option value="signed">Soll positiv / Haben negativ</option>
              <option value="unsigned">Alle Salden positiv</option>
            </select>
          </label>
          <button className="btn" onClick={pick} disabled={!!busy}>Datei wählen (Excel/CSV) …</button>
          {file && <span className="muted">{file.name}</span>}
          {busy && <Spinner label={busy} />}
          {preview && <button className="btn btn-primary" onClick={importNow} disabled={!!busy}>Importieren</button>}
        </div>
        {preview && <p className="muted small">Vorschau – noch nicht gespeichert.</p>}
      </div>

      {!preview && current && <p className="muted">Aktuell: {current.filename} · importiert {dateTime(current.created_at)} von {current.created_by}</p>}

      {v && (
        <div className="card">
          <h3>Prüfung der Saldobilanz {v.ok ? <span className="badge badge-belegt">in Ordnung</span> : <span className="badge badge-kein_nachweis">Fehler</span>}</h3>
          <ul className="checks">
            {v.checks.map(c => (
              <li key={c.name} className={c.passed ? 'ok' : 'fail'}>
                <strong>{c.passed ? '✓' : '✗'} {c.name}</strong> – {c.message}
              </li>
            ))}
          </ul>
          {v.issues.length > 0 && (
            <details open={v.issues.some(i => i.severity === 'error')}>
              <summary>{v.issues.length} Hinweise ({v.issues.filter(i => i.severity === 'error').length} Fehler)</summary>
              <ul className="issues">
                {v.issues.map((i, n) => (
                  <li key={n} className={i.severity}>Zeile {i.rowIndex}: {i.message}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {(preview?.accounts ?? tb?.accounts) && (
        <table className="grid">
          <thead>
            <tr><th>Konto</th><th>Bezeichnung</th><th>Gruppe</th><th className="num">Saldo</th><th className="num">Vorjahr</th></tr>
          </thead>
          <tbody>
            {(preview?.accounts ?? tb!.accounts).map(a => (
              <tr key={a.accountNumber + a.rowIndex}>
                <td className="mono">{a.accountNumber}</td>
                <td>{a.accountName}</td>
                <td className="muted">{a.groupName ?? '–'}</td>
                <td className="num mono">{chf(a.balanceCurrentYear)}</td>
                <td className="num mono muted">{chf(a.balancePreviousYear)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
