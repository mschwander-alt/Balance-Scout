import { useEffect, useRef, useState } from 'react';
import { bsb } from '../bridge';
import type { JobInput, Progress } from '../../electron/shared';
import type { AuditResult } from '../types';
import { useToast } from '../components/ui';

const PHASES: Record<string, string> = {
  saldobilanz: 'Saldobilanz lesen', suchen: 'Unterlagen suchen', lesen: 'Belege lesen', abgleich: 'Salden abgleichen', ablage: 'Belege ablegen', bericht: 'Excel erstellen', fertig: 'Fertig',
};

export function Running({ input, onDone, onCancel }: { input: JobInput; onDone: (r: AuditResult) => void; onCancel: () => void }) {
  const toast = useToast();
  const [p, setP] = useState<Progress>({ phase: 'saldobilanz', message: 'Start …' });
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const t0 = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const off = bsb().engine.onProgress(pr => {
      setP(pr);
      if (pr.message.startsWith('Texterkennung')) setLog(l => [pr.message, ...l].slice(0, 6));
    });
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - t0.current) / 1000)), 1000);
    if (!started.current) {
      started.current = true;
      bsb().engine.run(input).then(r => onDone(r as AuditResult), e => setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
    }
    return () => {
      off();
      clearInterval(timer);
    };
  }, [input, onDone]);

  const frac = p.total ? (p.current ?? 0) / p.total : null;
  return (
    <div className="page">
      <div className="card" style={{ maxWidth: 760, margin: '40px auto' }}>
        <h2>{input.mandate}</h2>
        {error ? (
          <>
            <p className="err-box">Die Prüfung konnte nicht abgeschlossen werden: {error}</p>
            <button className="btn" onClick={onCancel}>Zurück zu den Eingaben</button>
          </>
        ) : (
          <>
            <p className="muted">{PHASES[p.phase] ?? p.phase}{p.total ? ` – Datei ${p.current} von ${p.total}` : ''} · {elapsed} s</p>
            <div className={`progress ${frac === null ? 'indet' : ''}`}><div style={{ width: `${Math.round((frac ?? 0) * 100)}%` }} /></div>
            <p className="small" style={{ marginTop: 10, minHeight: 20, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.message}</p>
            {log.length > 0 && <ul className="small muted">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
            <p className="small muted">Scans werden auf diesem PC per Texterkennung gelesen (ca. 1–4 Sekunden pro Seite). Sie können das Fenster schliessen – Balance Scout meldet sich, wenn die Prüfung fertig ist.</p>
            <button className="btn btn-sm" onClick={async () => { await bsb().engine.cancel(); toast('info', 'Prüfung abgebrochen.'); onCancel(); }}>Abbrechen</button>
          </>
        )}
      </div>
    </div>
  );
}
