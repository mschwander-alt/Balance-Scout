import { useEffect, useState } from 'react';
import { bsb } from './bridge';
import type { AuditResult } from './types';
import type { HistoryEntry, JobInput } from '../electron/shared';
import { ToastProvider } from './components/ui';
import { Start } from './pages/Start';
import { NewAudit } from './pages/NewAudit';
import { Running } from './pages/Running';
import { Result } from './pages/Result';

type View = { k: 'start' } | { k: 'new'; prefill?: Partial<JobInput> } | { k: 'running'; input: JobInput } | { k: 'result'; result: AuditResult; input?: JobInput };

export function App() {
  const [view, setView] = useState<View>({ k: 'start' });
  const [version, setVersion] = useState('');
  useEffect(() => void bsb().app.version().then(setVersion), []);

  const openHistory = async (h: HistoryEntry) => {
    const r = (await bsb().app.loadResult(h.id)) as AuditResult | null;
    if (r) setView({ k: 'result', result: { ...r, historyId: h.id }, input: r.input });
    else void bsb().app.openPath(h.excelPath);
  };

  return (
    <ToastProvider>
      <div className="topbar">
        <span className="brand"><span className="logo sm">BS</span> <span className="brand-name">Balance Scout</span></span>
        <span className="muted small">lokal · ohne Cloud {version && `· ${version}`}</span>
        <span className="spacer" />
        {view.k !== 'running' && view.k !== 'start' && <button className="btn btn-sm" onClick={() => setView({ k: 'start' })}>Übersicht</button>}
        {view.k !== 'running' && view.k !== 'new' && <button className="btn btn-primary btn-sm" onClick={() => setView({ k: 'new' })}>+ Neue Prüfung</button>}
      </div>
      {view.k === 'start' && <Start onNew={() => setView({ k: 'new' })} onOpen={openHistory} />}
      {view.k === 'new' && <NewAudit prefill={view.prefill} onStart={input => setView({ k: 'running', input })} />}
      {view.k === 'running' && (
        <Running
          input={view.input}
          onDone={result => setView({ k: 'result', result, input: view.input })}
          onCancel={() => setView({ k: 'new', prefill: view.input })}
        />
      )}
      {view.k === 'result' && <Result key={view.result.historyId} result={view.result} onRepeat={view.input ? () => setView({ k: 'new', prefill: view.input }) : undefined} />}
    </ToastProvider>
  );
}
