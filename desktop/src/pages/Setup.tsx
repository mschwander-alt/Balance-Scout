import { useState } from 'react';
import { bsb } from '../bridge';
import type { AppSettings, AuthStatus, ManagedKeys } from '../../electron/shared';
import { Spinner } from '../components/ui';

export function Setup({ initial, managed, onDone }: { initial: AppSettings; managed: ManagedKeys; onDone: () => void }) {
  const [s, setS] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (k: 'serverUrl' | 'tenantId' | 'clientId' | 'apiScope', label: string, hint: string, ph: string) => (
    <label className="field">
      <span>{label}{managed[k] && <em className="managed"> · von der IT vorgegeben</em>}</span>
      <input value={s[k]} placeholder={ph} disabled={!!managed[k]} onChange={e => setS({ ...s, [k]: e.target.value.trim() })} />
      <small>{hint}</small>
    </label>
  );
  const save = async () => {
    setBusy(true);
    const r = await bsb().settings.set(s);
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? 'Ungültige Eingabe');
    onDone();
  };
  return (
    <div className="center-screen">
      <div className="card setup">
        <h1>Balance Scout einrichten</h1>
        <p className="muted">Diese Angaben erhalten Sie von Ihrer IT. Sie können auch zentral über eine Richtliniendatei verteilt werden.</p>
        {field('serverUrl', 'Serveradresse', 'Adresse des Balance-Scout-Servers in Azure Schweiz.', 'https://balance-scout.kanzlei.ch')}
        {field('tenantId', 'Tenant-ID', 'Microsoft-Entra-Tenant der Kanzlei.', '00000000-0000-0000-0000-000000000000')}
        {field('clientId', 'Client-ID der App', 'App-Registrierung „Balance Scout Desktop“.', '00000000-0000-0000-0000-000000000000')}
        {field('apiScope', 'API-Scope', 'Berechtigung für den Server.', 'api://balance-scout/access_as_user')}
        <label className="field">
          <span>Benachrichtigungen</span>
          <select value={s.notifications} disabled={!!managed.notifications} onChange={e => setS({ ...s, notifications: e.target.value as AppSettings['notifications'] })}>
            <option value="andere">Nur Änderungen von Kolleginnen und Kollegen</option>
            <option value="alle">Alle Ereignisse</option>
            <option value="keine">Keine</option>
          </select>
        </label>
        {err && <p className="error-text">{err}</p>}
        <div className="row-end">
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? <Spinner /> : 'Speichern'}</button>
        </div>
      </div>
    </div>
  );
}
