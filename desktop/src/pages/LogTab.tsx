import { useEffect, useState } from 'react';
import { call } from '../bridge';
import { dateTime, shortUser } from '../format';
import { Spinner, useToast } from '../components/ui';

interface LogEntry { id: number; at: string; actor: string; action: string; entity: string; entity_id: string | null; details: Record<string, unknown> }
interface AiCall { id: number; at: string; actor: string; task: string; provider: string; model: string | null; destination: string; boundary: string; chars_sent: number; images_sent: number; duration_ms: number; status: string; error: string | null }

const ACTION: Record<string, string> = {
  'engagement.create': 'Mandat angelegt',
  'trial_balance.import': 'Saldobilanz importiert',
  'evidence.upload': 'Beleg hochgeladen',
  'evidence.sharepoint': 'Beleg in SharePoint abgelegt',
  'matching.run': 'Abgleich ausgeführt',
  'account.review': 'Prüfvermerk',
  'ai.extract': 'KI-Belegauswertung',
  'ai.review': 'KI-Beurteilung',
  'engagement.ai_policy': 'KI-Richtlinie geändert',
};

export function LogTab({ engagementId }: { engagementId: string }) {
  const toast = useToast();
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [ai, setAi] = useState<AiCall[]>([]);
  const [view, setView] = useState<'audit' | 'ai'>('audit');
  useEffect(() => {
    Promise.all([call<LogEntry[]>('GET', `/api/engagements/${engagementId}/audit-log`), call<AiCall[]>('GET', `/api/engagements/${engagementId}/ai-calls`)])
      .then(([l, a]) => {
        setLog(l.reverse());
        setAi(a.reverse());
      })
      .catch(e => toast('error', (e as Error).message));
  }, [engagementId, toast]);
  if (!log) return <Spinner />;
  return (
    <div className="stack">
      <div className="row">
        <button className={`chip ${view === 'audit' ? 'active' : ''}`} onClick={() => setView('audit')}>Prüfprotokoll ({log.length})</button>
        <button className={`chip ${view === 'ai' ? 'active' : ''}`} onClick={() => setView('ai')}>KI-Nutzung ({ai.length})</button>
        <span className="muted small">Das Protokoll ist unveränderlich.</span>
      </div>
      {view === 'audit' ? (
        <table className="grid">
          <thead><tr><th>Zeit</th><th>Benutzer</th><th>Aktion</th><th>Details</th></tr></thead>
          <tbody>
            {log.map(l => (
              <tr key={l.id}>
                <td className="small">{dateTime(l.at)}</td>
                <td>{shortUser(l.actor)}</td>
                <td>{ACTION[l.action] ?? l.action}</td>
                <td className="small muted mono">{summarize(l.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="grid">
          <thead><tr><th>Zeit</th><th>Benutzer</th><th>Aufgabe</th><th>Anbieter / Ziel</th><th className="num">Zeichen</th><th className="num">Bilder</th><th className="num">Dauer</th><th>Status</th></tr></thead>
          <tbody>
            {ai.map(c => (
              <tr key={c.id}>
                <td className="small">{dateTime(c.at)}</td>
                <td>{shortUser(c.actor)}</td>
                <td>{c.task === 'evidence_extraction' ? 'Belegauswertung' : 'Beurteilung'}</td>
                <td>{c.provider}<div className="muted small mono">{c.destination} · {c.boundary}</div></td>
                <td className="num">{c.chars_sent.toLocaleString('de-CH')}</td>
                <td className="num">{c.images_sent}</td>
                <td className="num">{(c.duration_ms / 1000).toFixed(1)} s</td>
                <td title={c.error ?? ''}>{c.status === 'ok' ? '✓' : c.status === 'refused' ? 'abgelehnt' : <span className="error-text">Fehler</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function summarize(d: Record<string, unknown>): string {
  return Object.entries(d)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .slice(0, 5)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .join(' · ');
}
