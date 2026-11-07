import { useEffect, useState } from 'react';
import { bsb } from './bridge';
import type { AppSettings, AuthStatus, ManagedKeys } from '../electron/shared';
import { Spinner, ToastProvider } from './components/ui';
import { Setup } from './pages/Setup';
import { Login } from './pages/Login';
import { Shell } from './pages/Shell';

type Phase = { k: 'loading' } | { k: 'setup'; settings: AppSettings; managed: ManagedKeys } | { k: 'login'; status: AuthStatus } | { k: 'ready'; status: AuthStatus };

export function App() {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });

  const boot = async () => {
    setPhase({ k: 'loading' });
    const s = await bsb().settings.get();
    if (!s.complete) return setPhase({ k: 'setup', settings: s.settings, managed: s.managed });
    const st = await bsb().auth.status();
    setPhase(st.signedIn ? { k: 'ready', status: st } : { k: 'login', status: st });
  };

  useEffect(() => {
    void boot();
  }, []);

  return (
    <ToastProvider>
      {phase.k === 'loading' && (
        <div className="center-screen">
          <Spinner label="Balance Scout wird gestartet …" />
        </div>
      )}
      {phase.k === 'setup' && <Setup initial={phase.settings} managed={phase.managed} onDone={boot} />}
      {phase.k === 'login' && <Login status={phase.status} onSignedIn={st => setPhase({ k: 'ready', status: st })} onSettings={async () => {
        const s = await bsb().settings.get();
        setPhase({ k: 'setup', settings: s.settings, managed: s.managed });
      }} />}
      {phase.k === 'ready' && <Shell account={phase.status.account!} onSignedOut={boot} />}
    </ToastProvider>
  );
}
