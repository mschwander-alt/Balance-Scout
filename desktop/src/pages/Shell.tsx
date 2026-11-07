import { useCallback, useEffect, useState } from 'react';
import { bsb, call } from '../bridge';
import type { ServerEvent } from '../../electron/shared';
import type { Engagement, Me } from '../types';
import { date, shortUser } from '../format';
import { Modal, Spinner, useToast } from '../components/ui';
import { EngagementView } from './EngagementView';

export function Shell({ account, onSignedOut }: { account: { name: string; username: string }; onSignedOut: () => void }) {
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [list, setList] = useState<Engagement[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [conn, setConn] = useState<'connected' | 'reconnecting' | 'offline' | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const [m, l] = await Promise.all([call<Me>('GET', '/api/me'), call<Engagement[]>('GET', '/api/engagements')]);
      setMe(m);
      setList(l);
    } catch (e) {
      toast('error', (e as Error).message);
      setList([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    const off1 = bsb().app.onNavigate(id => setSelected(id));
    const off2 = bsb().events.onConnection(setConn);
    return () => {
      off1();
      off2();
    };
  }, [load]);

  useEffect(() => {
    void bsb().events.watch(selected);
    if (selected && list) {
      const recent = [list.find(e => e.id === selected)!, ...list.filter(e => e.id !== selected)].filter(Boolean).slice(0, 5);
      void bsb().app.setRecent(recent.map(e => ({ id: e.id, name: e.name })));
    }
  }, [selected, list]);

  const signOut = async () => {
    await bsb().auth.signOut();
    onSignedOut();
  };

  const shown = (list ?? []).filter(e => `${e.name} ${e.client_name ?? ''}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo sm">BS</span> Balance Scout
        </div>
        <div className="sidebar-actions">
          <input className="search" placeholder="Mandat suchen …" value={filter} onChange={e => setFilter(e.target.value)} />
          <button className="btn btn-primary btn-block" onClick={() => setCreating(true)}>+ Neues Mandat</button>
        </div>
        <nav className="engagements">
          {list === null && <Spinner label="Lade Mandate …" />}
          {list?.length === 0 && <p className="muted small pad">Noch keine Mandate.</p>}
          {shown.map(e => (
            <button key={e.id} className={`eng-item ${selected === e.id ? 'active' : ''}`} onClick={() => setSelected(e.id)}>
              <strong>{e.name}</strong>
              <span className="muted small">{e.client_name ?? '–'} · Stichtag {date(e.closing_date)}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user">
            <strong>{account.name}</strong>
            <span className="muted small">{account.username}{me?.isAdmin ? ' · Administrator' : ''}</span>
          </div>
          {conn && conn !== 'connected' && selected && <span className="conn-warn">{conn === 'reconnecting' ? 'Verbindung wird wiederhergestellt …' : 'Offline'}</span>}
          <button className="link" onClick={signOut}>Abmelden</button>
        </div>
      </aside>
      <main className="main">
        {selected && me ? (
          <EngagementView key={selected} engagementId={selected} me={me} />
        ) : (
          <div className="empty-state">
            <h2>Willkommen, {shortUser(account.name)}</h2>
            <p className="muted">Wählen Sie links ein Mandat oder legen Sie ein neues an.</p>
          </div>
        )}
      </main>
      {creating && <CreateEngagement onClose={() => setCreating(false)} onCreated={async id => { setCreating(false); await load(); setSelected(id); }} />}
    </div>
  );
}

function CreateEngagement({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [closing, setClosing] = useState(`${new Date().getFullYear() - 1}-12-31`);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await call<{ id: string }>('POST', '/api/engagements', { name, clientName: client || undefined, closingDate: closing || undefined });
      toast('ok', 'Mandat angelegt.');
      onCreated(r.id);
    } catch (e) {
      toast('error', (e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Neues Mandat" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={submit}>Anlegen</button>
    </>}>
      <label className="field"><span>Bezeichnung</span><input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Jahresabschluss 2025" /></label>
      <label className="field"><span>Kunde</span><input value={client} onChange={e => setClient(e.target.value)} placeholder="Muster AG" /></label>
      <label className="field"><span>Bilanzstichtag</span><input type="date" value={closing} onChange={e => setClosing(e.target.value)} /></label>
    </Modal>
  );
}

export type { ServerEvent };
