import { useEffect, useState } from 'react';
import { bsb, call } from '../bridge';
import type { AiPolicy, Engagement, Me, ProviderInfo, Task } from '../types';
import { Spinner, useToast } from '../components/ui';

interface ProvidersResp { providers: ProviderInfo[]; problems: { provider: string; message: string }[]; routing: Record<Task, string | null> }

const POLICY_TEXT: Record<AiPolicy, string> = {
  disabled: 'Keine KI für dieses Mandat',
  local_only: 'Nur lokale KI (Ollama im Kanzleinetz)',
  tenant: 'Lokal und im eigenen Microsoft-Tenant (Microsoft 365 Copilot, Azure AI Foundry Schweiz)',
};

export function SettingsTab({ engagement, me, onChanged }: { engagement: Engagement; me: Me; onChanged: () => void }) {
  const toast = useToast();
  const [prov, setProv] = useState<ProvidersResp | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; detail: string } | 'busy'>>({});
  const [version, setVersion] = useState('');
  const policy = engagement.settings?.aiPolicy ?? 'disabled';

  useEffect(() => {
    void call<ProvidersResp>('GET', '/api/ai/providers').then(setProv).catch(e => toast('error', (e as Error).message));
    void bsb().app.version().then(setVersion);
  }, [toast]);

  const setPolicy = async (p: AiPolicy) => {
    try {
      await call('PUT', `/api/engagements/${engagement.id}/ai-policy`, { aiPolicy: p });
      toast('ok', 'KI-Richtlinie gespeichert.');
      onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  const setRouting = async (task: Task, provider: string) => {
    try {
      const routing = await call<ProvidersResp['routing']>('PUT', '/api/ai/routing', { task, provider });
      setProv(p => (p ? { ...p, routing } : p));
      toast('ok', 'Zuordnung gespeichert.');
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  const test = async (id: string) => {
    setTests(t => ({ ...t, [id]: 'busy' }));
    try {
      const r = await call<{ ok: boolean; detail: string }>('POST', `/api/ai/providers/${id}/test`, {});
      setTests(t => ({ ...t, [id]: r }));
    } catch (e) {
      setTests(t => ({ ...t, [id]: { ok: false, detail: (e as Error).message } }));
    }
  };

  return (
    <div className="stack">
      <div className="card">
        <h3>KI-Richtlinie dieses Mandats</h3>
        <p className="muted small">Schützt das Revisionsgeheimnis: legt fest, wohin Belegdaten für KI-Funktionen übermittelt werden dürfen.{!me.isAdmin && ' Änderungen nur durch Administratoren.'}</p>
        {(['disabled', 'local_only', 'tenant'] as AiPolicy[]).map(p => (
          <label key={p} className="radio">
            <input type="radio" name="policy" checked={policy === p} disabled={!me.isAdmin} onChange={() => setPolicy(p)} />
            {POLICY_TEXT[p]}
          </label>
        ))}
      </div>

      <div className="card">
        <h3>KI-Anbieter</h3>
        {!prov ? <Spinner /> : (
          <>
            <table className="grid">
              <thead><tr><th>Anbieter</th><th>Ziel</th><th>Datengrenze</th><th>Scans</th><th>Verbindung</th></tr></thead>
              <tbody>
                {prov.providers.map(p => {
                  const t = tests[p.id];
                  return (
                    <tr key={p.id}>
                      <td>{p.displayName}{p.capabilities.requiresUserToken && <div className="muted small">im Namen des Benutzers</div>}</td>
                      <td className="mono small">{p.destination}</td>
                      <td>{p.boundary === 'local' ? 'Kanzleinetz' : p.boundary === 'tenant' ? 'Eigener Tenant' : 'Extern'}</td>
                      <td>{p.capabilities.vision ? '✓' : p.capabilities.sharePointFiles ? 'über SharePoint' : '–'}</td>
                      <td>
                        {t === 'busy' ? <Spinner /> : t ? <span className={t.ok ? 'ok-text' : 'error-text'}>{t.detail}</span> : null}
                        {t !== 'busy' && <button className="btn btn-sm" onClick={() => test(p.id)}>Testen</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {prov.problems.map(p => <p key={p.provider} className="warn small">⚠ {p.provider}: {p.message}</p>)}
            <h4>Zuordnung der Aufgaben</h4>
            {(['evidence_extraction', 'match_review'] as Task[]).map(task => (
              <label key={task} className="field inline">
                <span>{task === 'evidence_extraction' ? 'Belegauswertung / Texterkennung' : 'Beurteilung von Treffern'}</span>
                <select value={prov.routing[task] ?? ''} disabled={!me.isAdmin} onChange={e => setRouting(task, e.target.value)}>
                  {prov.providers.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                </select>
              </label>
            ))}
          </>
        )}
      </div>
      <p className="muted small">Balance Scout {version}</p>
    </div>
  );
}
