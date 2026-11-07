import { useState } from 'react';
import { bsb } from '../bridge';
import type { AuthStatus } from '../../electron/shared';
import { Spinner } from '../components/ui';

export function Login({ status, onSignedIn, onSettings }: { status: AuthStatus; onSignedIn: (s: AuthStatus) => void; onSettings: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(status.error ?? null);
  const signIn = async () => {
    setBusy(true);
    setErr(null);
    const st = await bsb().auth.signIn();
    setBusy(false);
    if (st.signedIn) onSignedIn(st);
    else setErr(st.error ?? 'Anmeldung nicht abgeschlossen.');
  };
  return (
    <div className="center-screen">
      <div className="card login">
        <div className="logo">BS</div>
        <h1>Balance Scout</h1>
        <p className="muted">Saldennachweis-Prüfung</p>
        <button className="btn btn-primary btn-lg" onClick={signIn} disabled={busy}>
          {busy ? <Spinner label="Anmeldung läuft …" /> : 'Mit Microsoft 365 anmelden'}
        </button>
        {status.broker && <p className="muted small">Anmeldung über Ihr Windows-Konto (Single Sign-on).</p>}
        {err && <p className="error-text">{err}</p>}
        <button className="link" onClick={onSettings}>Verbindungseinstellungen</button>
      </div>
    </div>
  );
}
